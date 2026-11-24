/**
 * Real AP Lakehouse reader — pure row mappers (vendor / PO line / receipt), the config mapper that
 * turns the admin-configured tables/columns into a reader config, and the prefix-tolerant
 * cross-vendor PO lookup (canonical filter applied to the LIKE-narrowed rows). No live Azure: the
 * class is driven through a fake mssql pool.
 */
import { describe, expect, it } from "vitest";
import {
  FabricInvoiceLakehouseReader,
  invoiceLakehouseConfigFrom,
  mapPoLineRow,
  mapReceiptRow,
  mapVendorRow,
  DEFAULT_INVOICE_LAKEHOUSE_CONFIG,
} from "@coa/fabric-read";

const V = DEFAULT_INVOICE_LAKEHOUSE_CONFIG.vendors.columns;
const P = DEFAULT_INVOICE_LAKEHOUSE_CONFIG.poLines.columns;
const R = DEFAULT_INVOICE_LAKEHOUSE_CONFIG.receipts.columns;

describe("AP lakehouse row mappers", () => {
  it("maps a vendor row", () => {
    const v = mapVendorRow({ vendaccount: "VEND-ACME", name: "Acme", dataareaid: "USMF", blocked: "0" }, V);
    expect(v).toMatchObject({ erpVendorAccount: "VEND-ACME", name: "Acme", companyId: "USMF", status: "ACTIVE" });
  });
  it("maps a PO line (numeric qty/price)", () => {
    const l = mapPoLineRow({ dataareaid: "USMF", purchid: "PO-100045", linenum: "1", itemid: "ITM-778", orderaccount: "VEND-ACME", purchqty: "500", purchprice: "1.5", purchunit: "EA" }, P);
    expect(l).toMatchObject({ companyId: "USMF", poNumber: "PO-100045", poLineRef: "1", erpItemId: "ITM-778", erpVendorAccount: "VEND-ACME", orderedQty: 500, unitPrice: 1.5, uom: "EA" });
  });
  it("maps a receipt row", () => {
    expect(mapReceiptRow({ dataareaid: "USMF", purchid: "PO-100045", linenum: "1", qty: "500" }, R)).toMatchObject({ poNumber: "PO-100045", receivedQty: 500 });
  });
});

describe("invoiceLakehouseConfigFrom", () => {
  it("applies the admin tables/columns and defaults the rest", () => {
    const cfg = invoiceLakehouseConfigFrom({ vendorTable: "g.vend", vendorAccountColumn: "va", vendorNameColumn: "vn", poTable: "g.po", poNumberColumn: "pn", poVendorColumn: "pv" });
    expect(cfg.vendors.table).toBe("g.vend");
    expect(cfg.vendors.columns).toMatchObject({ account: "va", name: "vn" });
    expect(cfg.poLines.table).toBe("g.po");
    expect(cfg.poLines.columns).toMatchObject({ poNumber: "pn", vendorAccount: "pv", poLineRef: P.poLineRef, orderedQty: P.orderedQty });
  });
});

/** Minimal fake mssql pool: each request records inputs and returns the canned recordset. */
function fakePool(recordset: Record<string, unknown>[]) {
  const req = {
    input() {
      return req;
    },
    async query() {
      return { recordset };
    },
  };
  return { request: () => req } as never;
}

describe("FabricInvoiceLakehouseReader.findPoLinesByPoNumber", () => {
  it("confirms the LIKE-narrowed rows with canonicalPoNumber (prefix-tolerant)", async () => {
    // The DB LIKE might return extra rows; the JS canonical filter keeps only true matches.
    const rows = [
      { dataareaid: "USMF", purchid: "PO-100045", linenum: "1", itemid: "ITM-778", orderaccount: "VEND-ACME", purchqty: "500", purchprice: "1.5", purchunit: "EA" },
      { dataareaid: "USMF", purchid: "PO-9100045", linenum: "1", itemid: "ITM-9", orderaccount: "VEND-X", purchqty: "1", purchprice: "1", purchunit: "EA" },
    ];
    const reader = new FabricInvoiceLakehouseReader(fakePool(rows));
    const matched = await reader.findPoLinesByPoNumber("USMF", "100045");
    expect(matched).toHaveLength(1);
    expect(matched[0]!.poNumber).toBe("PO-100045");
    expect(matched[0]!.erpVendorAccount).toBe("VEND-ACME");
  });
});
