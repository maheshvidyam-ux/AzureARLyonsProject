/**
 * Connection helpers for SQL database in Fabric (ADR 0007). Auth defaults to Entra
 * (managed identity / default credential) — no SQL logins (spec §3 least-privilege).
 *
 * Auth: `azure-active-directory-default` uses @azure/identity's DefaultAzureCredential, so it
 * works with `az login` (AzureCliCredential), a managed identity, or a service principal via
 * the standard AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_CLIENT_SECRET env vars — no SQL logins.
 * @azure/identity is a dependency of this package; mssql/tedious loads it for this auth mode.
 */
import sql from "mssql";

export interface FabricSqlEnv {
  server: string; // e.g. <workspace>.database.fabric.microsoft.com
  database: string;
}

/**
 * Build an mssql config for Fabric SQL from the environment:
 *   FABRIC_SQL_SERVER, FABRIC_SQL_DATABASE   (required)
 * Encryption is always on. Entra default-credential auth is used.
 */
export function fabricSqlConfigFromEnv(): sql.config {
  const server = requireEnv("FABRIC_SQL_SERVER");
  const database = requireEnv("FABRIC_SQL_DATABASE");
  return {
    server,
    database,
    options: { encrypt: true, trustServerCertificate: false },
    authentication: { type: "azure-active-directory-default" },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30_000 },
  } as sql.config;
}

export async function createPool(config: sql.config): Promise<sql.ConnectionPool> {
  const pool = new sql.ConnectionPool(config);
  await pool.connect();
  return pool;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}
