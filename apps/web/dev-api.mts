/**
 * Local dev API for the SPA. There is no cloud here: an in-memory persistence store is seeded by
 * running sample attachments through the *real* order pipeline (the same processAttachment used in
 * production and in tests), with mock DI/Foundry/blob + an in-memory master-data reader. The SPA
 * (vite, :5173) proxies /api to this server, so it exercises the genuine reviewer routes and
 * optimistic-concurrency behaviour — only the datastore and AI are stubbed.
 *
 *   npm --workspace @coa/web run dev:api     # this server, :5174
 *   npm --workspace @coa/web run dev         # the SPA, :5173  (proxies /api → :5174)
 */
import { InMemoryPersistence } from "@coa/persistence";
import { InMemoryMasterDataReader, LearningAugmentedMasterReader, aliasOverlayFromRows, InMemoryInvoiceMasterReader } from "@coa/fabric-read";
import { buildServer } from "../api/src/server.js";
import { processAttachment, type PipelineDeps } from "../workers/src/pipeline/pipeline.js";
import { InMemoryInvoiceDedup, processInvoice, type InvoicePipelineDeps } from "../workers/src/invoice/index.js";
import type { GraphMailMessage } from "../workers/src/pipeline/ports.js";
import { PipelineUploadProcessor } from "../api/src/upload.js";
import { InMemoryBlobStore } from "../../mocks/blob/in-memory-blob.js";
import { MockDocumentIntelligenceClient, MockFoundryClient } from "../../mocks/ai/mock-ai-clients.js";
import { SAMPLE_CUSTOMERS, SAMPLE_ITEMS } from "../../mocks/fabric/sample-masters.js";
import { SAMPLE_VENDORS, SAMPLE_PO_LINES, SAMPLE_RECEIPTS } from "../../mocks/fabric/sample-invoice-masters.js";
import type { BlobRef, DiLayoutResult, DocumentIntelligenceClient, FoundryClient, FoundryResult } from "../workers/src/pipeline/ports.js";

const PORT = 5174;

/**
 * DEV ONLY. The mock DI/Foundry key off the sample-file stem, so a real uploaded PDF (any filename)
 * has no fixture. These wrappers map an upload to a representative fixture and stamp a per-file-unique
 * PO/invoice number (from the content hash) so each upload becomes its own fresh review item instead
 * of colliding on the duplicate key. In production the real DI/Foundry read the actual bytes.
 */
const withStem = (blob: BlobRef, stem: string): BlobRef => ({ ...blob, filename: `${stem}.pdf` });
class SampleMappingDi implements DocumentIntelligenceClient {
  constructor(private readonly base: DocumentIntelligenceClient, private readonly stem: string) {}
  analyze(input: { blob: BlobRef }): Promise<DiLayoutResult> {
    return this.base.analyze({ blob: withStem(input.blob, this.stem) });
  }
}
class SampleMappingFoundry implements FoundryClient {
  constructor(private readonly base: FoundryClient, private readonly stem: string) {}
  async interpret(input: { di: DiLayoutResult; blob: BlobRef }): Promise<FoundryResult> {
    const res = await this.base.interpret({ di: input.di, blob: withStem(input.blob, this.stem) });
    const suffix = (input.blob.contentHash || "000000").slice(0, 6).toUpperCase();
    try {
      const d = JSON.parse(res.rawJson);
      if (d?.header?.customer_po_number) d.header.customer_po_number = { ...d.header.customer_po_number, value: `UP-${suffix}` };
      if (d?.header?.invoice_number) d.header.invoice_number = { ...d.header.invoice_number, value: `UP-${suffix}` };
      return { ...res, rawJson: JSON.stringify(d) };
    } catch {
      return res;
    }
  }
}

function mail(stem: string, id: string, sender: string): GraphMailMessage {
  return {
    graphMessageId: `gm-${id}`,
    mailbox: "orders@lyons",
    sender,
    receivedAt: "2026-11-18T09:00:00Z",
    subject: `Purchase order ${id}`,
    attachments: [
      { graphAttachmentId: `ga-${id}`, filename: `${stem}.pdf`, contentType: "application/pdf", contentBase64: Buffer.from(id).toString("base64") },
    ],
  };
}

