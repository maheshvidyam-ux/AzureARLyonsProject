/**
 * Builds the inline upload processor + the AR master reader for the API container, reusing the
 * same Azure adapters the worker uses (Blob, Document Intelligence / Excel routing, AI Foundry).
 * The API processes manual uploads synchronously (the user uploads a file and sees the outcome),
 * so it needs the full pipeline — minus the Service Bus consumer loop the worker owns.
 *
 * Everything is env-gated so the API boots even when a backend is not yet configured:
 *   - AR master matching turns on with LAKEHOUSE_SQL_SERVER (learned-alias overlay applied).
 *   - AP invoice uploads turn on with LAKEHOUSE_SQL_SERVER (invoice masters); otherwise AR-only.
 */
import type { Persistence } from "@coa/persistence";
import {
  createFabricLakehouseReader,
  LearningAugmentedMasterReader,
  aliasOverlayFromRows,
  createFabricInvoiceLakehouseReader,
  invoiceLakehouseConfigFrom,
  type InvoiceLakehouseConfig,
  type MasterDataReader,
} from "@coa/fabric-read";
import { createAzureBlobStore } from "../../workers/src/storage/azure-blob-store.js";
import {
  createAzureDocumentIntelligenceClient,
  createDefaultExcelExtractor,
  RoutingExtractor,
} from "../../workers/src/extraction/index.js";
import { createAzureFoundryClient, FewShotCompleter } from "../../workers/src/interpretation/index.js";
import {
  PersistenceInvoiceDedup,
  createAzureInvoiceFoundryClient,
  type InvoicePipelineDeps,
} from "../../workers/src/invoice/index.js";
import type { PipelineDeps } from "../../workers/src/pipeline/index.js";
import { PipelineUploadProcessor, type UploadProcessor } from "./upload.js";

export interface UploadBundle {
  uploads: UploadProcessor;
  /** AR master reader (learning-augmented) — also passed to buildServer for revalidation. */
  masters?: MasterDataReader;
}

/**
 * Constructs the AR master reader (if the Lakehouse is configured) and an upload processor that
 * runs AR orders and (when the Lakehouse is configured) AP invoices through the live pipeline.
 */
export async function buildUploadBundle(persistence: Persistence): Promise<UploadBundle> {
  const blob = createAzureBlobStore();
  const resolveBytes = (ref: Parameters<typeof blob.download>[0]) => blob.download(ref);

  // Route by file type: PDF/image → Document Intelligence, Excel/CSV → spreadsheet extractor.
  const di = new RoutingExtractor({
    di: createAzureDocumentIntelligenceClient({ resolveBytes }),
    excel: createDefaultExcelExtractor({ resolveBytes }),
  });

  // Few-shot learning: recent reviewer corrections are injected into the interpretation prompt.
  const recentCorrections = async () => {
    const rows = await persistence.listCorrections({ limit: 8 });
    return rows.map((r) => ({ field: r.fieldPath, from: r.originalValue, to: r.correctedValue, kind: r.kind }));
  };

  const foundry = createAzureFoundryClient({ wrapCompleter: (c) => new FewShotCompleter(c, recentCorrections) });

  // AR masters + auto-stage turn on only when the Lakehouse is configured.
  let masters: MasterDataReader | undefined;
  if (process.env.LAKEHOUSE_SQL_SERVER) {
    const base = await createFabricLakehouseReader();
    masters = new LearningAugmentedMasterReader(base, async (companyId) =>
      aliasOverlayFromRows(await persistence.listLearnedAliases(companyId)),
    );
  }

  const order: PipelineDeps = { blob, persistence, di, foundry, ...(masters ? { masters, autoStage: true } : {}) };

  // AP invoice uploads require the Lakehouse (invoice masters driven by the Settings connection config).
  let invoice: InvoicePipelineDeps | undefined;
  if (process.env.LAKEHOUSE_SQL_SERVER) {
    const invoiceMasters = await createFabricInvoiceLakehouseReader(await invoiceConfigFromStored(persistence));
    const invoiceFoundry = createAzureInvoiceFoundryClient({ wrapCompleter: (c) => new FewShotCompleter(c, recentCorrections) });
    invoice = {
      blob,
      di,
      foundry: invoiceFoundry,
      masters: invoiceMasters,
      dedup: new PersistenceInvoiceDedup(persistence),
      persistence,
      autoStage: true,
    };
  }

  const uploads = new PipelineUploadProcessor({ order, ...(invoice ? { invoice } : {}) });
  return { uploads, ...(masters ? { masters } : {}) };
}

/** Build the invoice-master Lakehouse config from the stored connection settings; undefined → defaults. */
async function invoiceConfigFromStored(persistence: Persistence): Promise<InvoiceLakehouseConfig | undefined> {
  try {
    const row = await persistence.getConfig("connections");
    if (!row) return undefined;
    const lk = (
      JSON.parse(row.value) as {
        lakehouse?: Partial<
          Record<"vendorTable" | "vendorAccountColumn" | "vendorNameColumn" | "poTable" | "poNumberColumn" | "poVendorColumn", string>
        >;
      }
    ).lakehouse;
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
