/**
 * Live proof of the atomic duplicate claim (spec §8, invariant #2) against the REAL Fabric SQL
 * database — cross-channel block + same-order idempotency — cleaning up after itself so the DB
 * is left schema-only (does NOT migrate down).
 *
 *   FABRIC_SQL_SERVER=... FABRIC_SQL_DATABASE=... npx tsx scripts/verify-duplicate-claim.mts
 */
import sql from "mssql";
import { createPool, fabricSqlConfigFromEnv, FabricSqlPersistence, toOrderHeaderWrite, toOrderLineWrites } from "@coa/persistence";
import type { NormalizedPurchaseOrder } from "@coa/po-schema";

const KEY1 = "USMF::ACME01::LIVEDUP1";
const KEY2 = "USMF::ACME01::LIVEDUP2";

const po = (): NormalizedPurchaseOrder => ({
  document_id: "d", order_id: null, schema_version: "1.0.0",
  company: { company_id: "USMF", resolved_from: "default" },
  header: { customer: { erp_customer_account: { value: "ACME01" }, name: { value: "Acme" }, match_status: "EXACT" }, customer_po_number: { value: "LIVEDUP" }, normalized_po_number: "LIVEDUP", currency: { value: "USD" }, totals: { grand_total: { amount: 10, currency: "USD" } } },
  lines: [{ line_id: "L1", quantity: { value: 1 }, unit_price: { value: 10 }, extended_amount: { value: 10 }, match_status: "EXACT_SKU" }],
  extraction: { overall_confidence: 0.99 }, validation: [],
});

const pool = await createPool(fabricSqlConfigFromEnv());
const p = new FabricSqlPersistence(pool);
let orderHeaderId = "", sourceDocumentId = "", mailAttachmentId = "", mailMessageId = "";

try {
  // Create one real order to hold a claim.
  const ing = await p.ingest({ companyId: "USMF", graphMessageId: "dup-msg", mailbox: "x", sender: null, receivedAt: "2026-11-01T00:00:00Z", subject: "dup", attachment: { graphAttachmentId: "dup-att", contentHash: "d".repeat(64), blobUri: "mock://dup", contentType: "application/pdf" } });
  mailMessageId = ing.mailMessageId; mailAttachmentId = ing.mailAttachmentId;
  const doc = await p.recordDocument({ mailAttachmentId, companyId: "USMF", blobUriOriginal: "mock://dup", diModelVersion: "test" });
  sourceDocumentId = doc.sourceDocumentId;
  const saved = await p.saveProcessedOrder({ sourceDocumentId, companyId: "USMF", extraction: { rawExtractionJson: "{}", normalizedJson: JSON.stringify(po()), overallConfidence: 0.99 }, header: toOrderHeaderWrite(po(), { simpleStatus: "Ready", internalState: "READY" }), lines: toOrderLineWrites(po()), validation: [], statusHistory: { fromState: "VALIDATING", toState: "READY", actor: "system", reason: null } });
  orderHeaderId = saved.orderHeaderId;

  // Cross-channel: a pre-registered EDI claim blocks the Email order.
  await p.seedExternalClaim({ companyId: "USMF", businessKey: KEY1, channel: "EDI", matchedExistingRef: "EDI-850-LIVE" });
  const collision = await p.claimDuplicate({ companyId: "USMF", businessKey: KEY1, orderHeaderId, channel: "EMAIL" });
  console.log(`① cross-channel EDI→Email: ${collision.status}` + (collision.status === "COLLISION" ? ` (matched ${collision.matchedChannel} ${collision.matchedExistingRef})` : ""));

  // Fresh key: first claim wins, re-claim by the same order is idempotent.
  const first = await p.claimDuplicate({ companyId: "USMF", businessKey: KEY2, orderHeaderId, channel: "EMAIL" });
  const again = await p.claimDuplicate({ companyId: "USMF", businessKey: KEY2, orderHeaderId, channel: "EMAIL" });
  console.log(`② fresh key: first=${first.status}, re-claim-same-order=${again.status}`);

  const ok = collision.status === "COLLISION" && first.status === "CLAIMED" && again.status === "CLAIMED";
  console.log(ok ? "✅ atomic duplicate claim verified on real Fabric SQL" : "❌ unexpected result");
} finally {
  // Cleanup (leave schema-only). Claims first, then the order graph.
  const del = async (q: string, name: string, val: string) => { await pool.request().input("v", name === "bk" ? sql.VarChar(220) : sql.UniqueIdentifier, val).query(q); };
  await pool.request().query(`DELETE FROM dbo.duplicate_claim WHERE business_key IN ('${KEY1}','${KEY2}')`);
  if (orderHeaderId) {
    await del("DELETE FROM dbo.order_line WHERE order_header_id=@v", "oh", orderHeaderId);
    await del("DELETE FROM dbo.order_validation WHERE order_header_id=@v", "oh", orderHeaderId);
    await del("DELETE FROM dbo.order_status_history WHERE order_header_id=@v", "oh", orderHeaderId);
    await del("DELETE FROM dbo.order_header WHERE id=@v", "oh", orderHeaderId);
  }
  if (sourceDocumentId) { await del("DELETE FROM dbo.extracted_order WHERE source_document_id=@v", "doc", sourceDocumentId); await del("DELETE FROM dbo.source_document WHERE id=@v", "doc", sourceDocumentId); }
  if (mailAttachmentId) await del("DELETE FROM dbo.mail_attachment WHERE id=@v", "att", mailAttachmentId);
  if (mailMessageId) await del("DELETE FROM dbo.mail_message WHERE id=@v", "mail", mailMessageId);
  await p.close();
  console.log("   cleaned up — database left schema-only.");
}
