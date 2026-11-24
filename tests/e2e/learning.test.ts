/**
 * The learning loop (correction memory + few-shot).
 *
 * 1. Alias memory (deterministic): a CSR corrects an unmatched customer ONCE; the system overlays
 *    that as an alias on the ERP masters, so the SAME customer on the NEXT document auto-matches —
 *    the correction stops recurring. This is the core of "a learning system that gets better".
 * 2. Few-shot (soft): recent corrections are injected into the interpretation prompt.
 */
import { describe, expect, it } from "vitest";
import { InMemoryPersistence } from "@coa/persistence";
import { InMemoryMasterDataReader, LearningAugmentedMasterReader, aliasOverlayFromRows } from "@coa/fabric-read";
import { processAttachment, type PipelineDeps } from "../../apps/workers/src/pipeline/pipeline.js";
import { FewShotCompleter, type ChatCompleter } from "../../apps/workers/src/interpretation/index.js";
import { InMemoryBlobStore } from "../../mocks/blob/in-memory-blob.js";
import { MockDocumentIntelligenceClient, MockFoundryClient } from "../../mocks/ai/mock-ai-clients.js";
import { SAMPLE_CUSTOMERS, SAMPLE_ITEMS } from "../../mocks/fabric/sample-masters.js";
import type { GraphMailMessage } from "../../apps/workers/src/pipeline/ports.js";

function mail(id: string): GraphMailMessage {
  return { graphMessageId: `gm-${id}`, mailbox: "orders@x", sender: "buyer@acme.example.com", receivedAt: "2026-11-01T09:00:00Z", subject: "PO", attachments: [{ graphAttachmentId: `ga-${id}`, filename: "sample-po-002.pdf", contentType: "application/pdf", contentBase64: Buffer.from(id).toString("base64") }] };
}
const codes = (fs: Array<{ code: string }>) => fs.map((f) => f.code);

describe("learned-alias memory", () => {
  it("auto-matches a customer on the second document after one correction", async () => {
    const persistence = new InMemoryPersistence();
    const masters = new LearningAugmentedMasterReader(
      new InMemoryMasterDataReader({ customers: SAMPLE_CUSTOMERS, items: SAMPLE_ITEMS }),
      async (companyId) => aliasOverlayFromRows(await persistence.listLearnedAliases(companyId)),
    );
    const deps: PipelineDeps = { blob: new InMemoryBlobStore(), persistence, di: new MockDocumentIntelligenceClient(), foundry: new MockFoundryClient(), masters };

    // Document A: "Unknown Buyer" is not in the masters → CUSTOMER_UNMATCHED.
    const a = await processAttachment(deps, mail("A"), 0);
    expect(codes(a.findings)).toContain("CUSTOMER_UNMATCHED");

    // CSR teaches the system: this buyer is ACME01.
    const detail = await persistence.getOrderForReview(a.orderHeaderId!);
    await persistence.updateOrderFields(a.orderHeaderId!, detail!.header.rowVersion, { header: { erpCustomerAccount: "ACME01" } }, "csr1");
    const aliases = await persistence.listLearnedAliases("USMF");
    expect(aliases).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "customer", text: "Unknown Buyer", erpCustomerAccount: "ACME01" })]));

    // Document B: SAME buyer, new document → now matches automatically (no human needed for the customer).
    const b = await processAttachment(deps, mail("B"), 0);
    expect(codes(b.findings)).not.toContain("CUSTOMER_UNMATCHED");
    expect(b.normalized?.header.customer?.erp_customer_account?.value).toBe("ACME01");
    expect(b.normalized?.header.customer?.match_status).toBe("ALIAS");
  });
});

describe("learning-augmented reader overlay", () => {
  it("adds learned item codes to the item's per-customer codes", async () => {
    const base = new InMemoryMasterDataReader({ customers: SAMPLE_CUSTOMERS, items: SAMPLE_ITEMS });
    const overlay = aliasOverlayFromRows([{ kind: "item", text: "WIDGET-9", erpCustomerAccount: "ACME01", erpItemId: "ITM-511" }]);
    const reader = new LearningAugmentedMasterReader(base, async () => overlay);
    const items = await reader.findItems("USMF");
    const target = items.find((i) => i.erpItemId === "ITM-511");
    expect(target?.customerItemCodes?.ACME01).toContain("WIDGET-9");
  });
});

describe("few-shot completer", () => {
  it("prepends recent corrections as guidance before delegating", async () => {
    let seen: Array<{ role: string; content: string }> = [];
    const fake: ChatCompleter = { async complete(input) { seen = input.messages; return { content: "{}" }; } };
    const completer = new FewShotCompleter(fake, async () => [{ field: "header.customer_po_number", from: "PO 100", to: "PO-100", kind: "format" }]);
    await completer.complete({ messages: [{ role: "user", content: "doc" }], deployment: "d" });
    expect(seen[0]?.role).toBe("system");
    expect(seen[0]?.content).toContain("LEARNED CORRECTIONS");
    expect(seen[0]?.content).toContain("PO-100");
  });

  it("passes through unchanged when there are no hints", async () => {
    let count = 1;
    const fake: ChatCompleter = { async complete(input) { count = input.messages.length; return { content: "{}" }; } };
    await new FewShotCompleter(fake, async () => []).complete({ messages: [{ role: "user", content: "doc" }], deployment: "d" });
    expect(count).toBe(1);
  });
});
