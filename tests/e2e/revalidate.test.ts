/**
 * Revalidate (spec §7/§13): after a CSR corrects the CDM, re-running the SAME structural + master
 * matching rules must clear the now-resolved blocking findings and flip NEEDS_REVIEW → READY, with
 * optimistic concurrency. Driven via Fastify inject over the in-memory persistence seeded by the
 * real pipeline. `sample-po-002` ingests as NEEDS_REVIEW (unmatched customer + zero quantity).
 */
import { beforeEach, describe, expect, it } from "vitest";
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
const VIEWER = { "x-dev-user": "v1", "x-dev-roles": "Viewer" };
const JSONH = { "content-type": "application/json" };

function mail(stem: string, id: string): GraphMailMessage {
  return { graphMessageId: `gm-${id}`, mailbox: "orders@x", sender: "buyer@acme.example.com", receivedAt: "2026-11-01T09:00:00Z", subject: "PO", attachments: [{ graphAttachmentId: `ga-${id}`, filename: `${stem}.pdf`, contentType: "application/pdf", contentBase64: Buffer.from(id).toString("base64") }] };
}

let app: FastifyInstance;
let orderId: string;

beforeEach(async () => {
  const persistence = new InMemoryPersistence();
  const masters = new InMemoryMasterDataReader({ customers: SAMPLE_CUSTOMERS, items: SAMPLE_ITEMS });
  const pipeline: PipelineDeps = {
    blob: new InMemoryBlobStore(),
    persistence,
    di: new MockDocumentIntelligenceClient(),
    foundry: new MockFoundryClient(),
    masters,
  };
  const r = await processAttachment(pipeline, mail("sample-po-002", "rv"), 0); // NEEDS_REVIEW
  orderId = r.orderHeaderId!;
  app = await buildServer({ graphClientState: "s", graph: { async enqueueMessageIds() {} }, persistence, masters, logger: false });
});

const codes = (validation: Array<{ code: string }>) => validation.map((v) => v.code);

describe("revalidate", () => {
  it("enforces auth, write role and If-Match", async () => {
    expect((await app.inject({ method: "POST", url: `/orders/${orderId}/revalidate` })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `/orders/${orderId}/revalidate`, headers: { ...VIEWER, "if-match": "0" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/orders/${orderId}/revalidate`, headers: PROC })).statusCode).toBe(428);
  });

  it("clears resolved blocking findings and flips NEEDS_REVIEW → READY", async () => {
    const before = (await app.inject({ method: "GET", url: `/orders/${orderId}`, headers: VIEWER })).json();
    expect(before.header.internalState).toBe("NEEDS_REVIEW");
    expect(codes(before.validation)).toEqual(expect.arrayContaining(["CUSTOMER_UNMATCHED", "LINE_QUANTITY_INVALID"]));
    const lineId = before.lines[0].lineId;

    // CSR corrects: assign the ERP customer account + fix the zero quantity.
    const patch = await app.inject({ method: "PATCH", url: `/orders/${orderId}`, headers: { ...PROC, ...JSONH, "if-match": "0" }, payload: JSON.stringify({ header: { erpCustomerAccount: "ACME01" }, lines: [{ lineId, quantity: 100 }] }) });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().rowVersion).toBe(1);

    // Revalidate re-runs the rules against the corrected data.
    const rv = await app.inject({ method: "POST", url: `/orders/${orderId}/revalidate`, headers: { ...PROC, "if-match": "1" } });
    expect(rv.statusCode).toBe(200);
    expect(rv.json().internalState).toBe("READY");
    expect(rv.json().rowVersion).toBe(2);
    expect(codes(rv.json().findings)).not.toContain("CUSTOMER_UNMATCHED");
    expect(codes(rv.json().findings)).not.toContain("LINE_QUANTITY_INVALID");

    const after = (await app.inject({ method: "GET", url: `/orders/${orderId}`, headers: VIEWER })).json();
    expect(after.header.internalState).toBe("READY");
    expect(after.header.erpCustomerAccount).toBe("ACME01");
    expect(codes(after.validation)).not.toContain("CUSTOMER_UNMATCHED");
  });

  it("rejects a stale revalidate with 409", async () => {
    await app.inject({ method: "PATCH", url: `/orders/${orderId}`, headers: { ...PROC, ...JSONH, "if-match": "0" }, payload: JSON.stringify({ header: { shipTo: "Dock 7" } }) });
    const stale = await app.inject({ method: "POST", url: `/orders/${orderId}/revalidate`, headers: { ...PROC, "if-match": "0" } });
    expect(stale.statusCode).toBe(409);
  });

  it("refuses to revalidate a rejected (non-revalidatable) order", async () => {
    const rej = await app.inject({ method: "POST", url: `/orders/${orderId}/reject`, headers: { ...PROC, "if-match": "0" } });
    expect(rej.statusCode).toBe(200);
    const rv = await app.inject({ method: "POST", url: `/orders/${orderId}/revalidate`, headers: { ...PROC, "if-match": "1" } });
    expect(rv.statusCode).toBe(409);
    expect(rv.json().internalState).toBe("REJECTED");
  });
});
