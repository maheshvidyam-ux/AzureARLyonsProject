/**
 * Order status model (spec §9 / docs/01-architecture.md §1.3).
 *
 * Simple, user-facing statuses map onto granular internal states. This slice only
 * drives the pipeline up to (but NOT including) staging, so the terminal states it can
 * reach are READY, NEEDS_REVIEW, DUPLICATE_REVIEW, or FAILED. Staging/ERP states exist
 * here for completeness but are unreachable until Phase 5.
 */

export type SimpleStatus =
  | "Received"
  | "Processing"
  | "Needs Review"
  | "Ready"
  | "Sent to ERP"
  | "Completed"
  | "Failed"
  | "Rejected";

export type InternalState =
  | "INGESTED"
  | "OCR_PENDING"
  | "OCR_DONE"
  | "AI_PENDING"
  | "VALIDATING"
  | "NEEDS_REVIEW"
  | "DUPLICATE_REVIEW"
  | "READY"
  | "STAGED"
  | "BOOMI_CLAIMED"
  | "ERP_CREATING"
  | "ERP_CREATED"
  | "FAILED"
  | "REJECTED";

const SIMPLE_BY_INTERNAL: Record<InternalState, SimpleStatus> = {
  INGESTED: "Received",
  OCR_PENDING: "Processing",
  OCR_DONE: "Processing",
  AI_PENDING: "Processing",
  VALIDATING: "Processing",
  NEEDS_REVIEW: "Needs Review",
  DUPLICATE_REVIEW: "Needs Review",
  READY: "Ready",
  STAGED: "Ready",
  BOOMI_CLAIMED: "Sent to ERP",
  ERP_CREATING: "Sent to ERP",
  ERP_CREATED: "Completed",
  FAILED: "Failed",
  REJECTED: "Rejected",
};

export function toSimpleStatus(state: InternalState): SimpleStatus {
  return SIMPLE_BY_INTERNAL[state];
}

/**
 * States this first slice is allowed to reach. Reaching STAGED or any ERP_* state from
 * the slice is a guardrail violation (the slice must stop before staging).
 */
export const PRE_STAGING_TERMINAL_STATES = [
  "READY",
  "NEEDS_REVIEW",
  "DUPLICATE_REVIEW",
  "FAILED",
] as const satisfies readonly InternalState[];

/**
 * States the pipeline may reach once staging is enabled (Phase 5). STAGED means the order was
 * published to the Boomi "final tables"; ERP states are only set by the Boomi ack path.
 */
export const PIPELINE_TERMINAL_STATES = [
  "READY",
  "STAGED",
  "NEEDS_REVIEW",
  "DUPLICATE_REVIEW",
  "FAILED",
] as const satisfies readonly InternalState[];
