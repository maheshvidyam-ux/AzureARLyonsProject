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
import { InMemoryMasterDataReader } from "@coa/fabric-read";
import { buildServer } from "../api/src/server.js";
import { processAttachment, type PipelineDeps } from "../workers/src/pipeline/pipeline.js";
import type { GraphMailMessage } from "../workers/src/pipeline/ports.js";
import { InMemoryBlobStore } from "../../mocks/blob/in-memory-blob.js";
import { MockDocumentIntelligenceClient, MockFoundryClient } from "../../mocks/ai/mock-ai-clients.js";
import { SAMPLE_CUSTOMERS, SAMPLE_ITEMS } from "../../mocks/fabric/sample-masters.js";

const PORT = 5174;

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
  const pipeline: PipelineDeps = {
    blob: new InMemoryBlobStore(),
    persistence,
    di: new MockDocumentIntelligenceClient(),
    foundry: new MockFoundryClient(),
    masters: new InMemoryMasterDataReader({ customers: SAMPLE_CUSTOMERS, items: SAMPLE_ITEMS }),
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

  const app = await buildServer({
    graphClientState: "dev",
    graph: { async enqueueMessageIds() {} },
    persistence,
    logger: true,
  });
  await app.listen({ port: PORT, host: "127.0.0.1" });
  console.log(`dev reviewer API listening on http://127.0.0.1:${PORT}`);
}

void main();
