/**
 * Phase 2 — Service Bus ingestion adapter (spec §2, §6.3). The consumer bridge semantics
 * (success → settle/complete, failure → throw → abandon/DLQ) are tested with a fake processor;
 * the real `ServiceBusIngestionQueue` is covered by a SERVICEBUS_NAMESPACE-gated live test.
 */
import { describe, expect, it } from "vitest";
import { InMemoryPersistence } from "@coa/persistence";
import type {
  IngestionHandler,
  IngestionMessage,
  IngestionProcessor,
  IngestionSubscription,
} from "@coa/messaging";
import { IngestionWorker } from "../../apps/workers/src/ingestion/ingestion-worker.js";
import { runIngestionConsumer } from "../../apps/workers/src/ingestion/consumer.js";
import { resolveIngestionPublisher } from "../../apps/api/src/publisher.js";
import { FakeGraphApiClient } from "../../mocks/graph/fake-graph-api.js";
import { InMemoryBlobStore } from "../../mocks/blob/in-memory-blob.js";
import { MockDocumentIntelligenceClient, MockFoundryClient } from "../../mocks/ai/mock-ai-clients.js";

/** Fake processor that records which deliveries completed (handler resolved) vs failed (threw). */
class FakeProcessor implements IngestionProcessor {
  private handler?: IngestionHandler;
  public completed: string[] = [];
  public failed: Array<{ id: string; error: string }> = [];

  subscribe(handler: IngestionHandler): IngestionSubscription {
    this.handler = handler;
    return { close: async () => {} };
  }
  async deliver(messages: IngestionMessage[]): Promise<void> {
    for (const m of messages) {
      try {
        await this.handler!(m);
        this.completed.push(m.messageId); // would auto-complete on Service Bus
      } catch (e) {
        this.failed.push({ id: m.messageId, error: (e as Error).message }); // would abandon → DLQ
      }
    }
  }
  async close(): Promise<void> {}
}

function makeWorker() {
  const persistence = new InMemoryPersistence();
  const worker = new IngestionWorker({
    client: new FakeGraphApiClient(),
    mailbox: "orders@lyons.example.com",
    pipeline: { blob: new InMemoryBlobStore(), persistence, di: new MockDocumentIntelligenceClient(), foundry: new MockFoundryClient() },
  });
  return { worker, persistence };
}

describe("ingestion consumer bridge", () => {
  it("completes clean messages and throws (→abandon/DLQ) on failures; good ones still persist", async () => {
    const { worker, persistence } = makeWorker();
    const proc = new FakeProcessor();
    runIngestionConsumer(proc, worker);

    await proc.deliver([{ messageId: "msg-001" }, { messageId: "msg-unknown" }, { messageId: "msg-002" }]);

    expect(proc.completed).toEqual(["msg-001", "msg-002"]);
    expect(proc.failed.map((f) => f.id)).toEqual(["msg-unknown"]);
    expect(proc.failed[0]!.error).toMatch(/ingestion failed for message msg-unknown/);
    expect(await persistence.countOrders()).toBe(2);
  });
});

describe("resolveIngestionPublisher", () => {
  it("returns a no-op stub when Service Bus is not configured (no ServiceBusClient built)", async () => {
    const pub = resolveIngestionPublisher({} as NodeJS.ProcessEnv);
    await expect(pub.publish({ messageId: "x" })).resolves.toBeUndefined();
    await pub.close();
  });
});

/**
 * Live Service Bus round-trip. Gated behind SERVICEBUS_NAMESPACE; requires a queue named
 * `ingestion` (or INGESTION_QUEUE_NAME) and Data Sender/Receiver rights via Entra.
 */
const hasSb = Boolean(process.env.SERVICEBUS_NAMESPACE);
describe.skipIf(!hasSb)("ServiceBusIngestionQueue (live)", () => {
  it("publishes a message and the subscriber receives it", async () => {
    const { createServiceBusIngestionQueue } = await import("@coa/messaging");
    const queue = createServiceBusIngestionQueue();
    const received: string[] = [];
    const id = "live-smoke-fixed-id";
    const sub = queue.subscribe(async (m) => {
      received.push(m.messageId);
    });
    try {
      await queue.publish({ messageId: id });
      await new Promise((r) => setTimeout(r, 5000));
      expect(received).toContain(id);
    } finally {
      await sub.close();
      await queue.close();
    }
  });
});
