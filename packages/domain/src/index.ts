/** Order Processing is the first and only module in scope (spec §10 `module_code` seam). */
export const MODULE_CODE = "ORDER_PROCESSING" as const;
export type ModuleCode = typeof MODULE_CODE;

export * from "./status.js";
export * from "./po-number.js";
export * from "./company.js";
