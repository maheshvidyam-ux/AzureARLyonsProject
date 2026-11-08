import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "./normalized-po.schema.json" with { type: "json" };
import type { NormalizedPurchaseOrder } from "./types.js";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const compiled: ValidateFunction = ajv.compile(schema);

export interface SchemaValidationResult {
  valid: boolean;
  errors: ErrorObject[];
}

/**
 * Validate a candidate object against the normalized-PO JSON Schema (docs/04).
 * The schema is the runtime source of truth for the AI Foundry schema-constrained output.
 */
export function validateNormalizedPo(candidate: unknown): SchemaValidationResult {
  const valid = compiled(candidate) as boolean;
  return { valid, errors: valid ? [] : (compiled.errors ?? []) };
}

/** Narrowing helper that throws with readable context — used only where a prior check guarantees validity. */
export function assertNormalizedPo(candidate: unknown): asserts candidate is NormalizedPurchaseOrder {
  const { valid, errors } = validateNormalizedPo(candidate);
  if (!valid) {
    const detail = errors.map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()).join("; ");
    throw new Error(`Object does not conform to NormalizedPurchaseOrder schema: ${detail}`);
  }
}

export { schema as normalizedPoSchema };
