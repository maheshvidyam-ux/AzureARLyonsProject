/**
 * Scheduled delta-poll ingestion (no-loss). A poll sweeps new message ids from the durable cursor,
 * enqueues them, and advances the cursor only after enqueue. Proven here:
 *  - new messages are enqueued and the cursor advances (next poll returns nothing new),
 *  - if the enqueue FAILS, the cursor does NOT advance, so the next poll re-fetches them — no loss,
 *  - the cursor survives across GraphMailboxSource instances (persisted in app_config).
 */
import { describe, expect, it } from "vitest";
import { InMemoryPersistence } from "@coa/persistence";
import { GraphMailboxSource, PersistentDeltaStore, pollMailboxOnce } from "../../apps/workers/src/ingestion/index.js";
import { FakeGraphApiClient } from "../../mocks/graph/fake-graph-api.js";

const MAILBOX = "orders@lyons.example.com";

function source(persistence: InMemoryPersistence): GraphMailboxSource {
  return new GraphMailboxSource({ client: new FakeGraphApiClient(), mailbox: MAILBOX, deltaStore: new PersistentDeltaStore(persistence) });
}

describe("scheduled delta-poll ingestion", () => {
  it("enqueues new message ids and advances the cursor; a second poll finds nothing new", async () => {
    const persistence = new InMemoryPersistence();
    const enqueued: string[] = [];
    const publish = async (id: string) => void enqueued.push(id);

    const first = await pollMailboxOnce({ source: source(persistence), publish });
    expect(first.enqueued).toBe(2); // msg-001 + msg-002 (both have attachments; msg-no-att skipped)
    expect(enqueued).toEqual(["msg-001", "msg-002"]);
    expect(first.committed).toBe(true);

    // A fresh source reads the SAME persisted cursor → incremental re-run returns nothing new.
    const second = await pollMailboxOnce({ source: source(persistence), publish });
    expect(second.enqueued).toBe(0);
    expect(enqueued).toEqual(["msg-001", "msg-002"]); // unchanged
  });

  it("NO LOSS: a failed enqueue leaves the cursor unadvanced, so the next poll re-fetches", async () => {
    const persistence = new InMemoryPersistence();
    const cursorKey = `${MAILBOX}::Inbox`;
    const store = new PersistentDeltaStore(persistence);

    // Poll 1: enqueue throws on the first id → pollMailboxOnce rejects, cursor never committed.
    await expect(pollMailboxOnce({ source: source(persistence), publish: async () => { throw new Error("Service Bus down"); } })).rejects.toThrow("Service Bus down");
    expect(await store.get(cursorKey)).toBeNull(); // cursor NOT advanced

    // Poll 2: Service Bus is back → the same messages are re-fetched (nothing was lost) and enqueued.
    const enqueued: string[] = [];
    const ok = await pollMailboxOnce({ source: source(persistence), publish: async (id) => void enqueued.push(id) });
    expect(enqueued).toEqual(["msg-001", "msg-002"]);
    expect(ok.committed).toBe(true);
    expect(await store.get(cursorKey)).not.toBeNull(); // now advanced
  });
});
