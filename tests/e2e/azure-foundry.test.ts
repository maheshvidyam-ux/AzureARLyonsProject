/**
 * Phase 2 — real AI Foundry interpretation client (spec §5). Prompt building and output
 * handling are tested with a fake completer and flow through `normalize` to prove the real
 * client's contract matches the schema; the live model call is gated behind AI_FOUNDRY_ENDPOINT.
 */
import { describe, expect, it } from "vitest";
import {
  AzureFoundryClient,
  PROMPT_VERSION,
  buildDiContext,
  buildMessages,
  type ChatCompleter,
} from "../../apps/workers/src/interpretation/index.js";
import { normalize } from "../../apps/workers/src/pipeline/normalize.js";
import type { DiLayoutResult } from "../../apps/workers/src/pipeline/ports.js";

const DI: DiLayoutResult = {
  diModelVersion: "prebuilt-invoice:2023-07-31",
  pages: 1,
  fields: { po_number: { text: "PO-100045", confidence: 0.9, page: 1, polygon: [] }, customer_name: { text: "Acme Industrial Supply", confidence: 0.95, page: 1, polygon: [] } },
  lines: [{ product_code: { text: "ACM-778", confidence: 0.9, page: 1, polygon: [] }, quantity: { text: "500", confidence: 0.9, page: 1, polygon: [] } }],
  documentQualityFlags: [],
};

const DRAFT = {
  company: { company_id: "USMF", resolved_from: "document" },
  header: {
    customer: { name: { value: "Acme Industrial Supply" }, erp_customer_account: { value: null }, match_status: "UNMATCHED" },
    customer_po_number: { value: "PO-100045" },
    po_date: { value: "2026-10-28" },
    currency: { value: "USD" },
    totals: { subtotal: { amount: 750, currency: "USD" }, tax: { amount: 0, currency: "USD" }, grand_total: { amount: 750, currency: "USD" } },
  },
  lines: [{ customer_item_code: { value: "ACM-778" }, description: { value: "Hex Bolt" }, quantity: { value: 500 }, uom: { value: "EA" }, unit_price: { value: 1.5 }, extended_amount: { value: 750 }, match_status: "UNMATCHED" }],
  overall_confidence: 0.92,
};

const fakeCompleter = (content: string): ChatCompleter => ({ async complete() { return { content, usage: { prompt: 120, completion: 60 } }; } });
const blob = { blobUri: "mock://x", filename: "x.pdf", contentHash: "h" };

describe("prompt building", () => {
  it("includes the DI field text and a system instruction", () => {
    const msgs = buildMessages(DI);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toMatch(/ONLY JSON/);
    expect(msgs[1]!.content).toContain("PO-100045");
    expect(buildDiContext(DI)).toContain("ACM-778");
  });
});

describe("AzureFoundryClient", () => {
  it("returns the model JSON with deployment + prompt version, and the output is schema-valid via normalize", async () => {
    const client = new AzureFoundryClient({ completer: fakeCompleter(JSON.stringify(DRAFT)), deployment: "gpt-4o-po" });
    const res = await client.interpret({ di: DI, blob });

    expect(res.deployment).toBe("gpt-4o-po");
    expect(res.promptVersion).toBe(PROMPT_VERSION);

    const norm = normalize({ documentId: "doc-1", di: DI, foundry: res });
    expect(norm.ok).toBe(true);
    if (norm.ok) {
      expect(norm.po.header.customer_po_number?.value).toBe("PO-100045");
      expect(norm.po.header.normalized_po_number).toBe("PO100045");
      expect(norm.po.lines).toHaveLength(1);
    }
  });

  it("malformed model JSON degrades through normalize to a controlled failure", async () => {
    const client = new AzureFoundryClient({ completer: fakeCompleter('{"company":{"company_id":"USMF"'), deployment: "gpt-4o-po" });
    const res = await client.interpret({ di: DI, blob });
    const norm = normalize({ documentId: "doc-1", di: DI, foundry: res });
    expect(norm.ok).toBe(false);
    if (!norm.ok) expect(norm.reason).toBe("UNPARSEABLE");
  });
});

const hasFoundry = Boolean(process.env.AI_FOUNDRY_ENDPOINT && process.env.AI_FOUNDRY_DEPLOYMENT);
describe.skipIf(!hasFoundry)("AI Foundry (live)", () => {
  it("interprets DI output into parseable JSON", async () => {
    const { createAzureFoundryClient } = await import("../../apps/workers/src/interpretation/index.js");
    const res = await createAzureFoundryClient().interpret({ di: DI, blob });
    expect(() => JSON.parse(res.rawJson)).not.toThrow();
  }, 120_000); // real model inference
});
