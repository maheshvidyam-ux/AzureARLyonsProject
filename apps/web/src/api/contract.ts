/**
 * Wire contract for the reviewer API. These shapes mirror the server-side interfaces in
 * packages/persistence/src/ports.ts (OrderSummaryRow, OrderReviewDetail, OrderHeaderPatch,
 * OrderLinePatch) and the routes in apps/api/src/routes/orders.ts. They are declared locally
 * — rather than imported from @coa/persistence — so the browser bundle never pulls the mssql
 * adapter. If the server contract changes, update this file in lockstep.
 */
export interface OrderSummaryRow {
  id: string;
  companyId: string;
  customerPoNumber: string | null;
  normalizedPoNumber: string | null;
  erpCustomerAccount: string | null;
  simpleStatus: string;
  internalState: string;
  total: number | null;
  lineCount: number;
  rowVersion: number;
}

export interface OrderLineDetail {
  lineId: string;
  sourceLineNo: number | null;
  customerItemCode: string | null;
  erpItemId: string | null;
  quantity: number | null;
  uom: string | null;
  unitPrice: number | null;
  extendedAmount: number | null;
}

export interface OrderReviewHeader {
  id: string;
  companyId: string;
  sourceChannel: string;
  customerPoNumber: string | null;
  normalizedPoNumber: string | null;
  erpCustomerAccount: string | null;
  poDate: string | null;
  shipTo: string | null;
  billTo: string | null;
  currency: string | null;
  total: number | null;
  simpleStatus: string;
  internalState: string;
  rowVersion: number;
}

export interface ValidationRow {
  code: string;
  severity: string;
  blocking: boolean;
  fieldPath: string | null;
  message?: string | null;
}

export interface OrderReviewDetail {
  header: OrderReviewHeader;
  lines: OrderLineDetail[];
  validation: ValidationRow[];
  normalized: unknown | null;
}

export interface OrderHeaderPatch {
  erpCustomerAccount?: string | null;
  customerPoNumber?: string | null;
  poDate?: string | null;
  shipTo?: string | null;
  billTo?: string | null;
  currency?: string | null;
  total?: number | null;
}

export interface OrderLinePatch {
  lineId: string;
  erpItemId?: string | null;
  quantity?: number | null;
  uom?: string | null;
  unitPrice?: number | null;
}

export interface UpdateOrderInput {
  header?: OrderHeaderPatch;
  lines?: OrderLinePatch[];
}

// --- AP invoices (mirror packages/persistence InvoiceReview* types) ---
export interface InvoiceSummaryRow {
  id: string;
  companyId: string;
  invoiceType: string;
  erpVendorAccount: string | null;
  vendorName: string | null;
  invoiceNumber: string | null;
  normalizedInvoiceNumber: string | null;
  poNumber: string | null;
  grandTotal: number | null;
  lineCount: number;
  simpleStatus: string;
  internalState: string;
  rowVersion: number;
}
export interface InvoiceLineDetail {
  lineId: string;
  sourceLineNo: number | null;
  poLineRef: string | null;
  erpItemId: string | null;
  glAccount: string | null;
  description: string | null;
  quantity: number | null;
  uom: string | null;
  unitPrice: number | null;
  amount: number | null;
  matchStatus: string | null;
  isCodeAndApprove: boolean;
}
export interface InvoiceReviewHeader {
  id: string;
  companyId: string;
  invoiceType: string;
  erpVendorAccount: string | null;
  vendorName: string | null;
  invoiceNumber: string | null;
  normalizedInvoiceNumber: string | null;
  poNumber: string | null;
  invoiceDate: string | null;
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  grandTotal: number | null;
  simpleStatus: string;
  internalState: string;
  rowVersion: number;
}
export interface InvoiceReviewDetail {
  header: InvoiceReviewHeader;
  lines: InvoiceLineDetail[];
  validation: ValidationRow[];
  normalized: unknown | null;
}
export interface InvoiceHeaderPatch {
  erpVendorAccount?: string | null;
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
  poNumber?: string | null;
  currency?: string | null;
}
export interface InvoiceLinePatch {
  lineId: string;
  erpItemId?: string | null;
  glAccount?: string | null;
  quantity?: number | null;
  uom?: string | null;
  unitPrice?: number | null;
  amount?: number | null;
}
export interface UpdateInvoiceInput {
  header?: InvoiceHeaderPatch;
  lines?: InvoiceLinePatch[];
}

/** App roles — mirrors apps/api/src/auth.ts. */
export type AppRole = "Administrator" | "OrderProcessor" | "Supervisor" | "Viewer" | "IntegrationService";
export const WRITE_ROLES: AppRole[] = ["OrderProcessor", "Supervisor", "Administrator"];

/** Connection config — mirrors apps/api/src/settings.ts ConnectionsConfig. */
export interface ConnectionsConfig {
  operationalDb: { server: string; database: string; authMode: string };
  lakehouse: {
    enabled: boolean;
    server: string;
    database: string;
    customerTable: string;
    itemTable: string;
    customerAccountColumn: string;
    customerNameColumn: string;
    dataAreaColumn: string;
    itemIdColumn: string;
    itemSkuColumn: string;
  };
  ai: { docIntelEndpoint: string; foundryEndpoint: string; foundryDeployment: string };
}
export interface ConnectionsResponse {
  config: ConnectionsConfig;
  updatedBy: string | null;
  updatedAt: string | null;
}
export interface ConnectionTestResult {
  ok: boolean;
  detail?: string;
  error?: string;
}
