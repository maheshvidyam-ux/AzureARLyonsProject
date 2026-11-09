/**
 * Phase 3 — Fabric Lakehouse master-data reader (spec §6, Q-FAB-1). Row→master mapping is pure
 * and tested here; the live reader (Lakehouse SQL analytics endpoint) is gated behind
 * LAKEHOUSE_SQL_SERVER.
 */
import { describe, expect, it } from "vitest";
import {
  mapCustomerRow,
  mapItemRow,
  type CustomerColumns,
  type ItemColumns,
} from "@coa/fabric-read";

const CUST: CustomerColumns = { account: "erp_customer_account", name: "customer_name", company: "data_area_id", status: "status", aliases: "aliases" };
const ITEM: ItemColumns = { erpItemId: "erp_item_id", sku: "item_number", company: "data_area_id", status: "status", uom: "uom", gtins: "gtins" };

describe("lakehouse row mapping", () => {
  it("maps a customer row (multi-value aliases, status)", () => {
    const m = mapCustomerRow(
      { erp_customer_account: "ACME01", customer_name: "Acme Industrial Supply", data_area_id: "USMF", status: "Active", aliases: "Acme Ind., Acme Industrial" },
      CUST,
    );
    expect(m).toMatchObject({ erpCustomerAccount: "ACME01", companyId: "USMF", name: "Acme Industrial Supply", status: "ACTIVE" });
    expect(m.aliases).toEqual(["Acme Ind.", "Acme Industrial"]);
  });

  it("marks inactive customers", () => {
    expect(mapCustomerRow({ erp_customer_account: "X", customer_name: "Y", data_area_id: "USMF", status: "Inactive" }, CUST).status).toBe("INACTIVE");
  });

  it("maps an item row (uom, gtins)", () => {
    const m = mapItemRow(
      { erp_item_id: "ITM-778", item_number: "ACM-778", data_area_id: "USMF", uom: "EA", status: "Active", gtins: "00012345678905" },
      ITEM,
    );
    expect(m).toMatchObject({ erpItemId: "ITM-778", sku: "ACM-778", companyId: "USMF", uom: "EA", status: "ACTIVE" });
    expect(m.gtins).toEqual(["00012345678905"]);
  });
});

const hasLake = Boolean(process.env.LAKEHOUSE_SQL_SERVER && process.env.LAKEHOUSE_DATABASE);
describe.skipIf(!hasLake)("FabricLakehouseMasterDataReader (live)", () => {
  it("reads customer + item masters from the Lakehouse SQL endpoint", async () => {
    const { createFabricLakehouseReader } = await import("@coa/fabric-read");
    const reader = await createFabricLakehouseReader();
    const company = process.env.LAKEHOUSE_COMPANY ?? "USMF";
    const customers = await reader.findCustomers(company);
    const items = await reader.findItems(company);
    expect(Array.isArray(customers)).toBe(true);
    expect(Array.isArray(items)).toBe(true);
    console.log(`[lakehouse] ${customers.length} customers, ${items.length} items for ${company}`);
  }, 120_000);
});
