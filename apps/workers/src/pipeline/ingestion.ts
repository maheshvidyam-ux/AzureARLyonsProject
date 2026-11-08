/**
 * Ingestion helpers (spec §4). Durable, idempotent persistence now lives behind the
 * `@coa/persistence` port (mail_message / mail_attachment, get-or-create on the immutable
 * Graph ids + content hash). This module only holds the pure helper that turns a Graph
 * attachment into the bytes handed to Blob — the rest is the repository's job.
 */
import type { GraphAttachment } from "./ports.js";

export function decodeAttachmentBytes(attachment: GraphAttachment): Buffer {
  return Buffer.from(attachment.contentBase64, "base64");
}

/** Lightweight view of the persisted ingestion state surfaced on the slice result. */
export interface IngestionRef {
  mailMessageId: string;
  mailAttachmentId: string;
  filename: string;
  blobUri: string;
  contentHash: string;
  /** false => replay; the record already existed. */
  created: boolean;
}
