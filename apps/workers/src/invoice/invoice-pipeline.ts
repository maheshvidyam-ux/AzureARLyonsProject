/**
 * AP invoice pipeline (AP_INVOICE module): Graph(mock) → Blob → Document Intelligence → AI
 * Foundry → normalize invoice → vendor match → invoice dedup → 3-way match (PO) / C&A
 * (Non-PO) → decision. Reuses the AR ingestion/blob/DI/Foundry ports; the AP-specific logic is
 * the invoice schema, vendor/PO matching, and the Code-&-Approve path. Stops before persistence
 * (invoice tables + staging_vendor_invoice are the next sub-slice).
 */
import { randomUUID } from "node:crypto";
import { invoiceBusinessKey, resolveCompanyId, toSimpleStatus, type InternalState, type SimpleStatus } from "@coa/domain";
import type { NormalizedInvoice, InvoiceType } from "@coa/invoice-schema";
import type { ValidationFinding } from "@coa/po-schema";
import type { InvoiceMasterReader } from "@coa/fabric-read";
import type { Persistence } from "@coa/persistence";
import { matchVendor, threeWayMatchLine } from "@coa/matching";
import { decodeAttachmentBytes } from "../pipeline/ingestion.js";
import type { BlobRef, BlobStore, DocumentIntelligenceClient, FoundryClient, GraphMailMessage } from "../pipeline/ports.js";
import { normalizeInvoice } from "./invoice-normalize.js";

/** Atomic invoice-dedup claim (maps to the shared filtered-unique-index claim in production). */
export interface InvoiceDedup {
  claim(businessKey: string, invoiceId: string): Promise<"CLAIMED" | "COLLISION">;
}
export class InMemoryInvoiceDedup implements InvoiceDedup {
  private readonly seen = new Map<string, string>();
  async claim(businessKey: string, invoiceId: string): Promise<"CLAIMED" | "COLLISION"> {
    const existing = this.seen.get(businessKey);
    if (existing) return existing === invoiceId ? "CLAIMED" : "COLLISION";
    this.seen.set(businessKey, invoiceId);
    return "CLAIMED";
  }
}

/** Dedup backed by the shared atomic claim (filtered unique index) in persistence. */
export class PersistenceInvoiceDedup implements InvoiceDedup {
  constructor(private readonly persistence: Persistence) {}
  async claim(businessKey: string, invoiceId: string): Promise<"CLAIMED" | "COLLISION"> {
    const companyId = businessKey.split("::")[1] ?? ""; // AP::{company}::{vendor}::{invno}
    const r = await this.persistence.claimInvoice({ companyId, businessKey, invoiceRef: invoiceId });
    return r.status === "CLAIMED" ? "CLAIMED" : "COLLISION";
  }
}

export interface InvoicePipelineDeps {
  blob: BlobStore;
  di: DocumentIntelligenceClient;
  foundry: FoundryClient;
  masters: InvoiceMasterReader;
  dedup: InvoiceDedup;
  /** When provided, the processed invoice is persisted (and staged if autoStage + READY). */
  persistence?: Persistence;
  /** Phase 5: auto-stage a clean, matched, non-duplicate invoice to staging_vendor_invoice. */
  autoStage?: boolean;
}

export type InvoiceDecision = "READY" | "NEEDS_REVIEW" | "FAILED";
export interface InvoiceResult {
  companyId: string;
  documentId: string | null;
  invoiceHeaderId: string | null;
  invoiceType: InvoiceType | null;
  decision: InvoiceDecision;
  internalState: InternalState;
  simpleStatus: SimpleStatus;
  normalized: NormalizedInvoice | null;
  findings: ValidationFinding[];
  businessKey: string | null;
  /** true until the invoice is staged; false once published to staging_vendor_invoice. */
  stagedBlocked: boolean;
  trace: string[];
}

const err = (code: string, field: string | null, message: string): ValidationFinding => ({ severity: "ERROR", code, field_path: field, message, blocking: true });
const warn = (code: string, field: string | null, message: string): ValidationFinding => ({ severity: "WARNING", code, field_path: field, message, blocking: false });

