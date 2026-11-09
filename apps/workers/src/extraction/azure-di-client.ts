/**
 * Real Azure AI Document Intelligence client (spec §5) implementing the pipeline's
 * `DocumentIntelligenceClient` port. Entra auth via `@azure/identity`; no keys. The OCR/layout
 * mapping is the pure `mapDiResult`, so this adapter stays thin.
 *
 * Document bytes are resolved via an injected `resolveBytes(blob)` — in production a Blob
 * download; the default fetches an http(s) blob URL (e.g. a SAS URL). Live use needs a
 * provisioned Document Intelligence resource (Terraform `modules/ai`) and a data-retention
 * policy review (spec §3).
 */
import { DocumentAnalysisClient } from "@azure/ai-form-recognizer";
import { DefaultAzureCredential } from "@azure/identity";
import type { BlobRef, DiLayoutResult, DocumentIntelligenceClient } from "../pipeline/ports.js";
import { mapDiResult, type RawDiResult } from "./di-mapping.js";

export type ResolveBytes = (blob: BlobRef) => Promise<Uint8Array>;

export interface AzureDiOptions {
  client: DocumentAnalysisClient;
  modelId: string;
  resolveBytes: ResolveBytes;
}

export class AzureDocumentIntelligenceClient implements DocumentIntelligenceClient {
  constructor(private readonly opts: AzureDiOptions) {}

  async analyze(input: { blob: BlobRef }): Promise<DiLayoutResult> {
    const bytes = await this.opts.resolveBytes(input.blob);
    const poller = await this.opts.client.beginAnalyzeDocument(this.opts.modelId, bytes);
    const result = await poller.pollUntilDone();
    return mapDiResult(result as unknown as RawDiResult, this.opts.modelId);
  }
}

/** Default byte resolver: download an http(s) blob URL (e.g. a SAS URL). */
export const fetchBlobBytes: ResolveBytes = async (blob) => {
  if (!/^https?:/i.test(blob.blobUri)) {
    throw new Error(`fetchBlobBytes needs an http(s) URL; got '${blob.blobUri}'. Provide a resolveBytes that reads from Blob storage.`);
  }
  const res = await fetch(blob.blobUri);
  if (!res.ok) throw new Error(`Failed to fetch document bytes: ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
};

export function createAzureDocumentIntelligenceClient(opts?: { resolveBytes?: ResolveBytes }): AzureDocumentIntelligenceClient {
  const endpoint = requireEnv("DOC_INTEL_ENDPOINT");
  const modelId = process.env.DOC_INTEL_MODEL_ID ?? "prebuilt-invoice";
  const client = new DocumentAnalysisClient(endpoint, new DefaultAzureCredential());
  return new AzureDocumentIntelligenceClient({ client, modelId, resolveBytes: opts?.resolveBytes ?? fetchBlobBytes });
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}
