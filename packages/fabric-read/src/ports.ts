/**
 * Fabric master-data read model (spec §6). Customer/item masters are read-only reference data
 * owned by Microsoft Fabric; this port is the local indexed read model the matcher queries. A
 * mock reader backs tests; the real Fabric SQL-endpoint adapter is gated on Q-FAB-1/Q-FAB-3
 * (actual table schemas + supported read access pattern), so it is intentionally not built yet.
 *
 * "Do not invent fields or assume all exist" (spec §6): these shapes are the minimal fields the
 * matcher needs and MUST be reconciled with the real Fabric schema (Q-FAB-1) before the real
 * adapter is written.
 */
export interface CustomerMaster {
  erpCustomerAccount: string;
  companyId: string;
  name: string;
  /** Buyer/account cross-reference identifiers the customer puts on their POs. */
  crossRefs?: string[];
  /** Known alternate names. */
  aliases?: string[];
  /** Normalized address lines for address-based matching. */
  addresses?: string[];
  status: "ACTIVE" | "INACTIVE";
}

export interface ItemMaster {
  erpItemId: string;
  companyId: string;
  sku: string;
  gtins?: string[];
  /** Per-customer item codes: erpCustomerAccount -> that customer's codes for this item. */
  customerItemCodes?: Record<string, string[]>;
  uom: string;
  status: "ACTIVE" | "INACTIVE";
}

export interface MasterDataHealth {
  /** ISO timestamp of the last successful refresh of the read model, or null if never. */
  lastRefreshed: string | null;
  /** true when the read model is within its freshness SLA (Q-FAB-4). */
  healthy: boolean;
  /** true when data is older than the freshness SLA — matches must degrade to a controlled exception. */
  stale: boolean;
}

export interface MasterDataReader {
  findCustomers(companyId: string): Promise<CustomerMaster[]>;
  findItems(companyId: string): Promise<ItemMaster[]>;
  health(): Promise<MasterDataHealth>;
}
