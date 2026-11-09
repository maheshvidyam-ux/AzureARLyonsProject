import type { CustomerMaster, ItemMaster, MasterDataHealth, MasterDataReader } from "./ports.js";

export interface InMemoryMasterDataOptions {
  customers?: CustomerMaster[];
  items?: ItemMaster[];
  /** Simulated last-refresh timestamp; drives the freshness/health signal. */
  lastRefreshed?: string | null;
  /** Mark the read model stale (older than the freshness SLA) to exercise the controlled exception. */
  stale?: boolean;
}

/** In-memory master-data reader (tests / local demo). Real Fabric read adapter is gated on Q-FAB-1. */
export class InMemoryMasterDataReader implements MasterDataReader {
  private readonly customers: CustomerMaster[];
  private readonly items: ItemMaster[];
  private readonly lastRefreshed: string | null;
  private readonly stale: boolean;

  constructor(opts: InMemoryMasterDataOptions = {}) {
    this.customers = opts.customers ?? [];
    this.items = opts.items ?? [];
    this.lastRefreshed = opts.lastRefreshed ?? "2026-11-08T00:00:00Z";
    this.stale = opts.stale ?? false;
  }

  async findCustomers(companyId: string): Promise<CustomerMaster[]> {
    return this.customers.filter((c) => c.companyId === companyId && c.status === "ACTIVE");
  }

  async findItems(companyId: string): Promise<ItemMaster[]> {
    return this.items.filter((i) => i.companyId === companyId && i.status === "ACTIVE");
  }

  async health(): Promise<MasterDataHealth> {
    return { lastRefreshed: this.lastRefreshed, healthy: !this.stale, stale: this.stale };
  }
}
