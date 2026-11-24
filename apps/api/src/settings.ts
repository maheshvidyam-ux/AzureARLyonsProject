/**
 * Connection configuration (admin screens). These are NON-SECRET coordinates — Fabric SQL and the
 * ERP Lakehouse both use Entra auth, so there are no passwords here; the screen edits server/database
 * names, the ERP table & column mappings used for validation, and the AI endpoint names. Values are
 * stored as one JSON document under the 'connections' key and merged over environment defaults, so
 * an unset field falls back to the deployment's env var. The operational DB is bootstrap (the app
 * needs it to read its own config), so it is view + test only; the Lakehouse/AI entries are editable.
 */
import { fabricSqlConfig, probeConnection } from "@coa/persistence";

export const CONNECTIONS_KEY = "connections";

export interface ConnectionsConfig {
  operationalDb: { server: string; database: string; authMode: string };
  lakehouse: {
    enabled: boolean;
    server: string;
    database: string;
    customerTable: string;
    itemTable: string;
    customerAccountColumn: string;
    customerNameColumn: string;
    dataAreaColumn: string;
    itemIdColumn: string;
    itemSkuColumn: string;
  };
  ai: { docIntelEndpoint: string; foundryEndpoint: string; foundryDeployment: string };
}

const env = (name: string): string => process.env[name] ?? "";

export function defaultConnectionsFromEnv(): ConnectionsConfig {
  return {
    operationalDb: { server: env("FABRIC_SQL_SERVER"), database: env("FABRIC_SQL_DATABASE"), authMode: "Entra (azure-active-directory-default)" },
    lakehouse: {
      enabled: Boolean(process.env.LAKEHOUSE_SQL_SERVER),
      server: env("LAKEHOUSE_SQL_SERVER"),
      database: env("LAKEHOUSE_DATABASE"),
      customerTable: "gold.ax_custmaster",
      itemTable: "gold.ax_itemmaster",
      customerAccountColumn: "custaccount",
      customerNameColumn: "name",
      dataAreaColumn: "dataareaid",
      itemIdColumn: "itemid",
      itemSkuColumn: "itemid",
    },
    ai: { docIntelEndpoint: env("DOC_INTEL_ENDPOINT"), foundryEndpoint: env("AI_FOUNDRY_ENDPOINT"), foundryDeployment: env("AI_FOUNDRY_DEPLOYMENT") },
  };
}

/** Deep-merge a stored (partial) config over env defaults. */
export function mergeConnections(stored: Partial<ConnectionsConfig> | null): ConnectionsConfig {
  const base = defaultConnectionsFromEnv();
  if (!stored) return base;
  return {
    operationalDb: { ...base.operationalDb, ...stored.operationalDb },
    lakehouse: { ...base.lakehouse, ...stored.lakehouse },
    ai: { ...base.ai, ...stored.ai },
  };
}

export type ConnectionTarget = "operationalDb" | "lakehouse";
export interface ConnectionTestResult {
  ok: boolean;
  detail?: string;
  error?: string;
}
export type ConnectionTester = (target: ConnectionTarget, cfg: ConnectionsConfig) => Promise<ConnectionTestResult>;

/** Only allow a `schema.table` / `table` identifier into the probe SQL. */
const SAFE_TABLE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/** Real tester: opens a transient Entra-auth pool to the given coordinates and runs a probe. */
export const defaultConnectionTester: ConnectionTester = async (target, cfg) => {
  const c = target === "operationalDb" ? cfg.operationalDb : cfg.lakehouse;
  if (!c.server || !c.database) return { ok: false, error: "server and database are required" };
  let probe = "SELECT 1 AS ok";
  if (target === "lakehouse") {
    if (!SAFE_TABLE.test(cfg.lakehouse.customerTable)) return { ok: false, error: `invalid table name '${cfg.lakehouse.customerTable}'` };
    probe = `SELECT TOP 1 1 AS ok FROM ${cfg.lakehouse.customerTable}`;
  }
  const res = await probeConnection(fabricSqlConfig({ server: c.server, database: c.database }), probe);
  return res.ok ? { ok: true, detail: `connected to ${c.server}/${c.database}` } : { ok: false, error: res.error };
};
