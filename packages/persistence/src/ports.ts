/**
 * Persistence port — the engine-neutral contract the pipeline writes through. Two
 * implementations exist: an in-memory store (tests / local demo) and a SQL-database-in-Fabric
 * adapter (ADR 0007). The pipeline depends only on this interface, so the datastore engine
 * stays isolated from pipeline logic.
 *
 * Idempotency is first-class: `ingest`, `recordDocument`, and `saveProcessedOrder` are all
 * get-or-create on their natural keys, mirroring the UNIQUE constraints in
 * db/migrations/0001_init.up.sql. A replayed message therefore creates no duplicate rows.
 */

// --- ingestion (mail_message + mail_attachment) ---
export interface IngestionInput {
  companyId: string;
  graphMessageId: string;
  mailbox: string;
  sender: string | null;
  receivedAt: string;
  subject: string | null;
  attachment: {
    graphAttachmentId: string;
    contentHash: string;
    blobUri: string;
    contentType: string | null;
  };
}
export interface IngestionResult {
  mailMessageId: string;
  mailAttachmentId: string;
  /** false => this (message, attachment, content) was already ingested. */
  created: boolean;
}

// --- source_document ---
export interface RecordDocumentInput {
  mailAttachmentId: string;
  companyId: string;
  classification?: string | null;
  blobUriOriginal: string;
  blobUriOcr?: string | null;
  diModelVersion?: string | null;
}
export interface RecordDocumentResult {
  sourceDocumentId: string;
  created: boolean;
}

// --- failure (no normalized order produced) ---
export interface MarkFailedInput {
  mailMessageId: string;
  reason: string;
}

// --- processed order (extracted_order + order_header + lines + validation + history) ---
export interface OrderHeaderWrite {
  sourceChannel: string;
  erpCustomerAccount: string | null;
  customerPoNumber: string | null;
  normalizedPoNumber: string | null;
  poDate: string | null;
  requestedDeliveryDate: string | null;
  shipTo: string | null;
  billTo: string | null;
  currency: string | null;
  total: number | null;
  lineCount: number;
  simpleStatus: string;
  internalState: string;
}
export interface OrderLineWrite {
  sourceLineNo: number | null;
  customerItemCode: string | null;
  erpItemId: string | null;
  quantity: number | null;
  uom: string | null;
  unitPrice: number | null;
  extendedAmount: number | null;
  requestedDate: string | null;
  evidenceJson: string | null;
}
export interface ValidationWrite {
  severity: string;
  code: string;
  fieldPath: string | null;
  message: string | null;
  blocking: boolean;
}
export interface StatusHistoryWrite {
  fromState: string | null;
  toState: string;
  actor: string;
  reason: string | null;
}
export interface SaveProcessedOrderInput {
  sourceDocumentId: string;
  companyId: string;
  extraction: {
    rawExtractionJson: string;
    normalizedJson: string;
    foundryModelVersion?: string | null;
    overallConfidence?: number | null;
  };
  header: OrderHeaderWrite;
  lines: OrderLineWrite[];
  validation: ValidationWrite[];
  statusHistory: StatusHistoryWrite;
}
export interface SaveProcessedOrderResult {
  extractedOrderId: string;
  orderHeaderId: string;
  created: boolean;
}

// --- read models (reviewer UI / tests) ---
export interface OrderHeaderRow {
  id: string;
  companyId: string;
  internalState: string;
  simpleStatus: string;
  normalizedPoNumber: string | null;
  erpCustomerAccount: string | null;
  total: number | null;
  lineCount: number;
}
export interface ValidationRow {
  code: string;
  severity: string;
  blocking: boolean;
  fieldPath: string | null;
}
export interface MailMessageRow {
  id: string;
  processingOutcome: string | null;
  failureReason: string | null;
}

// --- duplicate claim (spec §8, invariant #2) ---
export type DuplicateChannel = "EMAIL" | "EDI" | "AX";

export interface ClaimDuplicateInput {
  companyId: string;
  /** normalized_po_number :: erp_customer_account :: company_id */
  businessKey: string;
  orderHeaderId: string;
  channel: DuplicateChannel;
  matchedExistingRef?: string | null;
}

export type DuplicateClaimResult =
  | { status: "CLAIMED"; claimId: string }
  | { status: "COLLISION"; matchedChannel: DuplicateChannel | null; matchedExistingRef: string | null };

/** Register an external (EDI/AX) claim with no local order — for cross-channel coordination/tests. */
export interface SeedExternalClaimInput {
  companyId: string;
  businessKey: string;
  channel: DuplicateChannel;
  matchedExistingRef?: string | null;
}

// --- reviewer workbench (spec §13, §14) ---
export interface OrderSummaryRow {
  id: string;
  companyId: string;
  customerPoNumber: string | null;
  normalizedPoNumber: string | null;
  erpCustomerAccount: string | null;
  simpleStatus: string;
  internalState: string;
  total: number | null;
  lineCount: number;
  rowVersion: number;
}

