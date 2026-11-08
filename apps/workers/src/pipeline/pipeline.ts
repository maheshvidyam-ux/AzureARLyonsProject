/**
 * Orchestrator for the first vertical slice (backlog §9.3): "Ingest one sample PO
 * end-to-no-stage". Graph (mock) -> idempotent persistence (mail/attachment) -> Blob (mock)
 * -> Document Intelligence (mock) -> AI Foundry (mock) -> normalized PO (docs/04) ->
 * deterministic validation -> persist the order graph -> STOP before staging.
 *
 * All operational state is written through the `@coa/persistence` port (SQL database in
 * Fabric in production, in-memory for tests — ADR 0007). GUARDRAIL: this never stages,
 * never writes to Fabric staging, never touches AX. Terminal states are READY /
 * NEEDS_REVIEW / FAILED, all strictly pre-staging.
 */
import {
  PRE_STAGING_TERMINAL_STATES,
  duplicateBusinessKey,
  resolveCompanyId,
  toSimpleStatus,
  type InternalState,
  type SimpleStatus,
} from "@coa/domain";
import type { NormalizedPurchaseOrder, ValidationFinding } from "@coa/po-schema";
import {
  toOrderHeaderWrite,
  toOrderLineWrites,
  toStatusHistoryWrite,
  toValidationWrites,
  type Persistence,
} from "@coa/persistence";
import { decodeAttachmentBytes, type IngestionRef } from "./ingestion.js";
import { normalize } from "./normalize.js";
import { validateStructural } from "./validation.js";
import type { BlobRef, BlobStore, DocumentIntelligenceClient, FoundryClient, GraphMailMessage } from "./ports.js";

/**
 * ⚠️ PROVISIONAL (Q-VAL-1): confidence below which an otherwise-clean order is still routed
 * to human review. The real threshold is a business policy decision.
 */
export const CONFIDENCE_REVIEW_THRESHOLD = 0.75;

export type SliceDecision = "READY" | "NEEDS_REVIEW" | "FAILED";

export interface SliceResult {
  companyId: string;
  /** source_document id once recorded; null if we failed before DI. */
  documentId: string | null;
  /** order_header id once persisted; null for FAILED (no normalized order). */
  orderHeaderId: string | null;
  ingestion: IngestionRef;
  decision: SliceDecision;
  internalState: InternalState;
  simpleStatus: SimpleStatus;
  normalized: NormalizedPurchaseOrder | null;
  findings: ValidationFinding[];
  duplicateBusinessKey: string | null;
  /** Always true — the slice stops before staging by construction. */
  stagedBlocked: true;
  trace: string[];
}

export interface PipelineDeps {
  blob: BlobStore;
  persistence: Persistence;
  di: DocumentIntelligenceClient;
  foundry: FoundryClient;
}

