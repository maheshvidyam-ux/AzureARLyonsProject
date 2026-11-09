/**
 * Phase 4 — reviewer workbench API (spec §13, §14). Queue, detail+evidence, role enforcement,
 * optimistic-concurrency edits (edits never lost), and approve/reject. Driven via Fastify
 * inject over the in-memory persistence seeded by the real pipeline.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryPersistence } from "@coa/persistence";
import { InMemoryMasterDataReader } from "@coa/fabric-read";
import { buildServer } from "../../apps/api/src/server.js";
import { processAttachment, type PipelineDeps } from "../../apps/workers/src/pipeline/pipeline.js";
import { InMemoryBlobStore } from "../../mocks/blob/in-memory-blob.js";
import { MockDocumentIntelligenceClient, MockFoundryClient } from "../../mocks/ai/mock-ai-clients.js";
import { SAMPLE_CUSTOMERS, SAMPLE_ITEMS } from "../../mocks/fabric/sample-masters.js";
import type { GraphMailMessage } from "../../apps/workers/src/pipeline/ports.js";

const PROC = { "x-dev-user": "proc1", "x-dev-roles": "OrderProcessor" };
const VIEWER = { "x-dev-user": "view1", "x-dev-roles": "Viewer" };

function mail(stem: string, id: string): GraphMailMessage {
  return { graphMessageId: `gm-${id}`, mailbox: "orders@x", sender: "buyer@acme.example.com", receivedAt: "2026-11-01T09:00:00Z", subject: "PO", attachments: [{ graphAttachmentId: `ga-${id}`, filename: `${stem}.pdf`, contentType: "application/pdf", contentBase64: Buffer.from(id).toString("base64") }] };
}

let app: FastifyInstance;
let persistence: InMemoryPersistence;
let orderId: string;

beforeEach(async () => {
  persistence = new InMemoryPersistence();
  const pipeline: PipelineDeps = {
    blob: new InMemoryBlobStore(),
    persistence,
    di: new MockDocumentIntelligenceClient(),
    foundry: new MockFoundryClient(),
    masters: new InMemoryMasterDataReader({ customers: SAMPLE_CUSTOMERS, items: SAMPLE_ITEMS }),
  };
  const r = await processAttachment(pipeline, mail("sample-po-002", "x"), 0); // NEEDS_REVIEW
  orderId = r.orderHeaderId!;
  app = await buildServer({ graphClientState: "s", graph: { async enqueueMessageIds() {} }, persistence, logger: false });
});

afterEach(async () => {
  await app.close();
});

describe("reviewer API", () => {
  it("requires authentication", async () => {
    expect((await app.inject({ method: "GET", url: "/orders" })).statusCode).toBe(401);
  });

  it("lists the queue and returns detail with an ETag", async () => {
    const list = await app.inject({ method: "GET", url: "/orders", headers: VIEWER });
    expect(list.statusCode).toBe(200);
    expect(list.json().orders.map((o: { id: string }) => o.id)).toContain(orderId);

    const detail = await app.inject({ method: "GET", url: `/orders/${orderId}`, headers: VIEWER });
    expect(detail.statusCode).toBe(200);
    expect(detail.headers.etag).toBe("0");
    expect(detail.json().header.internalState).toBe("NEEDS_REVIEW");
    expect(detail.json().lines.length).toBeGreaterThan(0);
  });

  it("forbids edits for a Viewer", async () => {
    const res = await app.inject({ method: "PATCH", url: `/orders/${orderId}`, headers: { ...VIEWER, "if-match": "0", "content-type": "application/json" }, payload: JSON.stringify({ header: { erpCustomerAccount: "ACME01" } }) });
    expect(res.statusCode).toBe(403);
  });

  it("requires If-Match for edits", async () => {
    const res = await app.inject({ method: "PATCH", url: `/orders/${orderId}`, headers: { ...PROC, "content-type": "application/json" }, payload: JSON.stringify({ header: { erpCustomerAccount: "ACME01" } }) });
    expect(res.statusCode).toBe(428);
  });

  it("applies an edit with optimistic concurrency and bumps the version", async () => {
    const res = await app.inject({ method: "PATCH", url: `/orders/${orderId}`, headers: { ...PROC, "if-match": "0", "content-type": "application/json" }, payload: JSON.stringify({ header: { erpCustomerAccount: "ACME01" } }) });
    expect(res.statusCode).toBe(200);
    expect(res.json().rowVersion).toBe(1);

    const detail = await app.inject({ method: "GET", url: `/orders/${orderId}`, headers: VIEWER });
    expect(detail.json().header.erpCustomerAccount).toBe("ACME01");
    expect(detail.json().header.rowVersion).toBe(1);
  });

  it("rejects a stale edit with 409 (edits never lost)", async () => {
    await app.inject({ method: "PATCH", url: `/orders/${orderId}`, headers: { ...PROC, "if-match": "0", "content-type": "application/json" }, payload: JSON.stringify({ header: { shipTo: "Dock 7" } }) });
    const stale = await app.inject({ method: "PATCH", url: `/orders/${orderId}`, headers: { ...PROC, "if-match": "0", "content-type": "application/json" }, payload: JSON.stringify({ header: { shipTo: "Dock 9" } }) });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().rowVersion).toBe(1);
  });

  it("approves an order (NEEDS_REVIEW → Ready)", async () => {
    const res = await app.inject({ method: "POST", url: `/orders/${orderId}/approve`, headers: { ...PROC, "if-match": "0" } });
    expect(res.statusCode).toBe(200);
    const detail = await app.inject({ method: "GET", url: `/orders/${orderId}`, headers: VIEWER });
    expect(detail.json().header.internalState).toBe("READY");
    expect(detail.json().header.simpleStatus).toBe("Ready");
  });

  it("rejects an order and 404s on an unknown id", async () => {
    const rej = await app.inject({ method: "POST", url: `/orders/${orderId}/reject`, headers: { ...PROC, "if-match": "0" } });
    expect(rej.statusCode).toBe(200);
    const detail = await app.inject({ method: "GET", url: `/orders/${orderId}`, headers: VIEWER });
    expect(detail.json().header.internalState).toBe("REJECTED");

    const missing = await app.inject({ method: "POST", url: `/orders/00000000-0000-0000-0000-000000000000/approve`, headers: { ...PROC, "if-match": "0" } });
    expect(missing.statusCode).toBe(404);
  });
});
