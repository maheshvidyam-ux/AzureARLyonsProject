/**
 * Azure Blob implementation of the pipeline's `BlobStore` port (spec §2): immutable original
 * documents, content-hash addressed (idempotent — same bytes → one object). Entra auth, no
 * keys. Also exposes `download` so the Document Intelligence client can read the bytes it needs.
 */
import { createHash } from "node:crypto";
import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import type { BlobRef, BlobStore } from "../pipeline/ports.js";

export interface AzureBlobOptions {
  serviceClient: BlobServiceClient;
  container: string;
}

export class AzureBlobStore implements BlobStore {
  private writes = 0;
  constructor(private readonly opts: AzureBlobOptions) {}

  private blobName(contentHash: string): string {
    return `originals/${contentHash}`;
  }
  private block(contentHash: string) {
    return this.opts.serviceClient.getContainerClient(this.opts.container).getBlockBlobClient(this.blobName(contentHash));
  }

  async put(input: { filename: string; bytes: Buffer }): Promise<BlobRef> {
    const contentHash = createHash("sha256").update(input.bytes).digest("hex");
    const block = this.block(contentHash);
    if (!(await block.exists())) {
      await block.uploadData(input.bytes, {
        blobHTTPHeaders: { blobContentType: "application/pdf" },
        metadata: { filename: input.filename },
      });
      this.writes += 1;
    }
    return { blobUri: block.url, filename: input.filename, contentHash };
  }

  /** Download a stored document's bytes (used by the DI client's resolveBytes). */
  async download(ref: BlobRef): Promise<Uint8Array> {
    const buf = await this.block(ref.contentHash).downloadToBuffer();
    return new Uint8Array(buf);
  }

  writeCount(): number {
    return this.writes;
  }
}

export function createAzureBlobStore(): AzureBlobStore {
  const accountUrl = requireEnv("BLOB_ACCOUNT_URL"); // https://<account>.blob.core.windows.net
  const container = process.env.BLOB_CONTAINER ?? "originals";
  const serviceClient = new BlobServiceClient(accountUrl, new DefaultAzureCredential());
  return new AzureBlobStore({ serviceClient, container });
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}
