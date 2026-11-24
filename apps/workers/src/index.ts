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
import { createFabricLakehouseReader, LearningAugmentedMasterReader, aliasOverlayFromRows, type MasterDataReader } from "@coa/fabric-read";
import { createAzureBlobStore } from "./storage/azure-blob-store.js";
import { createAzureDocumentIntelligenceClient, createDefaultExcelExtractor, RoutingExtractor } from "./extraction/index.js";
import { createAzureFoundryClient, FewShotCompleter } from "./interpretation/index.js";
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
  const resolveBytes = (ref: Parameters<typeof blob.download>[0]) => blob.download(ref);
  // Route by file type: PDF/image → Document Intelligence, Excel/CSV → spreadsheet extractor.
  const di = new RoutingExtractor({
    di: createAzureDocumentIntelligenceClient({ resolveBytes }),
    excel: createDefaultExcelExtractor({ resolveBytes }),
  });
  // Few-shot learning: recent reviewer corrections are injected into the interpretation prompt.
  const foundry = createAzureFoundryClient({
    wrapCompleter: (c) =>
      new FewShotCompleter(c, async () => {
        const rows = await persistence.listCorrections({ limit: 8 });
        return rows.map((r) => ({ field: r.fieldPath, from: r.originalValue, to: r.correctedValue, kind: r.kind }));
      }),
  });

  // Master matching + the atomic duplicate claim turn on when the Fabric Lakehouse masters are
  // configured (LAKEHOUSE_SQL_SERVER). Without it, matching is deferred (CUSTOMER_MATCH_DEFERRED).
  // The reader is wrapped with learned aliases (corrections overlaid onto the ERP masters).
  let masters: MasterDataReader | undefined;
  if (process.env.LAKEHOUSE_SQL_SERVER) {
    const base = await createFabricLakehouseReader();
    masters = new LearningAugmentedMasterReader(base, async (companyId) => aliasOverlayFromRows(await persistence.listLearnedAliases(companyId)));
    console.log("[worker] Fabric Lakehouse masters wired (with learned-alias overlay) — matching + duplicate claim enabled");
  }
  // With masters wired, straight-through orders auto-stage to the Boomi tables (Ready for pickup).
  const pipeline: PipelineDeps = { blob, persistence, di, foundry, ...(masters ? { masters, autoStage: true } : {}) };

  const worker = new IngestionWorker({ client: createDefaultGraphApiClient(), mailbox, pipeline });
  const queue = createServiceBusIngestionQueue();
  runIngestionConsumer(queue, worker);

  console.log(`[worker] consuming the ingestion queue for mailbox ${mailbox}`);
}

main().catch((err) => {
  console.error("Worker failed to start:", err);
  process.exitCode = 1;
});
