/**
 * Manual upload intake (spec §4): a user uploads a document in the app instead of emailing it.
 * The uploaded file is wrapped in a synthetic mail message and run through the SAME pipeline as
 * an email attachment — routing extractor (PDF → Document Intelligence, Excel/CSV → spreadsheet),
 * Foundry, normalize, match, dedup, stage — for the chosen module (AR order or AP invoice).
 *
 * Idempotent on content: the synthetic Graph ids are derived from the file's sha256, so
 * re-uploading the same file does not create a duplicate record.
 */
import { createHash } from "node:crypto";
import type { ModuleCode } from "@coa/domain";
import { processAttachment, type PipelineDeps, type SliceResult } from "../../workers/src/pipeline/pipeline.js";
import { processInvoice, type InvoicePipelineDeps, type InvoiceResult } from "../../workers/src/invoice/index.js";
import type { GraphMailMessage } from "../../workers/src/pipeline/ports.js";

export interface UploadInput {
  module: ModuleCode;
  filename: string;
  bytes: Buffer;
  uploadedBy: string;
  companyId?: string;
}

export interface UploadOutcome {
  module: ModuleCode;
  decision: string;
  internalState: string;
  /** order_header id (AR) or ap_invoice_header id (AP), once persisted. */
  referenceId: string | null;
  documentId: string | null;
  reference: string | null; // normalized PO# (AR) or invoice# (AP)
  findings: Array<{ code: string; severity: string; blocking: boolean }>;
}

export interface UploadProcessor {
  process(input: UploadInput): Promise<UploadOutcome>;
}

function contentTypeFor(filename: string): string {
  if (/\.pdf$/i.test(filename)) return "application/pdf";
  if (/\.(xlsx|xlsm|xls)$/i.test(filename)) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (/\.csv$/i.test(filename)) return "text/csv";
  return "application/octet-stream";
}

/** Wrap an uploaded file in a synthetic mail message (content-addressed for idempotency). */
export function syntheticUploadMessage(input: UploadInput): GraphMailMessage {
  const hash = createHash("sha256").update(input.bytes).digest("hex");
  return {
    graphMessageId: `upload:${hash}`,
    mailbox: "upload",
    sender: input.uploadedBy,
    receivedAt: new Date().toISOString(),
    subject: `Uploaded ${input.filename}`,
    attachments: [
      {
        graphAttachmentId: `upload-att:${hash}`,
        filename: input.filename,
        contentType: contentTypeFor(input.filename),
        contentBase64: input.bytes.toString("base64"),
      },
    ],
  };
}

/** Runs uploads through the AR order / AP invoice pipelines (inline). */
export class PipelineUploadProcessor implements UploadProcessor {
  // `invoice` is optional: AP uploads require the Lakehouse (invoice masters). When it is not
  // configured, AR order uploads still work and AP uploads return a clear error.
  constructor(private readonly deps: { order: PipelineDeps; invoice?: InvoicePipelineDeps }) {}

  async process(input: UploadInput): Promise<UploadOutcome> {
    const message = syntheticUploadMessage(input);
    if (input.module === "AP_INVOICE") {
      if (!this.deps.invoice) {
        throw new Error("AP invoice processing is not configured (a Lakehouse connection is required).");
      }
      return mapInvoice(await processInvoice(this.deps.invoice, message, 0));
    }
    return mapOrder(await processAttachment(this.deps.order, message, 0));
  }
}

const findings = (fs: Array<{ code: string; severity: string; blocking: boolean }>) => fs.map((f) => ({ code: f.code, severity: f.severity, blocking: f.blocking }));

function mapOrder(r: SliceResult): UploadOutcome {
  return { module: "ORDER_PROCESSING", decision: r.decision, internalState: r.internalState, referenceId: r.orderHeaderId, documentId: r.documentId, reference: r.normalized?.header.normalized_po_number ?? null, findings: findings(r.findings) };
}
function mapInvoice(r: InvoiceResult): UploadOutcome {
  return { module: "AP_INVOICE", decision: r.decision, internalState: r.internalState, referenceId: r.invoiceHeaderId, documentId: r.documentId, reference: r.normalized?.header.normalized_invoice_number ?? null, findings: findings(r.findings) };
}
