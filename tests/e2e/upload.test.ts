/**
 * Manual upload intake (spec §4): a user uploads a document in the app and it is processed like
 * an emailed attachment — PDF or Excel, AR order or AP invoice. Via Fastify inject.
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { InMemoryPersistence } from "@coa/persistence";
import { InMemoryMasterDataReader, InMemoryInvoiceMasterReader } from "@coa/fabric-read";
import { buildServer } from "../../apps/api/src/server.js";
import { PipelineUploadProcessor } from "../../apps/api/src/upload.js";
import { ExcelExtractor, RoutingExtractor } from "../../apps/workers/src/extraction/index.js";
import { InMemoryInvoiceDedup } from "../../apps/workers/src/invoice/index.js";
import type { PipelineDeps } from "../../apps/workers/src/pipeline/pipeline.js";
import type { InvoicePipelineDeps } from "../../apps/workers/src/invoice/index.js";
import { InMemoryBlobStore } from "../../mocks/blob/in-memory-blob.js";
import { MockDocumentIntelligenceClient, MockFoundryClient } from "../../mocks/ai/mock-ai-clients.js";
import { SAMPLE_CUSTOMERS, SAMPLE_ITEMS } from "../../mocks/fabric/sample-masters.js";
import { SAMPLE_VENDORS, SAMPLE_PO_LINES, SAMPLE_RECEIPTS } from "../../mocks/fabric/sample-invoice-masters.js";

const PROC = { "x-dev-user": "proc1", "x-dev-roles": "OrderProcessor", "content-type": "application/json" };
const VIEWER = { "x-dev-user": "v1", "x-dev-roles": "Viewer", "content-type": "application/json" };

async function makeServer(excelBytes?: Uint8Array) {
  const orderPersistence = new InMemoryPersistence();
  const order: PipelineDeps = {
    blob: new InMemoryBlobStore(),
    persistence: orderPersistence,
    di: excelBytes
      ? new RoutingExtractor({ di: new MockDocumentIntelligenceClient(), excel: new ExcelExtractor({ resolveBytes: async () => excelBytes }) })
      : new MockDocumentIntelligenceClient(),
    foundry: new MockFoundryClient(),
    masters: new InMemoryMasterDataReader({ customers: SAMPLE_CUSTOMERS, items: SAMPLE_ITEMS }),
  };
  const invoicePersistence = new InMemoryPersistence();
  const invoice: InvoicePipelineDeps = {
    blob: new InMemoryBlobStore(),
    di: new MockDocumentIntelligenceClient(),
    foundry: new MockFoundryClient(),
    masters: new InMemoryInvoiceMasterReader({ vendors: SAMPLE_VENDORS, poLines: SAMPLE_PO_LINES, receipts: SAMPLE_RECEIPTS }),
    dedup: new InMemoryInvoiceDedup(),
    persistence: invoicePersistence,
  };
  const app = await buildServer({ graphClientState: "s", graph: { async enqueueMessageIds() {} }, uploads: new PipelineUploadProcessor({ order, invoice }), logger: false });
  return { app, orderPersistence, invoicePersistence };
}

const post = (app: Awaited<ReturnType<typeof makeServer>>["app"], headers: Record<string, string>, body: unknown) =>
  app.inject({ method: "POST", url: "/uploads", headers, payload: JSON.stringify(body) });

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("manual upload", () => {
  it("requires auth and a write role", async () => {
    const { app } = await makeServer();
    expect((await post(app, { "content-type": "application/json" }, { module: "ORDER_PROCESSING", filename: "x.pdf", contentBase64: b64("x") })).statusCode).toBe(401);
    expect((await post(app, VIEWER, { module: "ORDER_PROCESSING", filename: "x.pdf", contentBase64: b64("x") })).statusCode).toBe(403);
    await app.close();
  });

  it("validates the module and payload", async () => {
    const { app } = await makeServer();
    expect((await post(app, PROC, { filename: "x.pdf", contentBase64: b64("x") })).statusCode).toBe(400);
    expect((await post(app, PROC, { module: "WHATEVER", filename: "x.pdf", contentBase64: b64("x") })).statusCode).toBe(400);
    expect((await post(app, PROC, { module: "ORDER_PROCESSING", filename: "x.pdf" })).statusCode).toBe(400);
    await app.close();
  });

  it("uploads a customer PO (PDF) → processed to a READY order", async () => {
    const { app, orderPersistence } = await makeServer();
    const res = await post(app, PROC, { module: "ORDER_PROCESSING", filename: "sample-po-001.pdf", contentBase64: b64("pdf-bytes") });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ module: "ORDER_PROCESSING", internalState: "READY", reference: "PO100045" });
    expect(res.json().referenceId).not.toBeNull();
    expect(await orderPersistence.countOrders()).toBe(1);
    await app.close();
  });

  it("uploads a vendor invoice (PDF, AP) → processed invoice", async () => {
    const { app } = await makeServer();
    const res = await post(app, PROC, { module: "AP_INVOICE", filename: "sample-inv-po-001.pdf", contentBase64: b64("pdf-bytes") });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ module: "AP_INVOICE", internalState: "READY", reference: "INV5001" });
    await app.close();
  });

  it("uploads a customer PO sent as Excel → routed + processed", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("PO");
    [["PO Number", "PO-XL-7788"], ["Customer", "Acme Industrial Supply"], [], ["Item", "Description", "Qty", "UOM", "Unit Price"], ["ACM-778", "Hex Bolt", "500", "EA", "1.50"], ["ACM-902", "Washer", "1000", "EA", "0.50"]].forEach((r) => ws.addRow(r));
    const bytes = new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    const { app } = await makeServer(bytes);
    const res = await post(app, PROC, { module: "ORDER_PROCESSING", filename: "sample-po-xl-001.xlsx", contentBase64: Buffer.from(bytes).toString("base64") });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ module: "ORDER_PROCESSING", internalState: "READY", reference: "POXL7788" });
    await app.close();
  });
});
