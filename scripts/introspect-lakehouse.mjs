// Discover the Lakehouse SQL endpoint schema (read-only). Lists databases when LAKEHOUSE_DATABASE
// is unset, else prints columns for gold.ax_custmaster / gold.ax_itemmaster.
//   LAKEHOUSE_SQL_SERVER=... [LAKEHOUSE_DATABASE=...] node scripts/introspect-lakehouse.mjs
import sql from "mssql";

const server = process.env.LAKEHOUSE_SQL_SERVER;
const database = process.env.LAKEHOUSE_DATABASE || "master";
if (!server) throw new Error("set LAKEHOUSE_SQL_SERVER");

const pool = new sql.ConnectionPool({
  server,
  database,
  options: { encrypt: true, trustServerCertificate: false },
  authentication: { type: "azure-active-directory-default" },
});
await pool.connect();
try {
  if (!process.env.LAKEHOUSE_DATABASE) {
    const dbs = await pool.request().query("SELECT name FROM sys.databases ORDER BY name");
    console.log("databases on this endpoint:");
    for (const r of dbs.recordset) console.log("  • " + r.name);
    console.log("\nRe-run with LAKEHOUSE_DATABASE=<one of the above> to list columns.");
  } else {
    for (const t of ["ax_custmaster", "ax_itemmaster"]) {
      const cols = await pool
        .request()
        .input("t", sql.VarChar(128), t)
        .query("SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='gold' AND TABLE_NAME=@t ORDER BY ORDINAL_POSITION");
      console.log(`\ngold.${t} (${cols.recordset.length} columns):`);
      for (const c of cols.recordset) console.log(`  ${c.COLUMN_NAME} : ${c.DATA_TYPE}`);
    }
  }
} finally {
  await pool.close();
}
