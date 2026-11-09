/**
 * TEST-ENV-ONLY sample Fabric master data (spec §18 — quarantined mock). Seeds the
 * `InMemoryMasterDataReader` so the `sample-po-001` fixture matches cleanly: customer
 * "Acme Industrial Supply" → ACME01, items ACM-778/ACM-902 → ERP item ids.
 *
 * ⚠️ These fields are placeholders — the real Fabric customer/item schema is Q-FAB-1.
 */
import type { CustomerMaster, ItemMaster } from "@coa/fabric-read";

export const SAMPLE_CUSTOMERS: CustomerMaster[] = [
  {
    erpCustomerAccount: "ACME01",
    companyId: "USMF",
    name: "Acme Industrial Supply",
    aliases: ["Acme Ind. Supply", "Acme Industrial"],
    crossRefs: ["ACME-BUYER-01"],
    addresses: ["Acme AP, PO Box 22, Columbus OH"],
    status: "ACTIVE",
  },
  {
    erpCustomerAccount: "GLOBEX7",
    companyId: "USMF",
    name: "Globex Corporation",
    status: "ACTIVE",
  },
];

export const SAMPLE_ITEMS: ItemMaster[] = [
  { erpItemId: "ITM-778", companyId: "USMF", sku: "ACM-778", gtins: ["00012345678905"], customerItemCodes: { ACME01: ["A778"] }, uom: "EA", status: "ACTIVE" },
  { erpItemId: "ITM-902", companyId: "USMF", sku: "ACM-902", customerItemCodes: { ACME01: ["A902"] }, uom: "EA", status: "ACTIVE" },
  { erpItemId: "ITM-511", companyId: "USMF", sku: "ACM-511", uom: "EA", status: "ACTIVE" },
];