export async function processAttachment(
  deps: PipelineDeps,
  message: GraphMailMessage,
  attachmentIndex = 0,
): Promise<SliceResult> {
  const trace: string[] = [];
  const attachment = message.attachments[attachmentIndex];
  if (!attachment) throw new Error(`Message ${message.graphMessageId} has no attachment at index ${attachmentIndex}`);

  const { companyId } = resolveCompanyId({ sender: message.sender, mailbox: message.mailbox });

  // 1. Store original to Blob (idempotent on content) + durable, idempotent ingestion record.
  const bytes = decodeAttachmentBytes(attachment);
  const blobRef: BlobRef = await deps.blob.put({ filename: attachment.filename, bytes });
  const ing = await deps.persistence.ingest({
    companyId,
    graphMessageId: message.graphMessageId,
    mailbox: message.mailbox,
    sender: message.sender,
    receivedAt: message.receivedAt,
    subject: message.subject,
    attachment: {
      graphAttachmentId: attachment.graphAttachmentId,
      contentHash: blobRef.contentHash,
      blobUri: blobRef.blobUri,
      contentType: attachment.contentType,
    },
  });
  const ingestion: IngestionRef = {
    mailMessageId: ing.mailMessageId,
    mailAttachmentId: ing.mailAttachmentId,
    filename: blobRef.filename,
    blobUri: blobRef.blobUri,
    contentHash: blobRef.contentHash,
    created: ing.created,
  };
  trace.push(`INGESTED ${ing.created ? "(new)" : "(replay — no new record/blob)"} ${blobRef.filename}`);

  const failBeforeOrder = (findings: ValidationFinding[], note: string, documentId: string | null = null): SliceResult => {
    trace.push(`FAILED ${note}`);
    return result(companyId, documentId, null, ingestion, "FAILED", null, findings, trace);
  };

  // 2. Document Intelligence.
  let di;
  try {
    di = await deps.di.analyze({ blob: blobRef });
    trace.push(`OCR_DONE di=${di.diModelVersion} pages=${di.pages} lines=${di.lines.length}`);
  } catch (e) {
    await deps.persistence.markFailed({ mailMessageId: ing.mailMessageId, reason: `DI_FAILED: ${(e as Error).message}` });
    return failBeforeOrder([finding("DI_FAILED", (e as Error).message)], "document-intelligence error");
  }

  // 3. Record the source document (now that DI model version is known).
  const doc = await deps.persistence.recordDocument({
    mailAttachmentId: ing.mailAttachmentId,
    companyId,
    blobUriOriginal: blobRef.blobUri,
    diModelVersion: di.diModelVersion,
  });
  const documentId = doc.sourceDocumentId;

  // 4. AI Foundry interpretation.
  let foundry;
  try {
    foundry = await deps.foundry.interpret({ di, blob: blobRef });
    trace.push(`AI_DONE deployment=${foundry.deployment} prompt=${foundry.promptVersion}`);
  } catch (e) {
    await deps.persistence.markFailed({ mailMessageId: ing.mailMessageId, reason: `FOUNDRY_CALL_FAILED: ${(e as Error).message}` });
    return failBeforeOrder([finding("FOUNDRY_CALL_FAILED", (e as Error).message)], "ai-foundry error", documentId);
  }

  // 5. Normalize + schema-enforce. Malformed AI output degrades to a controlled FAILED.
  const norm = normalize({ documentId, di, foundry });
  if (!norm.ok) {
    await deps.persistence.markFailed({ mailMessageId: ing.mailMessageId, reason: `${norm.reason}: ${norm.detail}` });
    return failBeforeOrder([norm.finding], `${norm.reason}: ${norm.detail}`, documentId);
  }
  trace.push(`NORMALIZED po#=${norm.po.header.normalized_po_number ?? "∅"} lines=${norm.po.lines.length}`);

  // 6. Deterministic validation.
  const findings = validateStructural(norm.po);
  norm.po.validation = findings;

  const blocking = findings.filter((f) => f.blocking);
  const lowConfidence = norm.po.extraction.overall_confidence < CONFIDENCE_REVIEW_THRESHOLD;

  let decision: SliceDecision;
  let state: InternalState;
  if (blocking.length > 0) {
    decision = "NEEDS_REVIEW";
    state = "NEEDS_REVIEW";
    trace.push(`VALIDATED blocking=${blocking.length} -> NEEDS_REVIEW`);
  } else if (lowConfidence) {
    decision = "NEEDS_REVIEW";
    state = "NEEDS_REVIEW";
    trace.push(`VALIDATED low-confidence(${norm.po.extraction.overall_confidence}) -> NEEDS_REVIEW`);
  } else {
    decision = "READY";
    state = "READY";
    trace.push(`VALIDATED clean -> READY (STOP before staging)`);
  }

  // 7. Persist the order graph (idempotent on the source document / extraction).
  const saved = await deps.persistence.saveProcessedOrder({
    sourceDocumentId: documentId,
    companyId,
    extraction: {
      rawExtractionJson: foundry.rawJson,
      normalizedJson: JSON.stringify(norm.po),
      foundryModelVersion: foundry.deployment,
      overallConfidence: norm.po.extraction.overall_confidence,
    },
    header: toOrderHeaderWrite(norm.po, { simpleStatus: toSimpleStatus(state), internalState: state }),
    lines: toOrderLineWrites(norm.po),
    validation: toValidationWrites(findings),
    statusHistory: toStatusHistoryWrite(state),
  });
  trace.push(`PERSISTED order=${saved.orderHeaderId.slice(0, 8)} ${saved.created ? "(new)" : "(existing — replay)"}`);

  norm.po.order_id = saved.orderHeaderId;

  const res = result(companyId, documentId, saved.orderHeaderId, ingestion, state, norm.po, findings, trace, decision);
  res.duplicateBusinessKey = duplicateBusinessKey({
    normalizedPoNumber: norm.po.header.normalized_po_number ?? null,
    erpCustomerAccount: norm.po.header.customer?.erp_customer_account?.value ?? null,
    companyId: norm.po.company.company_id,
  });
  return res;
}

/** Process every attachment of every fetched message (the slice "runner"). */
export async function runSlice(deps: PipelineDeps, messages: GraphMailMessage[]): Promise<SliceResult[]> {
  const results: SliceResult[] = [];
  for (const message of messages) {
    for (let i = 0; i < message.attachments.length; i++) {
      results.push(await processAttachment(deps, message, i));
    }
  }
  return results;
}

function result(
  companyId: string,
  documentId: string | null,
  orderHeaderId: string | null,
  ingestion: IngestionRef,
  state: InternalState,
  normalized: NormalizedPurchaseOrder | null,
  findings: ValidationFinding[],
  trace: string[],
  decision: SliceDecision = state === "FAILED" ? "FAILED" : "NEEDS_REVIEW",
): SliceResult {
  // Guardrail: the slice must never advance past a pre-staging state.
  if (!(PRE_STAGING_TERMINAL_STATES as readonly InternalState[]).includes(state)) {
    throw new Error(`Guardrail violation: slice reached post-staging state '${state}'`);
  }
  return {
    companyId,
    documentId,
    orderHeaderId,
    ingestion,
    decision,
    internalState: state,
    simpleStatus: toSimpleStatus(state),
    normalized,
    findings,
    duplicateBusinessKey: null,
    stagedBlocked: true,
    trace,
  };
}

function finding(code: string, message: string): ValidationFinding {
  return { severity: "ERROR", code, field_path: null, message, blocking: true };
}
