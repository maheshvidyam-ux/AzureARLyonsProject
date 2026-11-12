/**
 * Processing modules (spec §10 `module_code` seam). The platform runs two parallel processes
 * on the same ingestion/extraction/review/staging infrastructure:
 *   - ORDER_PROCESSING — AR: customer purchase orders → AX sales orders (via Boomi).
 *   - AP_INVOICE       — AP: vendor invoices → AX vendor invoices/vouchers (via Boomi).
 * Module-scoped, not multi-tenant: every learning/audit row carries its module_code so the two
 * modules never cross-contaminate.
 */
export const MODULE_CODES = ["ORDER_PROCESSING", "AP_INVOICE"] as const;
export type ModuleCode = (typeof MODULE_CODES)[number];

/** Default module (AR order processing) — retained for back-compat. */
export const MODULE_CODE: ModuleCode = "ORDER_PROCESSING";

export * from "./status.js";
export * from "./po-number.js";
export * from "./invoice-number.js";
export * from "./company.js";
