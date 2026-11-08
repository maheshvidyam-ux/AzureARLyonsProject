/**
 * Port interfaces for the ingest-to-no-stage slice. Real Azure-backed adapters
 * (Microsoft Graph, Blob, Document Intelligence, AI Foundry) implement these in later
 * phases; `mocks/` provides test-env-only fakes. Nothing here touches a live service.
 */

// ---------------------------------------------------------------------------
// Microsoft Graph (mailbox ingestion) — spec §4
// ---------------------------------------------------------------------------
export interface GraphAttachment {
  graphAttachmentId: string;
  filename: string;
  contentType: string;
  /** base64 of the raw attachment bytes */
  contentBase64: string;
}

export interface GraphMailMessage {
  graphMessageId: string;
  mailbox: string;
  sender: string;
  receivedAt: string; // ISO-8601
  subject: string;
  attachments: GraphAttachment[];
}

export interface GraphSource {
  /** Pull the next batch of unprocessed messages (mock: a fixed fixture set). */
  fetchMessages(): Promise<GraphMailMessage[]>;
}

// ---------------------------------------------------------------------------
// Blob (immutable original documents) — spec §2
// ---------------------------------------------------------------------------
export interface BlobRef {
  blobUri: string;
  filename: string;
  contentHash: string;
}

export interface BlobStore {
  /** Idempotent on contentHash: storing the same bytes twice returns the same ref. */
  put(input: { filename: string; bytes: Buffer }): Promise<BlobRef>;
  writeCount(): number;
}

// ---------------------------------------------------------------------------
// Document Intelligence (OCR / layout / bounding boxes) — spec §5
// ---------------------------------------------------------------------------
export interface DiBox {
  page: number;
  polygon: number[];
}
export interface DiValue {
  text: string;
  confidence: number;
  page: number;
  polygon: number[];
}
export interface DiLayoutResult {
  diModelVersion: string;
  pages: number;
  /** keyed header fields extracted by the model */
  fields: Record<string, DiValue>;
  /** one record per detected line, each a map of column -> value */
  lines: Array<Record<string, DiValue>>;
  documentQualityFlags: string[];
}

export interface DocumentIntelligenceClient {
  analyze(input: { blob: BlobRef }): Promise<DiLayoutResult>;
}

// ---------------------------------------------------------------------------
// AI Foundry (schema-constrained PO interpretation) — spec §5
// ---------------------------------------------------------------------------
export interface FoundryResult {
  /** Raw model output. May be malformed JSON — the caller must handle that. */
  rawJson: string;
  deployment: string;
  promptVersion: string;
}

export interface FoundryClient {
  interpret(input: { di: DiLayoutResult; blob: BlobRef }): Promise<FoundryResult>;
}
