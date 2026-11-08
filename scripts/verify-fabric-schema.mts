/**
 * Read-only check that the operational schema is present in the Fabric SQL database.
 * Usage: FABRIC_SQL_SERVER=... FABRIC_SQL_DATABASE=... npx tsx scripts/verify-fabric-schema.mts
 */
import { createPool, fabricSqlConfigFromEnv } from "@coa/persistence";

const pool = await createPool(fabricSqlConfigFromEnv());
try {
  const tables = await pool.request().query(
    "SELECT name FROM sys.tables WHERE schema_id = SCHEMA_ID('dbo') ORDER BY name",
  );
  console.log("dbo tables:");
  for (const r of tables.recordset) console.log("  •", r.name);

  const idx = await pool.request().query(
    "SELECT i.name, i.is_unique, i.has_filter FROM sys.indexes i WHERE i.name = 'UX_duplicate_claim_active'",
  );
  const claim = idx.recordset[0];
  console.log(
    "\nduplicate-claim index:",
    claim ? `${claim.name} (unique=${claim.is_unique}, filtered=${claim.has_filter})` : "MISSING",
  );

  const migs = await pool.request().query("SELECT version, applied_at FROM dbo.schema_migrations ORDER BY version");
  console.log("\napplied migrations:");
  for (const r of migs.recordset) console.log(`  • ${r.version} @ ${r.applied_at.toISOString?.() ?? r.applied_at}`);
} finally {
  await pool.close();
}
