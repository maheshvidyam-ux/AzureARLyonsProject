/**
 * AP invoice reviewer API — queue, detail (+3-way/C&A + validation + ETag), optimistic edits incl.
 * GL coding, and approve/reject (APPROVE stages to staging_vendor_invoice). A Non-PO invoice cannot
 * be approved until its Code-&-Approve line is GL-coded. Seeded by the real invoice pipeline.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryPersistence } from "@coa/persistence";
import { InMemoryInvoiceMasterReader } from "@coa/fabric-read";
import { buildServer } from "../../apps/api/src/server.js";
import { InMemoryInvoiceDedup, processInvoice, type InvoicePipelineDeps } from "../../apps/workers/src/invoice/index.js";
import { InMemoryBlobStore } from "../../mocks/blob/in-memory-blob.js";
import { MockDocumentIntelligenceClient, MockFoundryClient } from "../../mocks/ai/mock-ai-clients.js";
import { SAMPLE_VENDORS, SAMPLE_PO_LINES, SAMPLE_RECEIPTS } from "../../mocks/fabric/sample-invoice-masters.js";
import type { GraphMailMessage } from "../../apps/workers/src/pipeline/ports.js";

const PROC = { "x-dev-user": "proc1", "x-dev-roles": "OrderProcessor" };
const VIEWER = { "x-dev-user": "v1", "x-dev-roles": "Viewer" };
const JSONH = { "content-type": "application/json" };

const mail = (stem: string, id: string): GraphMailMessage => ({
  graphMessageId: `gm-${id}`, mailbox: "ap-invoices@lyons", sender: "ap@acme.example.com", receivedAt: "2026-11-02T09:00:00Z", subject: "Invoice",
  attachments: [{ graphAttachmentId: `ga-${id}`, filename: `${stem}.pdf`, contentType: "application/pdf", contentBase64: Buffer.from(id).toString("base64") }],
});

let app: FastifyInstance;
let persistence: InMemoryPersistence;

beforeEach(async () => {
  persistence = new InMemoryPersistence();
  const deps: InvoicePipelineDeps = {
    blob: new InMemoryBlobStore(),
    di: new MockDocumentIntelligenceClient(),
    foundry: new MockFoundryClient(),
    masters: new InMemoryInvoiceMasterReader({ vendors: SAMPLE_VENDORS, poLines: SAMPLE_PO_LINES, receipts: SAMPLE_RECEIPTS }),
    dedup: new InMemoryInvoiceDedup(),
    persistence,
  };
  await processInvoice(deps, mail("sample-inv-po-001", "po"), 0); // PO-based → READY
  await processInvoice(deps, mail("sample-inv-nonpo-001", "np"), 0); // Non-PO → NEEDS_REVIEW (C&A)
  app = await buildServer({ graphClientState: "s", graph: { async enqueueMessageIds() {} }, persistence, logger: false });
});

async function nonPoId(): Promise<string> {
  const list = (await app.inject({ method: "GET", url: "/invoices?type=NON_PO", headers: VIEWER })).json().invoices;
  return list[0].id;
}

describe("invoice reviewer API", () => {
  it("lists the invoice queue and returns detail with an ETag", async () => {
    expect((await app.inject({ method: "GET", url: "/invoices" })).statusCode).toBe(401);
    const list = await app.inject({ method: "GET", url: "/invoices", headers: VIEWER });
    expect(list.statusCode).toBe(200);
    expect(list.json().invoices).toHaveLength(2);

    const id = await nonPoId();
    const detail = await app.inject({ method: "GET", url: `/invoices/${id}`, headers: VIEWER });
    expect(detail.statusCode).toBe(200);
    expect(detail.headers.etag).toBe("0");
    expect(detail.json().header.invoiceType).toBe("NON_PO");
    expect(detail.json().lines.some((l: { isCodeAndApprove: boolean }) => l.isCodeAndApprove)).toBe(true);
    expect(detail.json().validation.some((v: { code: string }) => v.code === "GL_CODE_REQUIRED")).toBe(true);
  });

  it("enforces role + If-Match on edits", async () => {
    const id = await nonPoId();
    expect((await app.inject({ method: "PATCH", url: `/invoices/${id}`, headers: { ...VIEWER, ...JSONH, "if-match": "0" }, payload: JSON.stringify({ header: { currency: "USD" } }) })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: `/invoices/${id}`, headers: { ...PROC, ...JSONH }, payload: JSON.stringify({ header: { currency: "USD" } }) })).statusCode).toBe(428);
  });

  it("GL-codes a Non-PO C&A line then approves → staged (blocked until coded)", async () => {
    const id = await nonPoId();
    const detail = (await app.inject({ method: "GET", url: `/invoices/${id}`, headers: VIEWER })).json();
    const caLine = detail.lines.find((l: { isCodeAndApprove: boolean }) => l.isCodeAndApprove);

    // Approve before coding is refused.
    expect((await app.inject({ method: "POST", url: `/invoices/${id}/approve`, headers: { ...PROC, "if-match": "0" } })).statusCode).toBe(409);

    // Assign a GL account.
    const patch = await app.inject({ method: "PATCH", url: `/invoices/${id}`, headers: { ...PROC, ...JSONH, "if-match": "0" }, payload: JSON.stringify({ lines: [{ lineId: caLine.lineId, glAccount: "6100" }] }) });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().rowVersion).toBe(1);

    // Now approve → staged for Boomi.
    const appr = await app.inject({ method: "POST", url: `/invoices/${id}/approve`, headers: { ...PROC, "if-match": "1" } });
    expect(appr.statusCode).toBe(200);
    const after = (await app.inject({ method: "GET", url: `/invoices/${id}`, headers: VIEWER })).json();
    expect(after.header.internalState).toBe("STAGED");
    expect((await persistence.listVendorInvoicesForBoomi()).length).toBe(1); // only the approved Non-PO (po-001 is READY, not auto-staged here)
  });

  it("rejects a stale edit with 409", async () => {
    const id = await nonPoId();
    await app.inject({ method: "PATCH", url: `/invoices/${id}`, headers: { ...PROC, ...JSONH, "if-match": "0" }, payload: JSON.stringify({ header: { invoiceNumber: "X" } }) });
    const stale = await app.inject({ method: "PATCH", url: `/invoices/${id}`, headers: { ...PROC, ...JSONH, "if-match": "0" }, payload: JSON.stringify({ header: { invoiceNumber: "Y" } }) });
    expect(stale.statusCode).toBe(409);
  });
});
