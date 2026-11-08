/**
 * Phase 2 — API Graph webhook route (spec §4). Driven via Fastify `inject` (no network): the
 * validation handshake, clientState-verified enqueue, lifecycle surfacing, and health endpoints.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../apps/api/src/server.js";
import type { GraphNotificationSink } from "../../apps/api/src/types.js";

const CLIENT_STATE = "s3cret-state";
const URL = "/integration/graph/notifications";

let app: FastifyInstance;
let enqueued: string[][];
let lifecycle: Array<Array<{ subscriptionId?: string; event: string }>>;

beforeEach(async () => {
  enqueued = [];
  lifecycle = [];
  const graph: GraphNotificationSink = {
    async enqueueMessageIds(ids) {
      enqueued.push(ids);
    },
    async onLifecycleEvents(events) {
      lifecycle.push(events);
    },
  };
  app = await buildServer({ graphClientState: CLIENT_STATE, graph, logger: false });
});

afterEach(async () => {
  await app.close();
});

const postJson = (payload: unknown) =>
  app.inject({ method: "POST", url: URL, headers: { "content-type": "application/json" }, payload: JSON.stringify(payload) });

describe("Graph webhook", () => {
  it("echoes the validation token as text/plain (subscription handshake)", async () => {
    const res = await app.inject({ method: "POST", url: `${URL}?validationToken=abc%20123` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toBe("abc 123"); // query is URL-decoded
    expect(enqueued).toHaveLength(0);
  });

  it("enqueues only clientState-verified message ids and 202s", async () => {
    const res = await postJson({
      value: [
        { clientState: CLIENT_STATE, resourceData: { id: "m1" } },
        { clientState: "WRONG", resourceData: { id: "spoofed" } },
        { clientState: CLIENT_STATE, resource: "Users/u1/Messages/m2" },
      ],
    });
    expect(res.statusCode).toBe(202);
    expect(enqueued).toEqual([["m1", "m2"]]);
  });

  it("surfaces lifecycle events and does not enqueue them", async () => {
    const res = await postJson({ value: [{ lifecycleEvent: "reauthorizationRequired", subscriptionId: "sub-1" }] });
    expect(res.statusCode).toBe(202);
    expect(lifecycle).toEqual([[{ subscriptionId: "sub-1", event: "reauthorizationRequired" }]]);
    expect(enqueued).toHaveLength(0);
  });

  it("202s with no enqueue when every notification fails verification", async () => {
    const res = await postJson({ value: [{ clientState: "nope", resourceData: { id: "x" } }] });
    expect(res.statusCode).toBe(202);
    expect(enqueued).toHaveLength(0);
  });
});

describe("health", () => {
  it("GET /health and /ready return ok", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ status: "ok" });
    expect((await app.inject({ method: "GET", url: "/ready" })).json()).toEqual({ status: "ready" });
  });

  it("GET /metrics exposes a prometheus gauge", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("process_uptime_seconds");
  });
});
