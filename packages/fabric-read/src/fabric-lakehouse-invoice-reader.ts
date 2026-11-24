/**
 * Fabric Lakehouse AP master-data reader (AP_INVOICE module / Q-FAB-1): vendors, open PO lines, and
 * goods receipts read over the Lakehouse SQL analytics endpoint (read-only T-SQL, Entra auth) — the
 * AP counterpart of FabricLakehouseMasterDataReader. Table/column names are CONFIG-DRIVEN
 * (`InvoiceLakehouseConfig`), matching the admin "ERP vendor master + purchase orders" settings.
 *
 * Implements the vendor-first / prefix-tolerant PO resolution the pipeline needs:
 *  - findPoLinesForVendor → the matched vendor's POs,
 *  - findPoLinesByPoNumber → a cross-vendor lookup narrowed by a LIKE then confirmed with
 *    canonicalPoNumber (so a dropped "PO-" still matches).
 * Row→master mapping is pure and unit-tested; the live reader is gated behind LAKEHOUSE_SQL_SERVER.
 */
import sql from "mssql";
import { canonicalPoNumber } from "@coa/domain";
import type { GoodsReceipt, InvoiceMasterReader, PoLine, VendorMaster } from "./invoice-masters.js";
import { lakehouseConfigFromEnv } from "./fabric-lakehouse-reader.js";

export interface VendorColumns {
  account: string;
  name: string;
  company?: string;
  status?: string;
  taxId?: string;
  aliases?: string;
}
export interface PoLineColumns {
  company?: string;
  poNumber: string;
  poLineRef: string;
  erpItemId: string;
  vendorAccount: string;
  orderedQty: string;
  unitPrice: string;
  uom?: string;
}
export interface ReceiptColumns {
  company?: string;
  poNumber: string;
  poLineRef: string;
  receivedQty: string;
}
export interface InvoiceLakehouseConfig {
  vendors: { table: string; columns: VendorColumns };
  poLines: { table: string; columns: PoLineColumns };
  receipts: { table: string; columns: ReceiptColumns };
  multiValueDelimiter?: string;
}

/** Defaults mirror the admin settings defaults; confirm against the real Lakehouse schema (Q-FAB-1). */
export const DEFAULT_INVOICE_LAKEHOUSE_CONFIG: InvoiceLakehouseConfig = {
  vendors: { table: "gold.ax_vendmaster", columns: { account: "vendaccount", name: "name", company: "dataareaid", status: "blocked" } },
  poLines: { table: "gold.ax_purchline", columns: { company: "dataareaid", poNumber: "purchid", poLineRef: "linenum", erpItemId: "itemid", vendorAccount: "orderaccount", orderedQty: "purchqty", unitPrice: "purchprice", uom: "purchunit" } },
  receipts: { table: "gold.ax_packingslip", columns: { company: "dataareaid", poNumber: "purchid", poLineRef: "linenum", receivedQty: "qty" } },
  multiValueDelimiter: ",",
};

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number => (v == null || v === "" ? 0 : Number(v));
const splitMulti = (v: unknown, delim: string): string[] => (v == null ? [] : String(v).split(delim).map((s) => s.trim()).filter(Boolean));
const toStatus = (v: unknown): "ACTIVE" | "INACTIVE" => (["inactive", "disabled", "blocked", "1", "true", "y"].includes(String(v ?? "").toLowerCase()) ? "INACTIVE" : "ACTIVE");

export function mapVendorRow(row: Row, cols: VendorColumns, delim = ","): VendorMaster {
  return {
    erpVendorAccount: str(row[cols.account]),
    companyId: cols.company ? str(row[cols.company]) : "",
    name: str(row[cols.name]),
    taxId: cols.taxId ? str(row[cols.taxId]) : null,
    aliases: cols.aliases ? splitMulti(row[cols.aliases], delim) : [],
    status: cols.status ? toStatus(row[cols.status]) : "ACTIVE",
  };
}
export function mapPoLineRow(row: Row, cols: PoLineColumns): PoLine {
  return {
    companyId: cols.company ? str(row[cols.company]) : "",
    poNumber: str(row[cols.poNumber]),
    poLineRef: str(row[cols.poLineRef]),
    erpItemId: str(row[cols.erpItemId]),
    erpVendorAccount: str(row[cols.vendorAccount]),
    orderedQty: num(row[cols.orderedQty]),
    unitPrice: num(row[cols.unitPrice]),
    uom: cols.uom ? str(row[cols.uom]) : "",
  };
}
export function mapReceiptRow(row: Row, cols: ReceiptColumns): GoodsReceipt {
  return {
    companyId: cols.company ? str(row[cols.company]) : "",
    poNumber: str(row[cols.poNumber]),
    poLineRef: str(row[cols.poLineRef]),
    receivedQty: num(row[cols.receivedQty]),
  };
}

function selectList(cols: Record<string, string | undefined>): string {
  const names = Object.values(cols).filter((c): c is string => Boolean(c));
  return [...new Set(names)].map((c) => `[${c}]`).join(", ");
}

