/**
 * TEST-ENV-ONLY in-memory Blob store (spec §18 — quarantined mock). Models the immutable
 * original-document store with content-hash idempotency (spec §4): storing identical bytes
 * twice yields one object and one physical write, mirroring the dedupe guarantee the real
 * Blob + mail_attachment.content_hash design provides.
 */
import { createHash } from "node:crypto";
import type { BlobRef, BlobStore } from "../../apps/workers/src/pipeline/ports.js";

export class InMemoryBlobStore implements BlobStore {
  private readonly objects = new Map<string, { filename: string; bytes: Buffer }>();
  private writes = 0;

  async put(input: { filename: string; bytes: Buffer }): Promise<BlobRef> {
    const contentHash = createHash("sha256").update(input.bytes).digest("hex");
    if (!this.objects.has(contentHash)) {
      this.objects.set(contentHash, { filename: input.filename, bytes: input.bytes });
      this.writes += 1;
    }
    return {
      blobUri: `mock://blob/originals/${contentHash}`,
      filename: input.filename,
      contentHash,
    };
  }

  writeCount(): number {
    return this.writes;
  }
}
