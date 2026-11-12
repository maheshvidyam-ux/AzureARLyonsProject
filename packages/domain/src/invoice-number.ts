/**
 * Invoice-number normalization + the AP duplicate business key (AP_INVOICE module).
 *
 * ⚠️ PROVISIONAL rule (mirrors Q-DUP-1 for AR): canonicalization of a vendor invoice number is a
 * business decision. Conservative default: trim, uppercase, strip non-alphanumerics. The invoice
 * dedup key is `company_id :: erp_vendor_account :: normalized_invoice_number` — enforced by the
 * same atomic filtered-unique-index claim the AR module uses (module-qualified), so the same
 * vendor invoice can never be posted to AX twice.
 */
export function normalizeInvoiceNumber(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.length > 0 ? cleaned : null;
}

export function invoiceBusinessKey(input: {
  companyId: string;
  erpVendorAccount: string | null;
  normalizedInvoiceNumber: string | null;
}): string | null {
  const { companyId, erpVendorAccount, normalizedInvoiceNumber } = input;
  if (!erpVendorAccount || !normalizedInvoiceNumber) return null;
  // Module-qualified so AR and AP keys never collide in the shared claim table.
  return `AP::${companyId}::${erpVendorAccount}::${normalizedInvoiceNumber}`;
}
