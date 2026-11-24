/**
 * Correction capture (learning dataset): a CSR edit to the CDM is recorded as field-level
 * (original → corrected) rows with the context the learning layer maps FROM — customer name for a
 * customer_match, item code/description for an item_match. Verified over in-memory persistence
 * seeded by the real pipeline (sample-po-002 ingests unmatched + zero-qty).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryPersistence } from "@coa/persistence";
import { InMemoryMasterDataReader } from "@coa/fabric-read";
import { processAttachment, type PipelineDeps } from "../../apps/workers/src/pipeline/pipeline.js";
import { InMemoryBlobStore } from "../../mocks/blob/in-memory-blob.js";
import { MockDocumentIntelligenceClient, MockFoundryClient } from "../../mocks/ai/mock-ai-clients.js";
import { SAMPLE_CUSTOMERS, SAMPLE_ITEMS } from "../../mocks/fabric/sample-masters.js";
import type { GraphMailMessage } from "../../apps/workers/src/pipeline/ports.js";

function mail(id: string): GraphMailMessage {
  return { graphMessageId: `gm-${id}`, mailbox: "orders@x", sender: "buyer@acme.example.com", receivedAt: "2026-11-01T09:00:00Z", subject: "PO", attachments: [{ graphAttachmentId: `ga-${id}`, filename: `sample-po-002.pdf`, contentType: "application/pdf", contentBase64: Buffer.from(id).toString("base64") }] };
}

let persistence: InMemoryPersistence;
let orderId: string;
let lineId: string;

beforeEach(async () => {
  persistence = new InMemoryPersistence();
  const pipeline: PipelineDeps = {
    blob: new InMemoryBlobStore(),
    persistence,
    di: new MockDocumentIntelligenceClient(),
    foundry: new MockFoundryClient(),
    masters: new InMemoryMasterDataReader({ customers: SAMPLE_CUSTOMERS, items: SAMPLE_ITEMS }),
  };
  const r = await processAttachment(pipeline, mail("cc"), 0);
  orderId = r.orderHeaderId!;
  const detail = await persistence.getOrderForReview(orderId);
  lineId = detail!.lines[0]!.lineId;
});

describe("correction capture", () => {
  it("records a customer_match correction with the extractor's customer name as context", async () => {
    const res = await persistence.updateOrderFields(orderId, 0, { header: { erpCustomerAccount: "ACME01" } }, "csr1");
    expect(res.status).toBe("OK");

    const corrections = await persistence.listCorrections({ kind: "customer_match" });
    expect(corrections).toHaveLength(1);
    const c = corrections[0]!;
    expect(c).toMatchObject({ entity: "header", fieldPath: "header.erp_customer_account", originalValue: null, correctedValue: "ACME01", kind: "customer_match", actor: "csr1" });
    // context carries what the model SAW → what the human chose (the learnable mapping).
    expect(c.context).toMatchObject({ customerName: "Unknown Buyer" });
  });

  it("records an item_match correction with the item code + ERP account context", async () => {
    await persistence.updateOrderFields(orderId, 0, { header: { erpCustomerAccount: "ACME01" }, lines: [{ lineId, erpItemId: "ITM-511" }] }, "csr1");
    const itemCorr = await persistence.listCorrections({ kind: "item_match" });
    expect(itemCorr).toHaveLength(1);
    expect(itemCorr[0]).toMatchObject({ entity: "line", lineId, fieldPath: "line.erp_item_id", correctedValue: "ITM-511", kind: "item_match" });
    expect(itemCorr[0]!.context).toMatchObject({ erpCustomerAccount: "ACME01", customerItemCode: "ACM-778" });
  });

  it("does not record a correction when a field is unchanged", async () => {
    const before = await persistence.getOrderForReview(orderId);
    await persistence.updateOrderFields(orderId, 0, { header: { currency: before!.header.currency } }, "csr1");
    expect(await persistence.listCorrections()).toHaveLength(0);
  });

  it("captures value corrections (quantity fix) distinct from match corrections", async () => {
    await persistence.updateOrderFields(orderId, 0, { lines: [{ lineId, quantity: 250 }] }, "csr1");
    const all = await persistence.listCorrections();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ fieldPath: "line.quantity", kind: "value", correctedValue: "250" });
  });
});
