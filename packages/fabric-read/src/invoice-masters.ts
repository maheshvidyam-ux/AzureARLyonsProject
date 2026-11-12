/**
 * AP master-data read model (AP_INVOICE module): vendors, open PO lines, and goods receipts —
 * the data the invoice pipeline needs for vendor matching and **3-way match** (invoice ↔ PO ↔
 * receipt). Like the AR masters these live in the Fabric Lakehouse (`gold.ax_vendmaster`,
 * `gold.ax_purchline`, `gold.ax_packingslip`/receipts — exact tables Q-FAB-1); an in-memory
 * reader backs tests, the real Lakehouse reader is a follow-up.
 */
export interface VendorMaster {
  erpVendorAccount: string;
  companyId: string;
  name: string;
  taxId?: string | null;
  aliases?: string[];
  status: "ACTIVE" | "INACTIVE";
}

/** An open PO line available to invoice against. */
export interface PoLine {
  companyId: string;
  poNumber: string;
  poLineRef: string;
  erpItemId: string;
  erpVendorAccount: string;
  orderedQty: number;
  unitPrice: number;
  uom: string;
}

/** A goods-receipt record (packing slip) for 3-way match. */
export interface GoodsReceipt {
  companyId: string;
  poNumber: string;
  poLineRef: string;
  receivedQty: number;
}

export interface InvoiceMasterReader {
  findVendors(companyId: string): Promise<VendorMaster[]>;
  findPoLines(companyId: string, poNumber: string): Promise<PoLine[]>;
  findReceipts(companyId: string, poNumber: string): Promise<GoodsReceipt[]>;
}

export interface InMemoryInvoiceMastersOptions {
  vendors?: VendorMaster[];
  poLines?: PoLine[];
  receipts?: GoodsReceipt[];
}

export class InMemoryInvoiceMasterReader implements InvoiceMasterReader {
  private readonly vendors: VendorMaster[];
  private readonly poLines: PoLine[];
  private readonly receipts: GoodsReceipt[];
  constructor(opts: InMemoryInvoiceMastersOptions = {}) {
    this.vendors = opts.vendors ?? [];
    this.poLines = opts.poLines ?? [];
    this.receipts = opts.receipts ?? [];
  }
  async findVendors(companyId: string): Promise<VendorMaster[]> {
    return this.vendors.filter((v) => v.companyId === companyId && v.status === "ACTIVE");
  }
  async findPoLines(companyId: string, poNumber: string): Promise<PoLine[]> {
    return this.poLines.filter((l) => l.companyId === companyId && l.poNumber === poNumber);
  }
  async findReceipts(companyId: string, poNumber: string): Promise<GoodsReceipt[]> {
    return this.receipts.filter((r) => r.companyId === companyId && r.poNumber === poNumber);
  }
}
