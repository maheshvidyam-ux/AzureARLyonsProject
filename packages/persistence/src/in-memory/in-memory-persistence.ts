/**
 * In-memory Persistence (tests / local demo). Mirrors the idempotency guarantees of the
 * Fabric SQL schema: get-or-create on the same natural keys enforced by the UNIQUE
 * constraints in db/migrations/0001_init.up.sql, so a replay creates no duplicate rows.
 */
import { randomUUID } from "node:crypto";
import type {
  ClaimDuplicateInput,
  DuplicateChannel,
  DuplicateClaimResult,
  IngestionInput,
  IngestionResult,
  MailMessageRow,
  MarkFailedInput,
  OrderHeaderRow,
  Persistence,
  RecordDocumentInput,
  RecordDocumentResult,
  SaveProcessedOrderInput,
  SaveProcessedOrderResult,
  SeedExternalClaimInput,
  ValidationRow,
} from "../ports.js";

interface MailMessage {
  id: string;
  companyId: string;
  graphMessageId: string;
  processingOutcome: string | null;
  failureReason: string | null;
}
interface MailAttachment {
  id: string;
  mailMessageId: string;
  graphAttachmentId: string;
  contentHash: string;
}
interface SourceDocument {
  id: string;
  mailAttachmentId: string;
}
interface ExtractedOrder {
  id: string;
  sourceDocumentId: string;
}
interface OrderHeader extends OrderHeaderRow {
  extractedOrderId: string;
}

export class InMemoryPersistence implements Persistence {
  private readonly mailByGraphId = new Map<string, MailMessage>();
  private readonly attByGraphId = new Map<string, MailAttachment>();
  private readonly docByAttId = new Map<string, SourceDocument>();
  private readonly extractedByDocId = new Map<string, ExtractedOrder>();
  private readonly headerByExtractedId = new Map<string, OrderHeader>();
  private readonly validationByHeaderId = new Map<string, ValidationRow[]>();
  /** active duplicate claims keyed by business_key (CLAIMED/RESOLVED) */
  private readonly activeClaims = new Map<string, { channel: DuplicateChannel; ref: string | null; orderHeaderId: string | null; claimId: string }>();

  async ingest(input: IngestionInput): Promise<IngestionResult> {
    let message = this.mailByGraphId.get(input.graphMessageId);
    if (!message) {
      message = {
        id: randomUUID(),
        companyId: input.companyId,
        graphMessageId: input.graphMessageId,
        processingOutcome: null,
        failureReason: null,
      };
      this.mailByGraphId.set(input.graphMessageId, message);
    }

    let attachment = this.attByGraphId.get(input.attachment.graphAttachmentId);
    let created = false;
    if (!attachment) {
      attachment = {
        id: randomUUID(),
        mailMessageId: message.id,
        graphAttachmentId: input.attachment.graphAttachmentId,
        contentHash: input.attachment.contentHash,
      };
      this.attByGraphId.set(input.attachment.graphAttachmentId, attachment);
      created = true;
    }

    return { mailMessageId: message.id, mailAttachmentId: attachment.id, created };
  }

  async recordDocument(input: RecordDocumentInput): Promise<RecordDocumentResult> {
    let doc = this.docByAttId.get(input.mailAttachmentId);
    let created = false;
    if (!doc) {
      doc = { id: randomUUID(), mailAttachmentId: input.mailAttachmentId };
      this.docByAttId.set(input.mailAttachmentId, doc);
      created = true;
    }
    return { sourceDocumentId: doc.id, created };
  }

  async markFailed(input: MarkFailedInput): Promise<void> {
    for (const m of this.mailByGraphId.values()) {
      if (m.id === input.mailMessageId) {
        m.processingOutcome = "FAILED";
        m.failureReason = input.reason;
        return;
      }
    }
  }

