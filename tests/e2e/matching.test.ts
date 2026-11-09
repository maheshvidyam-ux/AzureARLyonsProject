/**
 * Phase 3 — customer + item matching (spec §6). Ranked strategies, ambiguity → UNMATCHED,
 * and the rule that a description-only resemblance never auto-matches an item.
 */
import { describe, expect, it } from "vitest";
import { matchCustomer, matchItem } from "@coa/matching";
import type { CustomerMaster } from "@coa/fabric-read";
import { SAMPLE_CUSTOMERS, SAMPLE_ITEMS } from "../../mocks/fabric/sample-masters.js";

describe("matchCustomer", () => {
  it("exact name → EXACT with the ERP account", () => {
    const r = matchCustomer({ name: "Acme Industrial Supply" }, SAMPLE_CUSTOMERS);
    expect(r.matchStatus).toBe("EXACT");
    expect(r.erpCustomerAccount).toBe("ACME01");
  });

  it("alias → ALIAS", () => {
    const r = matchCustomer({ name: "Acme Ind. Supply" }, SAMPLE_CUSTOMERS);
    expect(r.matchStatus).toBe("ALIAS");
    expect(r.erpCustomerAccount).toBe("ACME01");
  });

  it("buyer cross-reference → CROSS_REF", () => {
    const r = matchCustomer({ name: "Unknown", accountRef: "ACME-BUYER-01" }, SAMPLE_CUSTOMERS);
    expect(r.matchStatus).toBe("CROSS_REF");
    expect(r.erpCustomerAccount).toBe("ACME01");
  });

  it("ambiguous exact names → UNMATCHED (no guess)", () => {
    const dupes: CustomerMaster[] = [
      { erpCustomerAccount: "A1", companyId: "USMF", name: "Same Co", status: "ACTIVE" },
      { erpCustomerAccount: "A2", companyId: "USMF", name: "Same Co", status: "ACTIVE" },
    ];
    const r = matchCustomer({ name: "Same Co" }, dupes);
    expect(r.matchStatus).toBe("UNMATCHED");
    expect(r.ambiguous).toBe(true);
    expect(r.erpCustomerAccount).toBeNull();
  });

  it("no plausible match → UNMATCHED", () => {
    expect(matchCustomer({ name: "Totally Unknown Buyer" }, SAMPLE_CUSTOMERS).erpCustomerAccount).toBeNull();
  });
});

describe("matchItem", () => {
  it("exact SKU → EXACT_SKU", () => {
    const r = matchItem({ customerItemCode: "ACM-778" }, SAMPLE_ITEMS, "ACME01");
    expect(r.matchStatus).toBe("EXACT_SKU");
    expect(r.erpItemId).toBe("ITM-778");
  });

  it("customer item code map → CUSTOMER_MAP", () => {
    const r = matchItem({ customerItemCode: "A902" }, SAMPLE_ITEMS, "ACME01");
    expect(r.matchStatus).toBe("CUSTOMER_MAP");
    expect(r.erpItemId).toBe("ITM-902");
  });

  it("GTIN → GTIN", () => {
    const r = matchItem({ customerItemCode: null, gtin: "00012345678905" }, SAMPLE_ITEMS, null);
    expect(r.matchStatus).toBe("GTIN");
    expect(r.erpItemId).toBe("ITM-778");
  });

  it("description only → UNMATCHED (never auto-matches)", () => {
    const r = matchItem({ customerItemCode: null, description: "1/2in Hex Bolt, Zinc" }, SAMPLE_ITEMS, "ACME01");
    expect(r.matchStatus).toBe("UNMATCHED");
    expect(r.erpItemId).toBeNull();
  });
});
