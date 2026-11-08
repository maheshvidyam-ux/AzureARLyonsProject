/**
 * Minimal forward/rollback migration runner for SQL database in Fabric (ADR 0007).
 * Reads db/migrations/<version>_<name>.(up|down).sql and tracks applied versions in
 * dbo.schema_migrations so re-runs are safe.
 *
 *   FABRIC_SQL_SERVER=... FABRIC_SQL_DATABASE=... tsx packages/persistence/src/fabric-sql/migrate.ts up
 *   FABRIC_SQL_SERVER=... FABRIC_SQL_DATABASE=... tsx packages/persistence/src/fabric-sql/migrate.ts down
 *
 * No production database is migrated during development (spec §18): point this only at a
 * dev/test Fabric SQL database.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sql from "mssql";
import { createPool, fabricSqlConfigFromEnv } from "./connection.js";

const MIGRATIONS_DIR = resolve(process.cwd(), "db", "migrations");

interface Migration {
  version: string;
  name: string;
  upFile: string;
  downFile: string;
}

export function discoverMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir);
  const versions = new Map<string, Partial<Migration>>();
  for (const f of files) {
    const m = /^(\d+)_(.+)\.(up|down)\.sql$/.exec(f);
    if (!m) continue;
    const [, version, name, dir2] = m;
    const entry = versions.get(version!) ?? { version, name };
    if (dir2 === "up") entry.upFile = f;
    else entry.downFile = f;
    versions.set(version!, entry);
  }
  return [...versions.values()]
    .filter((e): e is Migration => Boolean(e.upFile && e.downFile))
    .sort((a, b) => a.version.localeCompare(b.version));
}

async function ensureTracking(pool: sql.ConnectionPool): Promise<void> {
  await pool.request().batch(
    `IF OBJECT_ID('dbo.schema_migrations') IS NULL
       CREATE TABLE dbo.schema_migrations (
         version varchar(20) NOT NULL CONSTRAINT PK_schema_migrations PRIMARY KEY,
         applied_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
       );`,
  );
}

async function appliedVersions(pool: sql.ConnectionPool): Promise<Set<string>> {
  const res = await pool.request().query("SELECT version FROM dbo.schema_migrations");
  return new Set(res.recordset.map((r) => r.version as string));
}

export async function migrateUp(pool: sql.ConnectionPool, dir = MIGRATIONS_DIR): Promise<string[]> {
  await ensureTracking(pool);
  const applied = await appliedVersions(pool);
  const done: string[] = [];
  for (const mig of discoverMigrations(dir)) {
    if (applied.has(mig.version)) continue;
    const ddl = readFileSync(join(dir, mig.upFile), "utf8");
    await pool.request().batch(ddl);
    await pool.request().input("v", sql.VarChar(20), mig.version).query("INSERT INTO dbo.schema_migrations (version) VALUES (@v)");
    done.push(mig.version);
  }
  return done;
}

export async function migrateDown(pool: sql.ConnectionPool, dir = MIGRATIONS_DIR): Promise<string | null> {
  await ensureTracking(pool);
  const applied = await appliedVersions(pool);
  const latest = discoverMigrations(dir)
    .filter((m) => applied.has(m.version))
    .at(-1);
  if (!latest) return null;
  const ddl = readFileSync(join(dir, latest.downFile), "utf8");
  await pool.request().batch(ddl);
  await pool.request().input("v", sql.VarChar(20), latest.version).query("DELETE FROM dbo.schema_migrations WHERE version = @v");
  return latest.version;
}

async function main(): Promise<void> {
  const direction = process.argv[2] ?? "up";
  const pool = await createPool(fabricSqlConfigFromEnv());
  try {
    if (direction === "down") {
      const v = await migrateDown(pool);
      console.log(v ? `Rolled back migration ${v}` : "Nothing to roll back.");
    } else {
      const done = await migrateUp(pool);
      console.log(done.length ? `Applied migrations: ${done.join(", ")}` : "Already up to date.");
    }
  } finally {
    await pool.close();
  }
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Migration failed:", err);
    process.exitCode = 1;
  });
}
