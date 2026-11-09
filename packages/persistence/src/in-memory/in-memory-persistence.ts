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
  ListOrdersFilter,
  MailMessageRow,
  MarkFailedInput,
  OptimisticResult,
  OrderHeaderRow,
  OrderLineDetail,
  OrderLineWrite,
  OrderReviewDetail,
  OrderSummaryRow,
  Persistence,
  RecordDocumentInput,
  RecordDocumentResult,
  ReviewDecisionKind,
  SaveProcessedOrderInput,
  SaveProcessedOrderResult,
  SeedExternalClaimInput,
  StageOrderResult,
  StagedOrderRow,
  UpdateOrderInput,
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
type StoredLine = OrderLineDetail;
interface OrderHeader extends OrderHeaderRow {
  extractedOrderId: string;
  sourceChannel: string;
  customerPoNumber: string | null;
  poDate: string | null;
  requestedDeliveryDate: string | null;
  shipTo: string | null;
  billTo: string | null;
  currency: string | null;
  rowVersion: number;
  lines: StoredLine[];
  normalizedJson: string;
}

interface StagingRecord extends StagedOrderRow {
  lines: Array<{ lineNo: number | null; erpItemId: string | null; customerItemCode: string | null; quantity: number | null; uom: string | null; unitPrice: number | null }>;
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
  /** Boomi staging records keyed by orderHeaderId (one per order). */
  private readonly stagingByOrder = new Map<string, StagingRecord>();

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

