/**
 * Scheduled mailbox poll (one-shot) — the no-loss ingestion entrypoint a cron Container App Job runs
 * every few minutes. For each configured mailbox it delta-sweeps from the durable cursor and enqueues
 * new message ids (AR → `ingestion`, AP → `ingestion-ap`); the worker then fetches + processes them.
 * The cursor advances only after a mailbox's ids are enqueued, so a failure just re-fetches next run.
 *
 * Env: FABRIC_SQL_SERVER/DATABASE, SERVICEBUS_NAMESPACE, MAILBOX (AR) and/or AP_MAILBOX (AP),
 * optional INGESTION_QUEUE_NAME / AP_INGESTION_QUEUE_NAME. Entra auth throughout.
 */
import { createPool, fabricSqlConfigFromEnv, FabricSqlPersistence } from "@coa/persistence";
import { createServiceBusIngestionQueue, type IngestionPublisher } from "@coa/messaging";
import { createDefaultGraphApiClient, GraphMailboxSource } from "./graph/index.js";
import { PersistentDeltaStore } from "./persistent-delta-store.js";
import { pollMailboxOnce } from "./poll-runner.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

async function pollInto(label: string, mailbox: string, queue: IngestionPublisher, client: ReturnType<typeof createDefaultGraphApiClient>, deltaStore: PersistentDeltaStore): Promise<void> {
  try {
    const source = new GraphMailboxSource({ client, mailbox, deltaStore });
    const r = await pollMailboxOnce({ source, publish: (id) => queue.publish({ messageId: id }) });
    console.log(`[poll] ${label} ${mailbox}: enqueued ${r.enqueued}${r.committed ? " (cursor advanced)" : ""}`);
  } finally {
    await queue.close();
  }
}

async function main(): Promise<void> {
  const persistence = new FabricSqlPersistence(await createPool(fabricSqlConfigFromEnv()));
  const client = createDefaultGraphApiClient();
  const deltaStore = new PersistentDeltaStore(persistence);

  const arMailbox = process.env.MAILBOX;
  if (arMailbox) {
    await pollInto("AR", arMailbox, createServiceBusIngestionQueue(), client, deltaStore);
  }
  const apMailbox = process.env.AP_MAILBOX;
  if (apMailbox) {
    const apQueue = createServiceBusIngestionQueue({ fullyQualifiedNamespace: requireEnv("SERVICEBUS_NAMESPACE"), queueName: process.env.AP_INGESTION_QUEUE_NAME ?? "ingestion-ap" });
    await pollInto("AP", apMailbox, apQueue, client, deltaStore);
  }
  if (!arMailbox && !apMailbox) console.warn("[poll] neither MAILBOX nor AP_MAILBOX is set — nothing to poll");
}

main().catch((err) => {
  console.error("Poll failed to run:", err);
  process.exitCode = 1;
});
