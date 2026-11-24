/**
 * Deterministic evaluation of a normalized order: structural/arithmetic rules (structural.ts) +
 * Fabric master-data matching (customer + items). Shared by the ingestion pipeline (first pass)
 * and the reviewer revalidate endpoint (after a CSR corrects the CDM), so both produce findings
 * from the SAME rules — there is one source of truth for "is this order clean?".
 *
 * Side effect: mutates `po.header.customer` and `po.lines[].erp_item_id` with the match result,
 * and sets `po.validation`. It HONORS values already assigned: a present erp_customer_account /
 * erp_item_id (e.g. a CSR's manual correction) is trusted and not re-matched, so re-evaluating a
 * corrected order clears the UNMATCHED finding. On the pipeline's first pass nothing is assigned,
 * so behaviour there is unchanged.
 */
import type { NormalizedPurchaseOrder, ValidationFinding } from "@coa/po-schema";
import type { MasterDataReader } from "@coa/fabric-read";
import { matchCustomer, matchItem } from "@coa/matching";
import { validateStructural } from "./structural.js";

function blockingErr(code: string, field_path: string | null, message: string): ValidationFinding {
  return { severity: "ERROR", code, field_path, message, blocking: true };
}

export async function evaluateOrder(po: NormalizedPurchaseOrder, masters?: MasterDataReader): Promise<ValidationFinding[]> {
  const findings = validateStructural(po);

  if (!masters) {
    findings.push({
      severity: "WARNING",
      code: "CUSTOMER_MATCH_DEFERRED",
      field_path: "header.customer.erp_customer_account",
      message: "Customer not matched (no Fabric read model wired).",
      blocking: false,
    });
    po.validation = findings;
    return findings;
  }

  const health = await masters.health();
  if (health.stale) {
    findings.push(blockingErr("MASTER_DATA_STALE", null, `Fabric master data is stale (last refreshed ${health.lastRefreshed ?? "never"}); matching withheld.`));
    po.validation = findings;
    return findings;
  }

  const companyId = po.company.company_id;
  const [customers, items] = await Promise.all([masters.findCustomers(companyId), masters.findItems(companyId)]);

  // Customer: trust an already-assigned ERP account (CSR correction / prior match); else match fresh.
  let erpAccount = po.header.customer?.erp_customer_account?.value ?? null;
  if (!erpAccount) {
    const cm = matchCustomer(
      { name: po.header.customer?.name?.value ?? null, billTo: po.header.bill_to?.value ?? null, shipTo: po.header.ship_to?.value ?? null },
      customers,
    );
    erpAccount = cm.erpCustomerAccount;
    po.header.customer = {
      ...(po.header.customer ?? {}),
      erp_customer_account: { value: cm.erpCustomerAccount, confidence: cm.confidence, evidence: { prediction_source: null, raw_text: cm.evidence } },
      match_status: cm.matchStatus,
    };
  }
  if (!erpAccount) {
    findings.push(blockingErr("CUSTOMER_UNMATCHED", "header.customer", "Customer not matched to an ERP account."));
  }

  // Lines: trust an already-assigned ERP item id; else match against masters.
  po.lines.forEach((line, i) => {
    const assigned = line.erp_item_id?.value ?? null;
    if (!assigned) {
      const im = matchItem({ customerItemCode: line.customer_item_code?.value ?? null, description: line.description?.value ?? null }, items, erpAccount);
      line.erp_item_id = { value: im.erpItemId, confidence: im.confidence, evidence: { prediction_source: null, raw_text: im.evidence } };
      line.match_status = im.matchStatus;
    }
    if (!line.erp_item_id?.value) {
      findings.push(blockingErr("ITEM_UNMATCHED", `lines[${i}]`, `Line ${i + 1} item not matched.`));
    }
  });

  po.validation = findings;
  return findings;
}
