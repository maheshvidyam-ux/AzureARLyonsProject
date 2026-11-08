/**
 * TEST-ENV-ONLY Document Intelligence + AI Foundry clients (spec §18 — quarantined mock).
 * They look up recorded responses by the sample file stem carried on the Blob ref. Real
 * adapters send the document bytes to Azure and ignore the filename.
 */
import type {
  BlobRef,
  DiLayoutResult,
  DocumentIntelligenceClient,
  FoundryClient,
  FoundryResult,
} from "../../apps/workers/src/pipeline/ports.js";
import { DI_RESPONSES } from "./di-responses/index.js";
import { FOUNDRY_RESPONSES } from "./foundry-responses/index.js";

function stemOf(blob: BlobRef): string {
  return blob.filename.replace(/\.[^.]+$/, "");
}

export class MockDocumentIntelligenceClient implements DocumentIntelligenceClient {
  async analyze(input: { blob: BlobRef }): Promise<DiLayoutResult> {
    const stem = stemOf(input.blob);
    const recorded = DI_RESPONSES[stem];
    if (!recorded) throw new Error(`No recorded DI response for fixture '${stem}'`);
    return structuredClone(recorded);
  }
}

export class MockFoundryClient implements FoundryClient {
  async interpret(input: { blob: BlobRef }): Promise<FoundryResult> {
    const stem = stemOf(input.blob);
    const fx = FOUNDRY_RESPONSES[stem];
    if (!fx) throw new Error(`No recorded Foundry response for fixture '${stem}'`);
    const rawJson = fx.malformedRaw ?? JSON.stringify(fx.draft);
    return { rawJson, deployment: fx.deployment, promptVersion: fx.promptVersion };
  }
}
