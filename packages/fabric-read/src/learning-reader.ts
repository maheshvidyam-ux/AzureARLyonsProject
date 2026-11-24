/**
 * Learning layer (spec §6 "HISTORY matching — learned aliases"). Wraps any MasterDataReader and
 * overlays aliases learned from CSR corrections onto the ERP masters: a corrected customer name is
 * added to that account's aliases, and a corrected item code to that item's per-customer codes. The
 * matcher is unchanged — it just finds, via its normal ALIAS / CUSTOMER_MAP paths, the mapping a
 * human taught it earlier. So a correction made once stops recurring.
 *
 * The overlay is supplied as plain data (not a persistence dependency) so this package stays a pure
 * read model; the worker wires `persistence.listLearnedAliases` → `aliasOverlayFromRows` → here.
 */
import type { CustomerMaster, ItemMaster, MasterDataHealth, MasterDataReader } from "./ports.js";

export interface AliasOverlay {
  /** learned: this seen customer text → this ERP account. */
  customers: Array<{ text: string; erpCustomerAccount: string }>;
  /** learned: for this ERP account (scope), this item code → this ERP item. */
  items: Array<{ erpCustomerAccount: string | null; code: string; erpItemId: string }>;
}

/** Map persisted learned-alias rows (loose shape) to the overlay the augmented reader consumes. */
export function aliasOverlayFromRows(
  rows: ReadonlyArray<{ kind: string; text: string; erpCustomerAccount: string | null; erpItemId: string | null }>,
): AliasOverlay {
  const customers: AliasOverlay["customers"] = [];
  const items: AliasOverlay["items"] = [];
  for (const r of rows) {
    if (r.kind === "customer" && r.erpCustomerAccount) customers.push({ text: r.text, erpCustomerAccount: r.erpCustomerAccount });
    else if (r.kind === "item" && r.erpItemId) items.push({ erpCustomerAccount: r.erpCustomerAccount, code: r.text, erpItemId: r.erpItemId });
  }
  return { customers, items };
}

export class LearningAugmentedMasterReader implements MasterDataReader {
  constructor(
    private readonly base: MasterDataReader,
    private readonly overlayFor: (companyId: string) => Promise<AliasOverlay>,
  ) {}

  async findCustomers(companyId: string): Promise<CustomerMaster[]> {
    const [base, overlay] = await Promise.all([this.base.findCustomers(companyId), this.overlayFor(companyId)]);
    if (overlay.customers.length === 0) return base;
    return base.map((c) => {
      const learned = overlay.customers.filter((a) => a.erpCustomerAccount === c.erpCustomerAccount).map((a) => a.text);
      return learned.length ? { ...c, aliases: [...(c.aliases ?? []), ...learned] } : c;
    });
  }

  async findItems(companyId: string): Promise<ItemMaster[]> {
    const [base, overlay] = await Promise.all([this.base.findItems(companyId), this.overlayFor(companyId)]);
    if (overlay.items.length === 0) return base;
    return base.map((it) => {
      const learned = overlay.items.filter((a) => a.erpItemId === it.erpItemId);
      if (learned.length === 0) return it;
      const codes: Record<string, string[]> = { ...(it.customerItemCodes ?? {}) };
      for (const a of learned) {
        const key = a.erpCustomerAccount ?? "_ANY_";
        codes[key] = [...(codes[key] ?? []), a.code];
      }
      return { ...it, customerItemCodes: codes };
    });
  }

  health(): Promise<MasterDataHealth> {
    return this.base.health();
  }
}
