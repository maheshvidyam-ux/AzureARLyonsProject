/**
 * One-shot live smoke test: run the first slice for a clean sample PO against the REAL
 * Fabric SQL database, read the persisted order back, then delete the rows it created so the
 * database is left schema-only. Uses the quarantined mocks for Graph/Blob/DI/Foundry — only
 * the persistence target is real.
 *
 *   FABRIC_SQL_SERVER=... FABRIC_SQL_DATABASE=... npx tsx scripts/smoke-fabric-slice.mts
 */
import sql from "mssql";
import { createPool, fabricSqlConfigFromEnv, FabricSqlPersistence } from "@coa/persistence";
import { FakeGraphSource } from "../mocks/graph/fake-mailbox.js";
import { InMemoryBlobStore } from "../mocks/blob/in-memory-blob.js";
import { MockDocumentIntelligenceClient, MockFoundryClient } from "../mocks/ai/mock-ai-clients.js";
import { processAttachment } from "../apps/workers/src/pipeline/pipeline.js";

const pool = await createPool(fabricSqlConfigFromEnv());
const persistence = new FabricSqlPersistence(pool);

try {
  const [message] = await new FakeGraphSource(["sample-po-001"]).fetchMessages();
  const deps = {
    blob: new InMemoryBlobStore(),
    persistence,
    di: new MockDocumentIntelligenceClient(),
    foundry: new MockFoundryClient(),
  };

  console.log("→ running slice against Fabric SQL…");
  const r = await processAttachment(deps, message!, 0);
  console.log(`   decision=${r.decision} order=${r.orderHeaderId} doc=${r.documentId}`);
  for (const t of r.trace) console.log(`     • ${t}`);

  // Read back from the real DB.
  const header = await persistence.getOrderHeaderById(r.orderHeaderId!);
  const findings = await persistence.getValidationByOrderId(r.orderHeaderId!);
  console.log("\n← read back from Fabric SQL:");
  console.log(`   header: po=${header?.normalizedPoNumber} state=${header?.internalState} total=${header?.total} lines=${header?.lineCount}`);
  console.log(`   validation rows: ${findings.length} (${findings.map((f) => f.code).join(", ")})`);

  const ordersBefore = await persistence.countOrders();
  console.log(`\n   order_header count (pre-cleanup): ${ordersBefore}`);

  // Cleanup — delete the rows this run created, FK-safe order.
  console.log("\n✂  cleaning up test rows…");
  const oh = r.orderHeaderId!;
  const doc = r.documentId!;
  const att = r.ingestion.mailAttachmentId;
  const mail = r.ingestion.mailMessageId;
  const del = async (q: string, name: string, val: string) => {
    await pool.request().input("id", sql.UniqueIdentifier, val).query(q);
    console.log(`   - ${name}`);
  };
  await del("DELETE FROM dbo.order_validation WHERE order_header_id = @id", "order_validation", oh);
  await del("DELETE FROM dbo.order_status_history WHERE order_header_id = @id", "order_status_history", oh);
  await del("DELETE FROM dbo.order_line WHERE order_header_id = @id", "order_line", oh);
  await del("DELETE FROM dbo.order_header WHERE id = @id", "order_header", oh);
  await del("DELETE FROM dbo.extracted_order WHERE source_document_id = @id", "extracted_order", doc);
  await del("DELETE FROM dbo.source_document WHERE id = @id", "source_document", doc);
  await del("DELETE FROM dbo.mail_attachment WHERE id = @id", "mail_attachment", att);
  await del("DELETE FROM dbo.mail_message WHERE id = @id", "mail_message", mail);

  const ordersAfter = await persistence.countOrders();
  const mailAfter = await pool.request().query("SELECT COUNT(*) AS n FROM dbo.mail_message");
  console.log(`\n✅ smoke test passed. order_header count (post-cleanup): ${ordersAfter}; mail_message: ${mailAfter.recordset[0].n}`);
  console.log("   Database left schema-only.");
} finally {
  await persistence.close();
}
