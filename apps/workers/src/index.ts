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
import { createPool, fabricSqlConfigFromEnv, FabricSqlPersistence, type Persistence } from "@coa/persistence";
import { createServiceBusIngestionQueue } from "@coa/messaging";
import {
  createFabricLakehouseReader,
  LearningAugmentedMasterReader,
  aliasOverlayFromRows,
  createFabricInvoiceLakehouseReader,
  invoiceLakehouseConfigFrom,
  type InvoiceLakehouseConfig,
  type MasterDataReader,
} from "@coa/fabric-read";
import { createAzureBlobStore } from "./storage/azure-blob-store.js";
import { createAzureDocumentIntelligenceClient, createDefaultExcelExtractor, RoutingExtractor } from "./extraction/index.js";
import { createAzureFoundryClient, FewShotCompleter } from "./interpretation/index.js";
import { createDefaultGraphApiClient, IngestionWorker, InvoiceIngestionWorker, runIngestionConsumer } from "./ingestion/index.js";
import { PersistenceInvoiceDedup, type InvoicePipelineDeps } from "./invoice/index.js";
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
  console.log(`[worker] consuming the AR ingestion queue for mailbox ${mailbox}`);

  // AP vendor invoices — a SEPARATE mailbox + queue (spec: separate AR/AP mailboxes). Enabled when
  // AP_MAILBOX + the Lakehouse are configured. The invoice-master reader is built from the admin
  // connection config (app_config), so the Settings screen drives which vendor/PO tables are read.
  if (process.env.AP_MAILBOX && process.env.LAKEHOUSE_SQL_SERVER) {
    const apMailbox = process.env.AP_MAILBOX;
    const invoiceMasters = await createFabricInvoiceLakehouseReader(await invoiceConfigFromStored(persistence));
    // ⚠️ TODO: invoice extraction wants a prebuilt-invoice DI model + an invoice Foundry prompt.
    // Reusing the order `di`/`foundry` here is a placeholder until createAzureInvoiceFoundryClient lands.
    const invoicePipeline: InvoicePipelineDeps = { blob, di, foundry, masters: invoiceMasters, dedup: new PersistenceInvoiceDedup(persistence), persistence, autoStage: true };
    const invoiceWorker = new InvoiceIngestionWorker({ client: createDefaultGraphApiClient(), mailbox: apMailbox, pipeline: invoicePipeline });
    const apQueue = createServiceBusIngestionQueue({ fullyQualifiedNamespace: requireEnv("SERVICEBUS_NAMESPACE"), queueName: process.env.AP_INGESTION_QUEUE_NAME ?? "ingestion-ap" });
    runIngestionConsumer(apQueue, invoiceWorker);
    console.log(`[worker] consuming the AP ingestion queue for mailbox ${apMailbox}`);
  }
}

/** Build the invoice-master Lakehouse config from the stored connection settings; undefined → defaults. */
async function invoiceConfigFromStored(persistence: Persistence): Promise<InvoiceLakehouseConfig | undefined> {
  try {
    const row = await persistence.getConfig("connections");
    if (!row) return undefined;
    const lk = (JSON.parse(row.value) as { lakehouse?: Partial<Record<"vendorTable" | "vendorAccountColumn" | "vendorNameColumn" | "poTable" | "poNumberColumn" | "poVendorColumn", string>> }).lakehouse;
    if (lk?.vendorTable && lk.poTable) {
      return invoiceLakehouseConfigFrom({
        vendorTable: lk.vendorTable,
        vendorAccountColumn: lk.vendorAccountColumn ?? "vendaccount",
        vendorNameColumn: lk.vendorNameColumn ?? "name",
        poTable: lk.poTable,
        poNumberColumn: lk.poNumberColumn ?? "purchid",
        poVendorColumn: lk.poVendorColumn ?? "orderaccount",
      });
    }
  } catch {
    // fall back to the default invoice config
  }
  return undefined;
}

main().catch((err) => {
  console.error("Worker failed to start:", err);
  process.exitCode = 1;
});