export async function processInvoice(deps: InvoicePipelineDeps, message: GraphMailMessage, attachmentIndex = 0): Promise<InvoiceResult> {
  const trace: string[] = [];
  const attachment = message.attachments[attachmentIndex];
  if (!attachment) throw new Error(`Invoice message ${message.graphMessageId} has no attachment ${attachmentIndex}`);
  const { companyId } = resolveCompanyId({ sender: message.sender, mailbox: message.mailbox });

  const blobRef: BlobRef = await deps.blob.put({ filename: attachment.filename, bytes: decodeAttachmentBytes(attachment) });
  trace.push(`INGESTED ${blobRef.filename}`);

  const finalize = (state: InternalState, decision: InvoiceDecision, normalized: NormalizedInvoice | null, findings: ValidationFinding[], documentId: string | null, invoiceType: InvoiceType | null, businessKey: string | null, invoiceHeaderId: string | null = null, staged = false): InvoiceResult => ({
    companyId, documentId, invoiceHeaderId, invoiceType, decision, internalState: state, simpleStatus: toSimpleStatus(state), normalized, findings, businessKey, stagedBlocked: !staged, trace,
  });

  let di;
  try {
    di = await deps.di.analyze({ blob: blobRef });
    trace.push(`OCR_DONE di=${di.diModelVersion}`);
  } catch (e) {
    return finalize("FAILED", "FAILED", null, [err("DI_FAILED", null, (e as Error).message)], null, null, null);
  }

  let foundry;
  try {
    foundry = await deps.foundry.interpret({ di, blob: blobRef });
  } catch (e) {
    return finalize("FAILED", "FAILED", null, [err("FOUNDRY_CALL_FAILED", null, (e as Error).message)], null, null, null);
  }

  const documentId = randomUUID();
  const norm = normalizeInvoice({ documentId, di, foundry });
  if (!norm.ok) {
    trace.push(`FAILED ${norm.reason}`);
    return finalize("FAILED", "FAILED", null, [norm.finding], documentId, null, null);
  }
  const inv = norm.invoice;
  trace.push(`NORMALIZED type=${inv.invoice_type} inv#=${inv.header.normalized_invoice_number ?? "∅"} lines=${inv.lines.length}`);

  const findings: ValidationFinding[] = [];
  if (!inv.header.invoice_number?.value) findings.push(err("REQUIRED_INVOICE_NUMBER_MISSING", "header.invoice_number", "Invoice number is required."));
  if (!inv.header.invoice_date?.value) findings.push(warn("REQUIRED_INVOICE_DATE_MISSING", "header.invoice_date", "Invoice date is missing."));

  // Vendor match.
  const vendors = await deps.masters.findVendors(companyId);
  const vm = matchVendor({ name: inv.header.vendor?.name?.value ?? null, taxId: inv.header.vendor?.tax_id?.value ?? null }, vendors);
  inv.header.vendor = { ...(inv.header.vendor ?? {}), erp_vendor_account: { value: vm.erpVendorAccount, confidence: vm.confidence }, match_status: vm.matchStatus };
  if (!vm.erpVendorAccount) findings.push(err("VENDOR_UNMATCHED", "header.vendor", `Vendor not matched (${vm.evidence}).`));
  trace.push(`VENDOR ${vm.matchStatus}(${vm.erpVendorAccount ?? "∅"})`);

  // Invoice dedup.
  const businessKey = invoiceBusinessKey({ companyId, erpVendorAccount: vm.erpVendorAccount, normalizedInvoiceNumber: inv.header.normalized_invoice_number ?? null });
  let duplicate = false;
  if (businessKey) {
    const claim = await deps.dedup.claim(businessKey, documentId);
    if (claim === "COLLISION") {
      duplicate = true;
      findings.push(err("DUPLICATE_INVOICE", null, `Duplicate invoice — ${businessKey} already seen.`));
      trace.push("DUPLICATE invoice");
    } else trace.push("CLAIMED invoice key");
  }

  // Matching: 3-way for PO_BASED; Code & Approve for NON_PO.
  if (inv.invoice_type === "PO_BASED") {
    const poNumber = inv.header.po_number?.value ?? "";
    const [poLines, receipts] = await Promise.all([deps.masters.findPoLines(companyId, poNumber), deps.masters.findReceipts(companyId, poNumber)]);
    inv.lines.forEach((line, i) => {
      const m = threeWayMatchLine({ poLineRef: line.po_line_ref?.value ?? null, erpItemId: line.erp_item_id?.value ?? null, quantity: line.quantity?.value ?? null, unitPrice: line.unit_price?.value ?? null }, poLines, receipts);
      line.match_status = m.status;
      line.erp_item_id = { value: m.erpItemId };
      if (m.status !== "PO_MATCHED") findings.push(err(`THREEWAY_${m.status}`, `lines[${i}]`, `Line ${i + 1}: ${m.detail}`));
    });
    trace.push(`3WAY ${inv.lines.map((l) => l.match_status).join(",")}`);
  } else {
    // Non-PO: the C&A line must be GL-coded + approved by a CSR.
    findings.push(err("GL_CODE_REQUIRED", "lines[0].gl_account", "Non-PO invoice — reviewer must assign a GL account and approve (Code & Approve)."));
    trace.push("NON_PO → Code & Approve (reviewer)");
  }

  inv.validation = findings;
  const blocking = findings.filter((f) => f.blocking);

  let state: InternalState;
  let decision: InvoiceDecision;
  if (duplicate) {
    state = "DUPLICATE_REVIEW";
    decision = "NEEDS_REVIEW";
  } else if (blocking.length > 0) {
    state = "NEEDS_REVIEW";
    decision = "NEEDS_REVIEW";
  } else {
    state = "READY";
    decision = "READY";
  }

  // Persist the invoice; auto-stage a clean, matched, non-duplicate one to the Boomi tables.
  let invoiceHeaderId: string | null = null;
  let staged = false;
  if (deps.persistence) {
    const saved = await deps.persistence.saveProcessedInvoice({
      sourceHash: blobRef.contentHash,
      companyId,
      invoiceType: inv.invoice_type,
      header: {
        erpVendorAccount: inv.header.vendor?.erp_vendor_account?.value ?? null,
        vendorName: inv.header.vendor?.name?.value ?? null,
        invoiceNumber: inv.header.invoice_number?.value ?? null,
        normalizedInvoiceNumber: inv.header.normalized_invoice_number ?? null,
        poNumber: inv.header.po_number?.value ?? null,
        invoiceDate: inv.header.invoice_date?.value ?? null,
        currency: inv.header.currency?.value ?? null,
        subtotal: inv.header.totals?.subtotal?.amount ?? null,
        tax: inv.header.totals?.tax?.amount ?? null,
        grandTotal: inv.header.totals?.grand_total?.amount ?? null,
        lineCount: inv.lines.length,
        simpleStatus: toSimpleStatus(state),
        internalState: state,
      },
      lines: inv.lines.map((l, i) => ({
        sourceLineNo: l.source_line_no ?? i + 1,
        poLineRef: l.po_line_ref?.value ?? null,
        erpItemId: l.erp_item_id?.value ?? null,
        glAccount: l.gl_account?.value ?? null,
        description: l.description?.value ?? null,
        quantity: l.quantity?.value ?? null,
        uom: l.uom?.value ?? null,
        unitPrice: l.unit_price?.value ?? null,
        amount: l.amount?.value ?? null,
        matchStatus: l.match_status ?? null,
        isCodeAndApprove: l.is_code_and_approve ?? false,
      })),
      validation: findings.map((f) => ({ severity: f.severity, code: f.code, fieldPath: f.field_path ?? null, message: f.message ?? null, blocking: f.blocking })),
      extraction: { rawExtractionJson: foundry.rawJson, normalizedJson: JSON.stringify(inv), overallConfidence: inv.extraction.overall_confidence },
      blobUri: blobRef.blobUri,
    });
    invoiceHeaderId = saved.invoiceHeaderId;
    inv.invoice_id = invoiceHeaderId;
    trace.push(`PERSISTED invoice=${invoiceHeaderId.slice(0, 8)} ${saved.created ? "(new)" : "(existing)"}`);

    if (state === "READY" && deps.autoStage) {
      const s = await deps.persistence.stageInvoice(invoiceHeaderId);
      state = "STAGED";
      staged = true;
      trace.push(`STAGED for Boomi (${s.stagingId.slice(0, 8)}) — Ready for pickup`);
    }
  }

  trace.push(`DECISION ${state}`);
  return finalize(state, decision, inv, findings, documentId, inv.invoice_type, businessKey, invoiceHeaderId, staged);
}