  async saveProcessedOrder(input: SaveProcessedOrderInput): Promise<SaveProcessedOrderResult> {
    let extracted = this.extractedByDocId.get(input.sourceDocumentId);
    if (!extracted) {
      extracted = { id: randomUUID(), sourceDocumentId: input.sourceDocumentId };
      this.extractedByDocId.set(input.sourceDocumentId, extracted);
    }

    const existingHeader = this.headerByExtractedId.get(extracted.id);
    if (existingHeader) {
      return { extractedOrderId: extracted.id, orderHeaderId: existingHeader.id, created: false };
    }

    const header: OrderHeader = {
      id: randomUUID(),
      extractedOrderId: extracted.id,
      companyId: input.companyId,
      internalState: input.header.internalState,
      simpleStatus: input.header.simpleStatus,
      normalizedPoNumber: input.header.normalizedPoNumber,
      erpCustomerAccount: input.header.erpCustomerAccount,
      total: input.header.total,
      lineCount: input.header.lineCount,
    };
    this.headerByExtractedId.set(extracted.id, header);
    this.validationByHeaderId.set(
      header.id,
      input.validation.map((v) => ({ code: v.code, severity: v.severity, blocking: v.blocking, fieldPath: v.fieldPath })),
    );

    return { extractedOrderId: extracted.id, orderHeaderId: header.id, created: true };
  }

  async claimDuplicate(input: ClaimDuplicateInput): Promise<DuplicateClaimResult> {
    // Single-threaded check-then-set is atomic here; the Fabric SQL impl relies on the
    // filtered unique index for the same guarantee under real concurrency.
    const existing = this.activeClaims.get(input.businessKey);
    if (existing) {
      // Re-claim by the same order is idempotent (not a duplicate).
      if (existing.orderHeaderId && existing.orderHeaderId === input.orderHeaderId) {
        return { status: "CLAIMED", claimId: existing.claimId };
      }
      return { status: "COLLISION", matchedChannel: existing.channel, matchedExistingRef: existing.ref };
    }
    const claimId = randomUUID();
    this.activeClaims.set(input.businessKey, {
      channel: input.channel,
      ref: input.matchedExistingRef ?? input.orderHeaderId,
      orderHeaderId: input.orderHeaderId,
      claimId,
    });
    return { status: "CLAIMED", claimId };
  }

  async seedExternalClaim(input: SeedExternalClaimInput): Promise<void> {
    this.activeClaims.set(input.businessKey, {
      channel: input.channel,
      ref: input.matchedExistingRef ?? null,
      orderHeaderId: null,
      claimId: randomUUID(),
    });
  }

  async markDuplicateReview(orderHeaderId: string, detail: string): Promise<void> {
    const header = this.findHeader(orderHeaderId);
    if (!header) return;
    header.internalState = "DUPLICATE_REVIEW";
    header.simpleStatus = "Needs Review";
    const findings = this.validationByHeaderId.get(orderHeaderId) ?? [];
    findings.push({ code: "DUPLICATE_DETECTED", severity: "ERROR", blocking: true, fieldPath: null });
    this.validationByHeaderId.set(orderHeaderId, findings);
    void detail;
  }

  private findHeader(id: string): OrderHeader | undefined {
    for (const h of this.headerByExtractedId.values()) if (h.id === id) return h;
    return undefined;
  }

  async getOrderHeaderById(id: string): Promise<OrderHeaderRow | null> {
    for (const h of this.headerByExtractedId.values()) {
      if (h.id === id) {
        const { extractedOrderId: _drop, ...row } = h;
        return row;
      }
    }
    return null;
  }

  async getValidationByOrderId(orderHeaderId: string): Promise<ValidationRow[]> {
    return this.validationByHeaderId.get(orderHeaderId) ?? [];
  }

  async getMailMessageById(id: string): Promise<MailMessageRow | null> {
    for (const m of this.mailByGraphId.values()) {
      if (m.id === id) {
        return { id: m.id, processingOutcome: m.processingOutcome, failureReason: m.failureReason };
      }
    }
    return null;
  }

  async countOrders(): Promise<number> {
    return this.headerByExtractedId.size;
  }

  async close(): Promise<void> {
    /* no-op */
  }
}