async function main(): Promise<void> {
  const persistence = new InMemoryPersistence();
  // Learning-augmented masters: corrections a CSR makes are overlaid as aliases on the next match.
  const baseMasters = new InMemoryMasterDataReader({ customers: SAMPLE_CUSTOMERS, items: SAMPLE_ITEMS });
  const masters = new LearningAugmentedMasterReader(baseMasters, async (companyId) => aliasOverlayFromRows(await persistence.listLearnedAliases(companyId)));
  const pipeline: PipelineDeps = {
    blob: new InMemoryBlobStore(),
    persistence,
    di: new MockDocumentIntelligenceClient(),
    foundry: new MockFoundryClient(),
    masters,
  };

  // Seed a varied queue from the recorded sample documents.
  const seeds: Array<[stem: string, id: string, sender: string]> = [
    ["sample-po-001", "po-001", "buyer@acme.example.com"],
    ["sample-po-002", "po-002", "orders@globex.example.com"],
    ["sample-po-003", "po-003", "po@initech.example.com"],
  ];
  for (const [stem, id, sender] of seeds) {
    try {
      await processAttachment(pipeline, mail(stem, id, sender), 0);
    } catch (err) {
      console.error(`seed ${stem} failed:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`seeded ${await persistence.countOrders()} orders`);

  // Seed AP vendor invoices through the real invoice pipeline (PO-based 3-way + Non-PO C&A).
  const invoiceDeps: InvoicePipelineDeps = {
    blob: new InMemoryBlobStore(),
    di: new MockDocumentIntelligenceClient(),
    foundry: new MockFoundryClient(),
    masters: new InMemoryInvoiceMasterReader({ vendors: SAMPLE_VENDORS, poLines: SAMPLE_PO_LINES, receipts: SAMPLE_RECEIPTS }),
    dedup: new InMemoryInvoiceDedup(),
    persistence,
  };
  const invoiceSeeds: Array<[stem: string, id: string]> = [
    ["sample-inv-po-001", "inv-po-001"], // PO-based clean 3-way → READY
    ["sample-inv-nonpo-001", "inv-np-001"], // Non-PO → NEEDS_REVIEW (Code & Approve / GL coding)
  ];
  for (const [stem, id] of invoiceSeeds) {
    try {
      await processInvoice(invoiceDeps, mail(stem, id, "ap@acme.example.com"), 0);
    } catch (err) {
      console.error(`invoice seed ${stem} failed:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`seeded ${(await persistence.listInvoices({})).length} invoices`);

  // Manual upload intake (POST /uploads): run uploaded PDFs through the real pipeline. In dev the
  // sample-mapping DI/Foundry turn any uploaded file into a fresh review item (AR → unmatched order,
  // AP → Non-PO Code-&-Approve), each with a unique PO/invoice number.
  const uploads = new PipelineUploadProcessor({
    order: {
      blob: new InMemoryBlobStore(),
      persistence,
      masters,
      di: new SampleMappingDi(new MockDocumentIntelligenceClient(), "sample-po-002"),
      foundry: new SampleMappingFoundry(new MockFoundryClient(), "sample-po-002"),
    },
    invoice: {
      blob: new InMemoryBlobStore(),
      persistence,
      masters: invoiceDeps.masters,
      dedup: invoiceDeps.dedup,
      di: new SampleMappingDi(new MockDocumentIntelligenceClient(), "sample-inv-nonpo-001"),
      foundry: new SampleMappingFoundry(new MockFoundryClient(), "sample-inv-nonpo-001"),
    },
  });

  const app = await buildServer({
    uploads,
    graphClientState: "dev",
    graph: { async enqueueMessageIds() {} },
    persistence,
    masters: pipeline.masters, // enables /orders/:id/revalidate (re-matching)
    // Dev stub for the settings "Test connection" (no live Azure locally).
    connectionTester: async (target, cfg) => {
      const c = target === "operationalDb" ? cfg.operationalDb : cfg.lakehouse;
      return c.server ? { ok: true, detail: `(dev simulated) would connect to ${c.server}/${c.database}` } : { ok: false, error: "no server configured" };
    },
    logger: true,
  });
  await app.listen({ port: PORT, host: "127.0.0.1" });
  console.log(`dev reviewer API listening on http://127.0.0.1:${PORT}`);
}

void main();
