/**
 * Phase 2 — ingestion worker (spec §4). Closes the loop: webhook → `ingestion` queue → worker
 * fetches attachments via Graph → pipeline → persisted orders. Runs on in-memory queue +
 * persistence + the fake Graph client; no Service Bus, no live mailbox.
 */
import { describe, expect, it } from "vitest";
import { InMemoryPersistence } from "@coa/persistence";
import { InMemoryIngestionQueue } from "@coa/messaging";
import { IngestionWorker } from "../../apps/workers/src/ingestion/ingestion-worker.js";
import { FakeGraphApiClient } from "../../mocks/graph/fake-graph-api.js";
import { InMemoryBlobStore } from "../../mocks/blob/in-memory-blob.js";
import { MockDocumentIntelligenceClient, MockFoundryClient } from "../../mocks/ai/mock-ai-clients.js";
import { buildServer } from "../../apps/api/src/server.js";
import type { PipelineDeps } from "../../apps/workers/src/pipeline/pipeline.js";

const MAILBOX = "orders@lyons.example.com";

function makeWorker() {
  const persistence = new InMemoryPersistence();
  const pipeline: PipelineDeps = {
    blob: new InMemoryBlobStore(),
    persistence,
    di: new MockDocumentIntelligenceClient(),
    foundry: new MockFoundryClient(),
  };
  const worker = new IngestionWorker({ client: new FakeGraphApiClient(), mailbox: MAILBOX, pipeline });
  return { worker, persistence };
}

describe("IngestionWorker", () => {
  it("drains queued message ids into persisted orders", async () => {
    const { worker, persistence } = makeWorker();
    const queue = new InMemoryIngestionQueue();
    await queue.publish({ messageId: "msg-001" });
    await queue.publish({ messageId: "msg-002" });

    const outcomes = await worker.drain(queue);

    expect(outcomes.map((o) => o.messageId)).toEqual(["msg-001", "msg-002"]);
    expect(outcomes.every((o) => !o.error)).toBe(true);
    expect(outcomes[0]!.results[0]!.decision).toBe("READY");
    expect(outcomes[1]!.results[0]!.decision).toBe("NEEDS_REVIEW");
    expect(await persistence.countOrders()).toBe(2);
    expect(queue.depth).toBe(0);
  });

  it("is idempotent: handling the same message id twice creates one order", async () => {
    const { worker, persistence } = makeWorker();
    const a = await worker.handleMessageId("msg-001");
    const b = await worker.handleMessageId("msg-001");
    expect(a.results[0]!.orderHeaderId).toBe(b.results[0]!.orderHeaderId);
    expect(await persistence.countOrders()).toBe(1);
  });

  it("isolates a failing message: a bad id is recorded as an error, others still process", async () => {
    const { worker, persistence } = makeWorker();
    const queue = new InMemoryIngestionQueue();
    await queue.publish({ messageId: "msg-unknown" }); // getMessage throws (404)
    await queue.publish({ messageId: "msg-001" });

    const outcomes = await worker.drain(queue);

    const failed = outcomes.find((o) => o.messageId === "msg-unknown");
    expect(failed?.error).toMatch(/404/);
    expect(failed?.results).toHaveLength(0);
    expect(await persistence.countOrders()).toBe(1); // msg-001 still landed
  });

  it("end-to-end: webhook enqueues → worker drains → orders persisted", async () => {
    const { worker, persistence } = makeWorker();
    const queue = new InMemoryIngestionQueue();
    const CLIENT_STATE = "secret";

    const app = await buildServer({
      graphClientState: CLIENT_STATE,
      graph: {
        async enqueueMessageIds(ids) {
          for (const id of ids) await queue.publish({ messageId: id });
        },
      },
      logger: false,
    });

    const res = await app.inject({
      method: "POST",
      url: "/integration/graph/notifications",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        value: [
          { clientState: CLIENT_STATE, resourceData: { id: "msg-001" } },
          { clientState: CLIENT_STATE, resourceData: { id: "msg-002" } },
        ],
      }),
    });
    await app.close();

    expect(res.statusCode).toBe(202);
    expect(queue.depth).toBe(2);

    await worker.drain(queue);
    expect(await persistence.countOrders()).toBe(2);
  });
});