    const headerId = randomUUID();
    const header: OrderHeader = {
      id: headerId,
      extractedOrderId: extracted.id,
      companyId: input.companyId,
      internalState: input.header.internalState,
      simpleStatus: input.header.simpleStatus,
      normalizedPoNumber: input.header.normalizedPoNumber,
      erpCustomerAccount: input.header.erpCustomerAccount,
      total: input.header.total,
      lineCount: input.header.lineCount,
      sourceChannel: input.header.sourceChannel,
      customerPoNumber: input.header.customerPoNumber,
      poDate: input.header.poDate,
      requestedDeliveryDate: input.header.requestedDeliveryDate,
      shipTo: input.header.shipTo,
      billTo: input.header.billTo,
      currency: input.header.currency,
      rowVersion: 0,
      lines: input.lines.map((l: OrderLineWrite, i) => ({
        lineId: `${headerId}:L${i + 1}`,
        sourceLineNo: l.sourceLineNo,
        customerItemCode: l.customerItemCode,
        erpItemId: l.erpItemId,
        quantity: l.quantity,
        uom: l.uom,
        unitPrice: l.unitPrice,
        extendedAmount: l.extendedAmount,
      })),
      normalizedJson: input.extraction.normalizedJson,
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

  private static toSummary(h: OrderHeader): OrderSummaryRow {
    return {
      id: h.id,
      companyId: h.companyId,
      customerPoNumber: h.customerPoNumber,
      normalizedPoNumber: h.normalizedPoNumber,
      erpCustomerAccount: h.erpCustomerAccount,
      simpleStatus: h.simpleStatus,
      internalState: h.internalState,
      total: h.total,
      lineCount: h.lineCount,
      rowVersion: h.rowVersion,
    };
  }

  async listOrders(filter: ListOrdersFilter): Promise<OrderSummaryRow[]> {
    let rows = [...this.headerByExtractedId.values()];
    if (filter.companyId) rows = rows.filter((h) => h.companyId === filter.companyId);
    if (filter.internalState) rows = rows.filter((h) => h.internalState === filter.internalState);
    rows = rows.slice(0, filter.limit ?? 100);
    return rows.map((h) => InMemoryPersistence.toSummary(h));
  }

  async getOrderForReview(orderHeaderId: string): Promise<OrderReviewDetail | null> {
    const h = this.findHeader(orderHeaderId);
    if (!h) return null;
    let normalized: unknown = null;
    try {
      normalized = JSON.parse(h.normalizedJson);
    } catch {
      normalized = null;
    }
    return {
      header: {
        id: h.id,
        companyId: h.companyId,
        sourceChannel: h.sourceChannel,
        customerPoNumber: h.customerPoNumber,
        normalizedPoNumber: h.normalizedPoNumber,
        erpCustomerAccount: h.erpCustomerAccount,
        poDate: h.poDate,
        shipTo: h.shipTo,
        billTo: h.billTo,
        currency: h.currency,
        total: h.total,
        simpleStatus: h.simpleStatus,
        internalState: h.internalState,
        rowVersion: h.rowVersion,
      },
      lines: h.lines.map((l) => ({ ...l })),
      validation: (this.validationByHeaderId.get(h.id) ?? []).map((v) => ({ ...v })),
      normalized,
    };
  }

  async updateOrderFields(orderHeaderId: string, expectedRowVersion: number, patch: UpdateOrderInput, _actor: string): Promise<OptimisticResult> {
    const h = this.findHeader(orderHeaderId);
    if (!h) return { status: "NOT_FOUND" };
    if (h.rowVersion !== expectedRowVersion) return { status: "CONFLICT", rowVersion: h.rowVersion };

    if (patch.header) {
      const p = patch.header;
      if (p.erpCustomerAccount !== undefined) h.erpCustomerAccount = p.erpCustomerAccount;
      if (p.customerPoNumber !== undefined) h.customerPoNumber = p.customerPoNumber;
      if (p.poDate !== undefined) h.poDate = p.poDate;
      if (p.shipTo !== undefined) h.shipTo = p.shipTo;
      if (p.billTo !== undefined) h.billTo = p.billTo;
      if (p.currency !== undefined) h.currency = p.currency;
      if (p.total !== undefined) h.total = p.total;
    }
    for (const lp of patch.lines ?? []) {
      const line = h.lines.find((l) => l.lineId === lp.lineId);
      if (!line) continue;
      if (lp.erpItemId !== undefined) line.erpItemId = lp.erpItemId;
      if (lp.quantity !== undefined) line.quantity = lp.quantity;
      if (lp.uom !== undefined) line.uom = lp.uom;
      if (lp.unitPrice !== undefined) line.unitPrice = lp.unitPrice;
    }
    h.rowVersion += 1;
    return { status: "OK", rowVersion: h.rowVersion };
  }

  async reviewDecision(orderHeaderId: string, decision: ReviewDecisionKind, expectedRowVersion: number, _actor: string): Promise<OptimisticResult> {
    const h = this.findHeader(orderHeaderId);
    if (!h) return { status: "NOT_FOUND" };
    if (h.rowVersion !== expectedRowVersion) return { status: "CONFLICT", rowVersion: h.rowVersion };
    if (decision === "APPROVE") {
      await this.stageOrder(orderHeaderId); // → STAGED, written to the Boomi staging tables
    } else {
      h.internalState = "REJECTED";
      h.simpleStatus = "Rejected";
    }
    h.rowVersion += 1;
    return { status: "OK", rowVersion: h.rowVersion };
  }

  async stageOrder(orderHeaderId: string): Promise<StageOrderResult> {
    const h = this.findHeader(orderHeaderId);
    if (!h) throw new Error(`Cannot stage unknown order ${orderHeaderId}`);
    const existing = this.stagingByOrder.get(orderHeaderId);
    if (existing) {
      h.internalState = "STAGED";
      h.simpleStatus = "Ready";
      return { stagingId: existing.stagingId, created: false };
    }
    const stagingId = randomUUID();
    this.stagingByOrder.set(orderHeaderId, {
      stagingId,
      orderHeaderId,
      dataAreaId: h.companyId,
      erpCustomerAccount: h.erpCustomerAccount,
      customerPoNumber: h.customerPoNumber,
      normalizedPoNumber: h.normalizedPoNumber,
      poDate: h.poDate,
      requestedDeliveryDate: h.requestedDeliveryDate,
      currency: h.currency,
      total: h.total,
      lineCount: h.lineCount,
      publishStatus: "READY",
      axSalesOrderId: null,
      lines: h.lines.map((l, i) => ({ lineNo: l.sourceLineNo ?? i + 1, erpItemId: l.erpItemId, customerItemCode: l.customerItemCode, quantity: l.quantity, uom: l.uom, unitPrice: l.unitPrice })),
    });
    h.internalState = "STAGED";
    h.simpleStatus = "Ready";
    return { stagingId, created: true };
  }

  async listReadyForBoomi(limit = 100): Promise<StagedOrderRow[]> {
    return [...this.stagingByOrder.values()]
      .filter((r) => r.publishStatus === "READY")
      .slice(0, limit)
      .map(({ lines: _lines, ...row }) => row);
  }

  async markBoomiResult(stagingId: string, result: { axSalesOrderId?: string; error?: string }): Promise<void> {
    for (const rec of this.stagingByOrder.values()) {
      if (rec.stagingId !== stagingId) continue;
      rec.publishStatus = result.error ? "FAILED" : "COMPLETED";
      rec.axSalesOrderId = result.axSalesOrderId ?? null;
      const h = this.findHeader(rec.orderHeaderId);
      if (h && !result.error) {
        h.internalState = "ERP_CREATED";
        h.simpleStatus = "Completed";
      }
      return;
    }
  }

  async getOrderHeaderById(id: string): Promise<OrderHeaderRow | null> {
    const h = this.findHeader(id);
    if (!h) return null;
    return {
      id: h.id,
      companyId: h.companyId,
      internalState: h.internalState,
      simpleStatus: h.simpleStatus,
      normalizedPoNumber: h.normalizedPoNumber,
      erpCustomerAccount: h.erpCustomerAccount,
      total: h.total,
      lineCount: h.lineCount,
    };
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
