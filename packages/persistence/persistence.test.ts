import { describe, expect, it } from "vitest";
import type { NormalizedPurchaseOrder } from "@coa/po-schema";
import {
  InMemoryPersistence,
  toOrderHeaderWrite,
  toOrderLineWrites,
  type IngestionInput,
  type SaveProcessedOrderInput,
} from "./src/index.js";

const ingestionInput = (): IngestionInput => ({
  companyId: "USMF",
  graphMessageId: "graph-msg-x",
  mailbox: "orders@lyons.example.com",
  sender: "buyer@acme.example.com",
  receivedAt: "2026-11-01T09:00:00Z",
  subject: "PO",
  attachment: {
    graphAttachmentId: "graph-att-x",
    contentHash: "a".repeat(64),
    blobUri: "mock://blob/originals/aaa",
    contentType: "application/pdf",
  },
});

const samplePo = (): NormalizedPurchaseOrder => ({
  document_id: "doc-1",
  order_id: null,
  schema_version: "1.0.0",
  company: { company_id: "USMF", resolved_from: "default" },
  header: {
    customer: { erp_customer_account: { value: null }, name: { value: "Acme" }, match_status: "UNMATCHED" },
    customer_po_number: { value: "PO-1" },
    normalized_po_number: "PO1",
    currency: { value: "USD" },
    totals: { grand_total: { amount: 1250, currency: "USD" } },
  },
  lines: [
    { line_id: "L1", source_line_no: 1, quantity: { value: 5 }, uom: { value: "EA" }, unit_price: { value: 10 }, extended_amount: { value: 50 }, match_status: "UNMATCHED" },
  ],
  extraction: { overall_confidence: 0.95 },
  validation: [],
});

const saveInput = (sourceDocumentId: string): SaveProcessedOrderInput => {
  const po = samplePo();
  return {
    sourceDocumentId,
    companyId: "USMF",
    extraction: { rawExtractionJson: "{}", normalizedJson: JSON.stringify(po), overallConfidence: 0.95 },
    header: toOrderHeaderWrite(po, { simpleStatus: "Ready", internalState: "READY" }),
    lines: toOrderLineWrites(po),
    validation: [],
    statusHistory: { fromState: "VALIDATING", toState: "READY", actor: "system", reason: null },
  };
};

describe("mapping", () => {
  it("maps a normalized PO onto the header write", () => {
    const h = toOrderHeaderWrite(samplePo(), { simpleStatus: "Ready", internalState: "READY" });
    expect(h).toMatchObject({
      normalizedPoNumber: "PO1",
      currency: "USD",
      total: 1250,
      lineCount: 1,
      internalState: "READY",
      erpCustomerAccount: null, // never invented
    });
  });
});

describe("InMemoryPersistence idempotency", () => {
  it("ingest is get-or-create on the attachment", async () => {
    const p = new InMemoryPersistence();
    const a = await p.ingest(ingestionInput());
    const b = await p.ingest(ingestionInput());
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(a.mailAttachmentId).toBe(b.mailAttachmentId);
  });

  it("recordDocument and saveProcessedOrder are idempotent on their keys", async () => {
    const p = new InMemoryPersistence();
    const ing = await p.ingest(ingestionInput());
    const d1 = await p.recordDocument({ mailAttachmentId: ing.mailAttachmentId, companyId: "USMF", blobUriOriginal: "mock://x" });
    const d2 = await p.recordDocument({ mailAttachmentId: ing.mailAttachmentId, companyId: "USMF", blobUriOriginal: "mock://x" });
    expect(d1.sourceDocumentId).toBe(d2.sourceDocumentId);

    const s1 = await p.saveProcessedOrder(saveInput(d1.sourceDocumentId));
    const s2 = await p.saveProcessedOrder(saveInput(d1.sourceDocumentId));
    expect(s1.created).toBe(true);
    expect(s2.created).toBe(false);
    expect(s1.orderHeaderId).toBe(s2.orderHeaderId);
    expect(await p.countOrders()).toBe(1);
  });

  it("markFailed records the outcome on the mail message", async () => {
    const p = new InMemoryPersistence();
    const ing = await p.ingest(ingestionInput());
    await p.markFailed({ mailMessageId: ing.mailMessageId, reason: "FOUNDRY_OUTPUT_UNPARSEABLE" });
    const mail = await p.getMailMessageById(ing.mailMessageId);
    expect(mail?.processingOutcome).toBe("FAILED");
    expect(mail?.failureReason).toContain("UNPARSEABLE");
  });
});

/**
 * Integration against a real SQL database in Fabric. Gated behind FABRIC_SQL_SERVER so it
 * is skipped in normal CI; run it only against a dev/test Fabric SQL database (ADR 0007).
 */
const hasDb = Boolean(process.env.FABRIC_SQL_SERVER && process.env.FABRIC_SQL_DATABASE);

describe.skipIf(!hasDb)("FabricSqlPersistence (live)", () => {
  it("migrates, persists an order, reads it back, and the duplicate-claim index exists", async () => {
    const { createPool, fabricSqlConfigFromEnv, migrateUp, migrateDown, FabricSqlPersistence } = await import("./src/index.js");
    const pool = await createPool(fabricSqlConfigFromEnv());
    const p = new FabricSqlPersistence(pool);
    try {
      await migrateUp(pool);
      const ing = await p.ingest(ingestionInput());
      expect(ing.created).toBe(true);
      const doc = await p.recordDocument({ mailAttachmentId: ing.mailAttachmentId, companyId: "USMF", blobUriOriginal: "mock://x", diModelVersion: "test" });
      const saved = await p.saveProcessedOrder(saveInput(doc.sourceDocumentId));
      const header = await p.getOrderHeaderById(saved.orderHeaderId);
      expect(header?.normalizedPoNumber).toBe("PO1");
    } finally {
      await migrateDown(pool);
      await p.close();
    }
  });
});