export class FabricInvoiceLakehouseReader implements InvoiceMasterReader {
  private readonly delim: string;
  constructor(private readonly pool: sql.ConnectionPool, private readonly config: InvoiceLakehouseConfig = DEFAULT_INVOICE_LAKEHOUSE_CONFIG) {
    this.delim = config.multiValueDelimiter ?? ",";
  }

  async findVendors(companyId: string): Promise<VendorMaster[]> {
    const { table, columns } = this.config.vendors;
    const req = this.pool.request();
    const where = columns.company ? `WHERE [${columns.company}] = @company` : "";
    if (columns.company) req.input("company", sql.VarChar(50), companyId);
    const res = await req.query(`SELECT ${selectList(columns as unknown as Record<string, string | undefined>)} FROM ${table} ${where}`);
    return res.recordset.map((r) => mapVendorRow(r, columns, this.delim)).filter((v) => v.status === "ACTIVE");
  }

  async findPoLines(companyId: string, poNumber: string): Promise<PoLine[]> {
    return this.queryPoLines(`[${this.config.poLines.columns.poNumber}] = @po`, (req) => req.input("po", sql.VarChar(100), poNumber), companyId);
  }

  async findPoLinesForVendor(companyId: string, erpVendorAccount: string): Promise<PoLine[]> {
    return this.queryPoLines(`[${this.config.poLines.columns.vendorAccount}] = @vendor`, (req) => req.input("vendor", sql.VarChar(50), erpVendorAccount), companyId);
  }

  async findPoLinesByPoNumber(companyId: string, canonicalPo: string): Promise<PoLine[]> {
    // Narrow with a suffix LIKE on the canonical digits, then confirm precisely in JS (prefix-tolerant).
    const rows = await this.queryPoLines(`[${this.config.poLines.columns.poNumber}] LIKE @like`, (req) => req.input("like", sql.VarChar(120), `%${canonicalPo}`), companyId);
    return rows.filter((l) => canonicalPoNumber(l.poNumber) === canonicalPo);
  }

  async findReceipts(companyId: string, poNumber: string): Promise<GoodsReceipt[]> {
    const { table, columns } = this.config.receipts;
    const req = this.pool.request().input("po", sql.VarChar(100), poNumber);
    const companyClause = columns.company ? `[${columns.company}] = @company AND ` : "";
    if (columns.company) req.input("company", sql.VarChar(50), companyId);
    const res = await req.query(`SELECT ${selectList(columns as unknown as Record<string, string | undefined>)} FROM ${table} WHERE ${companyClause}[${columns.poNumber}] = @po`);
    return res.recordset.map((r) => mapReceiptRow(r, columns));
  }

  private async queryPoLines(predicate: string, bind: (req: sql.Request) => sql.Request, companyId: string): Promise<PoLine[]> {
    const { table, columns } = this.config.poLines;
    let req = this.pool.request();
    const companyClause = columns.company ? `[${columns.company}] = @company AND ` : "";
    if (columns.company) req = req.input("company", sql.VarChar(50), companyId);
    req = bind(req);
    const res = await req.query(`SELECT ${selectList(columns as unknown as Record<string, string | undefined>)} FROM ${table} WHERE ${companyClause}${predicate}`);
    return res.recordset.map((r) => mapPoLineRow(r, columns));
  }
}

/** The admin-configured table/column coordinates (a subset of the Settings connections config). */
export interface InvoiceLakehouseTableConfig {
  vendorTable: string;
  vendorAccountColumn: string;
  vendorNameColumn: string;
  poTable: string;
  poNumberColumn: string;
  poVendorColumn: string;
}

/** Build the full reader config from the admin-configured tables/columns, defaulting the rest. */
export function invoiceLakehouseConfigFrom(c: InvoiceLakehouseTableConfig): InvoiceLakehouseConfig {
  return {
    vendors: { table: c.vendorTable, columns: { account: c.vendorAccountColumn, name: c.vendorNameColumn, company: DEFAULT_INVOICE_LAKEHOUSE_CONFIG.vendors.columns.company, status: DEFAULT_INVOICE_LAKEHOUSE_CONFIG.vendors.columns.status } },
    poLines: { table: c.poTable, columns: { ...DEFAULT_INVOICE_LAKEHOUSE_CONFIG.poLines.columns, poNumber: c.poNumberColumn, vendorAccount: c.poVendorColumn } },
    receipts: DEFAULT_INVOICE_LAKEHOUSE_CONFIG.receipts,
    multiValueDelimiter: DEFAULT_INVOICE_LAKEHOUSE_CONFIG.multiValueDelimiter,
  };
}

export async function createFabricInvoiceLakehouseReader(config?: InvoiceLakehouseConfig): Promise<FabricInvoiceLakehouseReader> {
  const pool = new sql.ConnectionPool(lakehouseConfigFromEnv());
  await pool.connect();
  return new FabricInvoiceLakehouseReader(pool, config ?? DEFAULT_INVOICE_LAKEHOUSE_CONFIG);
}
