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

export interface Persistence {
  ingest(input: IngestionInput): Promise<IngestionResult>;
  recordDocument(input: RecordDocumentInput): Promise<RecordDocumentResult>;
  markFailed(input: MarkFailedInput): Promise<void>;
  saveProcessedOrder(input: SaveProcessedOrderInput): Promise<SaveProcessedOrderResult>;

  getOrderHeaderById(id: string): Promise<OrderHeaderRow | null>;
  getValidationByOrderId(orderHeaderId: string): Promise<ValidationRow[]>;
  getMailMessageById(id: string): Promise<MailMessageRow | null>;
  countOrders(): Promise<number>;

  close(): Promise<void>;
}
