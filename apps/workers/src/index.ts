/**
 * Workers entrypoint (Container App). Consumes the Service Bus `ingestion` queue and runs the
 * full pipeline against live Azure services:
 *   Graph (fetch message + attachments) → Blob (store original) → Document Intelligence →
 *   AI Foundry → normalize + validate → persist to SQL database in Fabric → stop before staging.
 *
 * All clients use Entra auth (managed identity in Azure). Required env:
 *   MAILBOX, SERVICEBUS_NAMESPACE, BLOB_ACCOUNT_URL, FABRIC_SQL_SERVER, FABRIC_SQL_DATABASE,
 *   DOC_INTEL_ENDPOINT, AI_FOUNDRY_ENDPOINT, AI_FOUNDRY_DEPLOYMENT.
 */
import { createPool, fabricSqlConfigFromEnv, FabricSqlPersistence } from "@coa/persistence";
import { createServiceBusIngestionQueue } from "@coa/messaging";
import { createAzureBlobStore } from "./storage/azure-blob-store.js";
import { createAzureDocumentIntelligenceClient } from "./extraction/index.js";
import { createAzureFoundryClient } from "./interpretation/index.js";
import { createDefaultGraphApiClient, IngestionWorker, runIngestionConsumer } from "./ingestion/index.js";
import type { PipelineDeps } from "./pipeline/index.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

async function main(): Promise<void> {
  const mailbox = requireEnv("MAILBOX");

  const blob = createAzureBlobStore();
  const persistence = new FabricSqlPersistence(await createPool(fabricSqlConfigFromEnv()));
  const di = createAzureDocumentIntelligenceClient({ resolveBytes: (ref) => blob.download(ref) });
  const foundry = createAzureFoundryClient();

  // NOTE: customer/item master matching + the duplicate claim are wired in the pipeline but need
  // the real Fabric read adapter (Q-FAB-1), which is not built yet — so `masters` is omitted and
  // matching is deferred (orders land with CUSTOMER_MATCH_DEFERRED) until that adapter exists.
  const pipeline: PipelineDeps = { blob, persistence, di, foundry };

  const worker = new IngestionWorker({ client: createDefaultGraphApiClient(), mailbox, pipeline });
  const queue = createServiceBusIngestionQueue();
  runIngestionConsumer(queue, worker);

  console.log(`[worker] consuming the ingestion queue for mailbox ${mailbox}`);
}

main().catch((err) => {
  console.error("Worker failed to start:", err);
  process.exitCode = 1;
});