export interface OrderLineDetail {
  lineId: string;
  sourceLineNo: number | null;
  customerItemCode: string | null;
  erpItemId: string | null;
  quantity: number | null;
  uom: string | null;
  unitPrice: number | null;
  extendedAmount: number | null;
}

export interface OrderReviewHeader {
  id: string;
  companyId: string;
  sourceChannel: string;
  customerPoNumber: string | null;
  normalizedPoNumber: string | null;
  erpCustomerAccount: string | null;
  poDate: string | null;
  shipTo: string | null;
  billTo: string | null;
  currency: string | null;
  total: number | null;
  simpleStatus: string;
  internalState: string;
  rowVersion: number;
}

export interface OrderReviewDetail {
  header: OrderReviewHeader;
  lines: OrderLineDetail[];
  validation: ValidationRow[];
  /** normalized PO JSON (evidence/bounding boxes for the viewer); null if unavailable. */
  normalized: unknown | null;
}

export interface ListOrdersFilter {
  companyId?: string;
  internalState?: string;
  limit?: number;
}

export interface OrderHeaderPatch {
  erpCustomerAccount?: string | null;
  customerPoNumber?: string | null;
  poDate?: string | null;
  shipTo?: string | null;
  billTo?: string | null;
  currency?: string | null;
  total?: number | null;
}
export interface OrderLinePatch {
  lineId: string;
  erpItemId?: string | null;
  quantity?: number | null;
  uom?: string | null;
  unitPrice?: number | null;
}
export interface UpdateOrderInput {
  header?: OrderHeaderPatch;
  lines?: OrderLinePatch[];
}

/** Optimistic-concurrency result: CONFLICT means the caller's rowVersion was stale (spec §13). */
export type OptimisticResult =
  | { status: "OK"; rowVersion: number }
  | { status: "CONFLICT"; rowVersion: number }
  | { status: "NOT_FOUND" };

export type ReviewDecisionKind = "APPROVE" | "REJECT";

// --- Boomi staging ("final tables"; spec §8/§5, ADR 0003/0004) ---
export interface StageOrderResult {
  stagingId: string;
  /** false => already staged (idempotent). */
  created: boolean;
}
export interface StagedOrderRow {
  stagingId: string;
  orderHeaderId: string;
  dataAreaId: string;
  erpCustomerAccount: string | null;
  customerPoNumber: string | null;
  normalizedPoNumber: string | null;
  poDate: string | null;
  requestedDeliveryDate: string | null;
  currency: string | null;
  total: number | null;
  lineCount: number;
  publishStatus: string;
  axSalesOrderId: string | null;
}

export interface Persistence {
  ingest(input: IngestionInput): Promise<IngestionResult>;
  recordDocument(input: RecordDocumentInput): Promise<RecordDocumentResult>;
  markFailed(input: MarkFailedInput): Promise<void>;
  saveProcessedOrder(input: SaveProcessedOrderInput): Promise<SaveProcessedOrderResult>;

  /** Atomically reserve the duplicate business key. Exactly one concurrent caller gets CLAIMED. */
  claimDuplicate(input: ClaimDuplicateInput): Promise<DuplicateClaimResult>;
  /** Pre-register an EDI/AX claim (cross-channel). */
  seedExternalClaim(input: SeedExternalClaimInput): Promise<void>;
  /** Route an order to DUPLICATE_REVIEW: set state + add a blocking finding + status history. */
  markDuplicateReview(orderHeaderId: string, detail: string): Promise<void>;

  // --- reviewer workbench ---
  listOrders(filter: ListOrdersFilter): Promise<OrderSummaryRow[]>;
  getOrderForReview(orderHeaderId: string): Promise<OrderReviewDetail | null>;
  /** Edit header/line fields with optimistic concurrency; bumps row_version. */
  updateOrderFields(orderHeaderId: string, expectedRowVersion: number, patch: UpdateOrderInput, actor: string): Promise<OptimisticResult>;
  /**
   * Approve or reject with optimistic concurrency + audit. APPROVE stages the order to the
   * Boomi "final tables" (→ STAGED, publish_status READY); REJECT → REJECTED.
   */
  reviewDecision(orderHeaderId: string, decision: ReviewDecisionKind, expectedRowVersion: number, actor: string): Promise<OptimisticResult>;

  // --- Boomi staging ---
  /** Publish an order to the Boomi staging tables (idempotent) and set it STAGED. */
  stageOrder(orderHeaderId: string): Promise<StageOrderResult>;
  /** Orders Boomi can pick up (publish_status = READY). */
  listReadyForBoomi(limit?: number): Promise<StagedOrderRow[]>;
  /** Boomi acknowledgment: record the AX sales order id (or a failure) and complete the order. */
  markBoomiResult(stagingId: string, result: { axSalesOrderId?: string; error?: string }): Promise<void>;

  getOrderHeaderById(id: string): Promise<OrderHeaderRow | null>;
  getValidationByOrderId(orderHeaderId: string): Promise<ValidationRow[]>;
  getMailMessageById(id: string): Promise<MailMessageRow | null>;
  countOrders(): Promise<number>;

  close(): Promise<void>;
}
