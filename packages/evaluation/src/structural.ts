/**
 * Deterministic validation (spec §7: "deterministic rules authorize staging; AI confidence
 * never bypasses a blocking check").
 *
 * SCOPE OF THIS SLICE: structural / arithmetic checks only. Customer, item, UOM and price
 * validation against Fabric masters is Phase 3 and is deliberately NOT performed here — so
 * an unmatched customer is an informational WARNING, not a blocking error, in this slice.
 *
 * ⚠️ The exact policy (required fields, price tolerances, thresholds) is OPEN as Q-VAL-1 /
 * Q-PRICE-1 in docs/07-contract-questions.md. The rules below are a conservative provisional
 * set and must be reconciled with the business answer before Phase 3.
 */
import type { NormalizedPurchaseOrder, ValidationFinding } from "@coa/po-schema";

const AMOUNT_TOLERANCE = 0.01;

export function validateStructural(po: NormalizedPurchaseOrder): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  // --- header ---
  if (!po.header.customer_po_number?.value) {
    findings.push(err("REQUIRED_PO_NUMBER_MISSING", "header.customer_po_number", "Customer PO number is required."));
  }
  if (!po.header.po_date?.value) {
    findings.push(warn("REQUIRED_PO_DATE_MISSING", "header.po_date", "PO date is missing."));
  }

  const currency = po.header.currency?.value;
  if (currency != null && !/^[A-Z]{3}$/.test(currency)) {
    findings.push(err("CURRENCY_FORMAT_INVALID", "header.currency", `Currency '${currency}' is not a 3-letter ISO 4217 code.`));
  }

  // Note: customer/item master matching is handled by the pipeline's matching step (Phase 3),
  // not here — this function covers structural/arithmetic checks only.

  // --- lines ---
  if (po.lines.length === 0) {
    findings.push(err("NO_LINES", "lines", "Order has no line items."));
  }

  let extendedSum = 0;
  let allExtendedPresent = po.lines.length > 0;

  po.lines.forEach((line, i) => {
    const qty = line.quantity?.value;
    if (qty == null || qty <= 0) {
      findings.push(err("LINE_QUANTITY_INVALID", `lines[${i}].quantity`, `Line ${i + 1} quantity must be greater than zero.`));
    }

    const price = line.unit_price?.value;
    const extended = line.extended_amount?.value;
    if (extended == null) {
      allExtendedPresent = false;
    } else {
      extendedSum += extended;
      if (qty != null && price != null) {
        const expected = round2(qty * price);
        if (Math.abs(expected - extended) > AMOUNT_TOLERANCE) {
          findings.push(
            warn("LINE_EXTENDED_MISMATCH", `lines[${i}].extended_amount`, `Line ${i + 1} extended amount ${extended} != quantity × unit price (${expected}).`),
          );
        }
      }
    }
  });

  // --- totals reconciliation ---
  const subtotal = po.header.totals?.subtotal?.amount;
  if (subtotal != null && allExtendedPresent && Math.abs(round2(extendedSum) - subtotal) > AMOUNT_TOLERANCE) {
    findings.push(
      warn("TOTALS_SUBTOTAL_MISMATCH", "header.totals.subtotal", `Line extended total ${round2(extendedSum)} does not match stated subtotal ${subtotal}.`),
    );
  }

  return findings;
}

function err(code: string, field_path: string, message: string): ValidationFinding {
  return { severity: "ERROR", code, field_path, message, blocking: true };
}

function warn(code: string, field_path: string, message: string): ValidationFinding {
  return { severity: "WARNING", code, field_path, message, blocking: false };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
