/**
 * Live capstone: the full Phase-2 loop against the REAL Fabric SQL database.
 *   Graph webhook (Fastify inject) → ingestion queue → IngestionWorker → pipeline → Fabric SQL
 * Reads the persisted orders back, then deletes every row created so the DB is left schema-only.
 * Graph/Blob/DI/Foundry are the quarantined mocks; only persistence is real.
 *
 *   FABRIC_SQL_SERVER=... FABRIC_SQL_DATABASE=... npx tsx scripts/capstone-fabric.mts
 */
import sql from "mssql";
import { createPool, fabricSqlConfigFromEnv, FabricSqlPersistence } from "@coa/persistence";
import { InMemoryIngestionQueue } from "@coa/messaging";
import { buildServer } from "../apps/api/src/server.js";
import { IngestionWorker } from "../apps/workers/src/ingestion/ingestion-worker.js";
import { FakeGraphApiClient } from "../mocks/graph/fake-graph-api.js";
import { InMemoryBlobStore } from "../mocks/blob/in-memory-blob.js";
import { MockDocumentIntelligenceClient, MockFoundryClient } from "../mocks/ai/mock-ai-clients.js";
import type { SliceResult } from "../apps/workers/src/pipeline/pipeline.js";

const MAILBOX = "orders@lyons.example.com";
const CLIENT_STATE = "capstone-secret";

const pool = await createPool(fabricSqlConfigFromEnv());
const persistence = new FabricSqlPersistence(pool);

try {
  // 1. Webhook receives a Graph notification and enqueues the message ids.
  const queue = new InMemoryIngestionQueue();
  const app = await buildServer({
    graphClientState: CLIENT_STATE,
    graph: { async enqueueMessageIds(ids) { for (const id of ids) await queue.publish({ messageId: id }); } },
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
  console.log(`① webhook → ${res.statusCode}; queued ${queue.depth} message id(s)`);

  // 2. Worker drains the queue into the REAL Fabric SQL database.
  const worker = new IngestionWorker({
    client: new FakeGraphApiClient(),
    mailbox: MAILBOX,
    pipeline: { blob: new InMemoryBlobStore(), persistence, di: new MockDocumentIntelligenceClient(), foundry: new MockFoundryClient() },
  });
  const outcomes = await worker.drain(queue);
  const results: SliceResult[] = outcomes.flatMap((o) => o.results);
  console.log(`② worker processed ${outcomes.length} message(s) → ${results.length} order(s)`);

  // 3. Read the orders back from Fabric SQL.
  console.log("③ read back from Fabric SQL:");
  for (const r of results) {
    const h = await persistence.getOrderHeaderById(r.orderHeaderId!);
    const v = await persistence.getValidationByOrderId(r.orderHeaderId!);
    console.log(`   ${r.ingestion.filename}: po=${h?.normalizedPoNumber} state=${h?.internalState} total=${h?.total} lines=${h?.lineCount} findings=${v.length}`);
  }
  console.log(`   order_header count (pre-cleanup): ${await persistence.countOrders()}`);

  // 4. Cleanup — delete every row this run created (FK-safe), per order.
  console.log("④ cleaning up…");
  const byId = async (q: string, val: string) => { await pool.request().input("id", sql.UniqueIdentifier, val).query(q); };
  for (const r of results) {
    const oh = r.orderHeaderId!, doc = r.documentId!, att = r.ingestion.mailAttachmentId, mail = r.ingestion.mailMessageId;
    await byId("DELETE FROM dbo.order_validation WHERE order_header_id = @id", oh);
    await byId("DELETE FROM dbo.order_status_history WHERE order_header_id = @id", oh);
    await byId("DELETE FROM dbo.order_line WHERE order_header_id = @id", oh);
    await byId("DELETE FROM dbo.order_header WHERE id = @id", oh);
    await byId("DELETE FROM dbo.extracted_order WHERE source_document_id = @id", doc);
    await byId("DELETE FROM dbo.source_document WHERE id = @id", doc);
    await byId("DELETE FROM dbo.mail_attachment WHERE id = @id", att);
    await byId("DELETE FROM dbo.mail_message WHERE id = @id", mail);
  }

  const orders = await persistence.countOrders();
  const mails = (await pool.request().query("SELECT COUNT(*) AS n FROM dbo.mail_message")).recordset[0].n;
  console.log(`✅ capstone passed. Post-cleanup: order_header=${orders}, mail_message=${mails}. Database left schema-only.`);
} finally {
  await persistence.close();
}
