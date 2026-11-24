/**
 * Turn a reviewer edit into field-level correction records — the labeled dataset the learning layer
 * (alias memory + few-shot) consumes. For each field the patch actually changes, we emit one
 * correction with the original → corrected values, a kind, and enough CONTEXT to learn from:
 *   - customer_match: the extractor's customer name + bill/ship-to → the chosen ERP account.
 *   - item_match: the line's customer item code + description (+ ERP account) → the chosen ERP item.
 * This is where "the system learns what the CSR taught it" begins; nothing here writes storage —
 * the persistence impls assign id/at and insert.
 */
import type { CdmCorrectionRow, OrderReviewDetail, UpdateOrderInput } from "./ports.js";

export type CorrectionInput = Omit<CdmCorrectionRow, "id" | "at">;

/** A mapping the system should remember, derived from a confirmed match correction. */
export interface LearnedAliasInput {
  companyId: string;
  kind: "customer" | "item";
  text: string;
  erpCustomerAccount: string | null;
  erpItemId: string | null;
}

/**
 * Promote match corrections into learned aliases: a customer_match teaches "this seen name →
 * this ERP account"; an item_match teaches "for this account, this item code → this ERP item".
 * Only corrections with the key context (name / item code) become aliases.
 */
export function aliasesFromCorrections(corrections: CorrectionInput[]): LearnedAliasInput[] {
  const out: LearnedAliasInput[] = [];
  for (const c of corrections) {
    const ctx = c.context ?? {};
    if (c.kind === "customer_match" && c.correctedValue) {
      const name = typeof ctx.customerName === "string" ? ctx.customerName : null;
      if (name) out.push({ companyId: c.companyId, kind: "customer", text: name, erpCustomerAccount: c.correctedValue, erpItemId: null });
    } else if (c.kind === "item_match" && c.correctedValue) {
      const code = typeof ctx.customerItemCode === "string" ? ctx.customerItemCode : null;
      const acct = typeof ctx.erpCustomerAccount === "string" ? ctx.erpCustomerAccount : null;
      if (code) out.push({ companyId: c.companyId, kind: "item", text: code, erpCustomerAccount: acct, erpItemId: c.correctedValue });
    }
  }
  return out;
}

const str = (v: unknown): string | null => (v == null ? null : String(v));

/** Safe nested read on the stored normalized JSON (kept po-schema-free so persistence has no dep on it). */
function normLineDescription(normalized: unknown, index: number): string | null {
  const lines = (normalized as { lines?: Array<{ description?: { value?: unknown } }> } | null)?.lines;
  return str(lines?.[index]?.description?.value ?? null);
}
function normCustomerName(normalized: unknown): string | null {
  return str((normalized as { header?: { customer?: { name?: { value?: unknown } } } } | null)?.header?.customer?.name?.value ?? null);
}

const HEADER_FIELDS = [
  ["erpCustomerAccount", "header.erp_customer_account", "customer_match"],
  ["customerPoNumber", "header.customer_po_number", "value"],
  ["poDate", "header.po_date", "value"],
  ["shipTo", "header.ship_to", "value"],
  ["billTo", "header.bill_to", "value"],
  ["currency", "header.currency", "format"],
  ["total", "header.total", "value"],
] as const;

const LINE_FIELDS = [
  ["erpItemId", "line.erp_item_id", "item_match"],
  ["quantity", "line.quantity", "value"],
  ["uom", "line.uom", "value"],
  ["unitPrice", "line.unit_price", "value"],
] as const;

export function computeCorrections(detail: OrderReviewDetail, patch: UpdateOrderInput, actor: string, moduleCode = "ORDER_PROCESSING"): CorrectionInput[] {
  const out: CorrectionInput[] = [];
  const companyId = detail.header.companyId;
  const orderHeaderId = detail.header.id;
  const base = { companyId, moduleCode, orderHeaderId, actor } as const;

  if (patch.header) {
    const h = patch.header as Record<string, unknown>;
    const cur = detail.header as unknown as Record<string, unknown>;
    for (const [key, fieldPath, kind] of HEADER_FIELDS) {
      if (!(key in h)) continue;
      const before = cur[key] ?? null;
      const after = h[key] ?? null;
      if (str(before) === str(after)) continue;
      out.push({
        ...base,
        lineId: null,
        entity: "header",
        fieldPath,
        originalValue: str(before),
        correctedValue: str(after),
        kind,
        context: kind === "customer_match" ? { customerName: normCustomerName(detail.normalized), billTo: detail.header.billTo, shipTo: detail.header.shipTo } : null,
      });
    }
  }

  for (const lp of patch.lines ?? []) {
    const idx = detail.lines.findIndex((l) => l.lineId === lp.lineId);
    const cur = detail.lines[idx] as unknown as Record<string, unknown> | undefined;
    if (!cur) continue;
    const lpAny = lp as unknown as Record<string, unknown>;
    for (const [key, fieldPath, kind] of LINE_FIELDS) {
      if (!(key in lpAny)) continue;
      const before = cur[key] ?? null;
      const after = lpAny[key] ?? null;
      if (str(before) === str(after)) continue;
      out.push({
        ...base,
        lineId: lp.lineId,
        entity: "line",
        fieldPath,
        originalValue: str(before),
        correctedValue: str(after),
        kind,
        context:
          kind === "item_match"
            ? {
                erpCustomerAccount: (patch.header?.erpCustomerAccount ?? detail.header.erpCustomerAccount) ?? null,
                customerItemCode: detail.lines[idx]?.customerItemCode ?? null,
                description: normLineDescription(detail.normalized, idx),
              }
            : null,
      });
    }
  }

  return out;
}
