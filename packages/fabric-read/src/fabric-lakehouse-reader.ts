/**
 * Fabric Lakehouse master-data reader (spec §6, §11 / Q-FAB-1). The customer- and item-
 * validation master tables live in the Fabric **Lakehouse**, read over its **SQL analytics
 * endpoint** (read-only T-SQL) — the same `mssql` + Entra pattern as the operational store.
 *
 * Column/table names are CONFIG-DRIVEN (`LakehouseMasterConfig`): "do not invent fields"
 * (spec §6). The defaults are placeholders — set them to the real Lakehouse schema. Row→master
 * mapping is pure and unit-tested; the live reader is gated behind LAKEHOUSE_SQL_SERVER.
 *
 * Multi-value attributes (aliases, cross-refs, GTINs, per-customer item codes) are read from
 * delimited string columns when configured; otherwise they are empty and matching relies on the
 * strong EXACT-name / EXACT-SKU signals.
 */
import sql from "mssql";
import type { CustomerMaster, ItemMaster, MasterDataHealth, MasterDataReader } from "./ports.js";

export interface CustomerColumns {
  account: string;
  name: string;
  company?: string;
  status?: string;
  aliases?: string;
  crossRefs?: string;
  addresses?: string;
}
export interface ItemColumns {
  erpItemId: string;
  sku: string;
  company?: string;
  status?: string;
  uom?: string;
  gtins?: string;
}
export interface LakehouseMasterConfig {
  customers: { table: string; columns: CustomerColumns };
  items: { table: string; columns: ItemColumns };
  /** delimiter for multi-value string columns (aliases/crossRefs/gtins). */
  multiValueDelimiter?: string;
  /** minutes after which the read model is considered stale (Q-FAB-4). */
  stalenessMinutes?: number;
  /** optional query returning one column = the masters' last refresh timestamp. */
  lastRefreshQuery?: string;
}

/**
 * Real Lakehouse tables are `gold.ax_custmaster` / `gold.ax_itemmaster` (AX masters in the
 * medallion gold layer). ⚠️ Column names below are still to be confirmed against the actual
 * schema (Q-FAB-1) — adjust once introspected.
 */
export const DEFAULT_LAKEHOUSE_CONFIG: LakehouseMasterConfig = {
  customers: { table: "gold.ax_custmaster", columns: { account: "custaccount", name: "name", company: "dataareaid", status: "blocked" } },
  items: { table: "gold.ax_itemmaster", columns: { erpItemId: "itemid", sku: "itemid", company: "dataareaid", uom: "unitid" } },
  multiValueDelimiter: ",",
  stalenessMinutes: 1440,
};

type Row = Record<string, unknown>;

const str = (v: unknown): string => (v == null ? "" : String(v));
const splitMulti = (v: unknown, delim: string): string[] =>
  v == null ? [] : String(v).split(delim).map((s) => s.trim()).filter(Boolean);
const toStatus = (v: unknown): "ACTIVE" | "INACTIVE" => {
  const s = String(v ?? "").toLowerCase();
  return ["inactive", "disabled", "blocked", "0", "false", "n"].includes(s) ? "INACTIVE" : "ACTIVE";
};

export function mapCustomerRow(row: Row, cols: CustomerColumns, delim = ","): CustomerMaster {
  return {
    erpCustomerAccount: str(row[cols.account]),
    companyId: cols.company ? str(row[cols.company]) : "",
    name: str(row[cols.name]),
    aliases: cols.aliases ? splitMulti(row[cols.aliases], delim) : [],
    crossRefs: cols.crossRefs ? splitMulti(row[cols.crossRefs], delim) : [],
    addresses: cols.addresses ? splitMulti(row[cols.addresses], delim) : [],
    status: cols.status ? toStatus(row[cols.status]) : "ACTIVE",
  };
}

export function mapItemRow(row: Row, cols: ItemColumns, delim = ","): ItemMaster {
  return {
    erpItemId: str(row[cols.erpItemId]),
    companyId: cols.company ? str(row[cols.company]) : "",
    sku: str(row[cols.sku]),
    gtins: cols.gtins ? splitMulti(row[cols.gtins], delim) : [],
    uom: cols.uom ? str(row[cols.uom]) : "",
    status: cols.status ? toStatus(row[cols.status]) : "ACTIVE",
  };
}

function selectList(cols: CustomerColumns | ItemColumns): string {
  const names = Object.values(cols as unknown as Record<string, string | undefined>).filter((c): c is string => Boolean(c));
  return [...new Set(names)].map((c) => `[${c}]`).join(", ");
}

export class FabricLakehouseMasterDataReader implements MasterDataReader {
  private readonly delim: string;
  constructor(private readonly pool: sql.ConnectionPool, private readonly config: LakehouseMasterConfig = DEFAULT_LAKEHOUSE_CONFIG) {
    this.delim = config.multiValueDelimiter ?? ",";
  }

  async findCustomers(companyId: string): Promise<CustomerMaster[]> {
    const c = this.config.customers;
    const where = c.columns.company ? `WHERE [${c.columns.company}] = @company` : "";
    const req = this.pool.request();
    if (c.columns.company) req.input("company", sql.VarChar(50), companyId);
    const res = await req.query(`SELECT ${selectList(c.columns)} FROM ${c.table} ${where}`);
    return res.recordset.map((r) => mapCustomerRow(r, c.columns, this.delim)).filter((m) => m.status === "ACTIVE");
  }

  async findItems(companyId: string): Promise<ItemMaster[]> {
    const c = this.config.items;
    const where = c.columns.company ? `WHERE [${c.columns.company}] = @company` : "";
    const req = this.pool.request();
    if (c.columns.company) req.input("company", sql.VarChar(50), companyId);
    const res = await req.query(`SELECT ${selectList(c.columns)} FROM ${c.table} ${where}`);
    return res.recordset.map((r) => mapItemRow(r, c.columns, this.delim)).filter((m) => m.status === "ACTIVE");
  }

  async health(): Promise<MasterDataHealth> {
    if (!this.config.lastRefreshQuery) {
      return { lastRefreshed: null, healthy: true, stale: false };
    }
    const res = await this.pool.request().query(this.config.lastRefreshQuery);
    const raw = res.recordset[0] ? Object.values(res.recordset[0])[0] : null;
    const lastRefreshed = raw ? new Date(raw as string).toISOString() : null;
    const ageMin = lastRefreshed ? (Date.now() - new Date(lastRefreshed).getTime()) / 60_000 : Infinity;
    const stale = ageMin > (this.config.stalenessMinutes ?? 1440);
    return { lastRefreshed, healthy: !stale, stale };
  }
}

export function lakehouseConfigFromEnv(env: NodeJS.ProcessEnv = process.env): sql.config {
  const server = requireEnv(env, "LAKEHOUSE_SQL_SERVER"); // Lakehouse SQL analytics endpoint host
  const database = requireEnv(env, "LAKEHOUSE_DATABASE"); // the Lakehouse (or its SQL endpoint db) name
  return {
    server,
    database,
    options: { encrypt: true, trustServerCertificate: false },
    authentication: { type: "azure-active-directory-default" },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30_000 },
  } as sql.config;
}

export async function createFabricLakehouseReader(config?: LakehouseMasterConfig): Promise<FabricLakehouseMasterDataReader> {
  const pool = new sql.ConnectionPool(lakehouseConfigFromEnv());
  await pool.connect();
  return new FabricLakehouseMasterDataReader(pool, config ?? DEFAULT_LAKEHOUSE_CONFIG);
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}
