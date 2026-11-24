/** Map the server's internalState to a chip style + human label (prefers the server simpleStatus). */
export type ChipClass = "review" | "dup" | "ready" | "completed" | "rejected" | "failed";

const MAP: Record<string, { cls: ChipClass; label: string }> = {
  NEEDS_REVIEW: { cls: "review", label: "Needs review" },
  DUPLICATE_REVIEW: { cls: "dup", label: "Duplicate review" },
  DUPLICATE: { cls: "dup", label: "Duplicate" },
  READY: { cls: "ready", label: "Ready" },
  STAGED: { cls: "completed", label: "Staged for Boomi" },
  COMPLETED: { cls: "completed", label: "Completed" },
  ERP_CREATED: { cls: "completed", label: "Posted to AX" },
  POSTED: { cls: "completed", label: "Posted to AX" },
  REJECTED: { cls: "rejected", label: "Rejected" },
  FAILED: { cls: "failed", label: "Failed" },
};

export function statusMeta(internalState: string, simpleStatus?: string): { cls: ChipClass; label: string } {
  const m = MAP[internalState] ?? { cls: "review" as ChipClass, label: internalState };
  return { cls: m.cls, label: simpleStatus?.trim() ? simpleStatus : m.label };
}

const TERMINAL = new Set(["STAGED", "COMPLETED", "POSTED", "ERP_CREATED", "REJECTED"]);
export const isTerminal = (internalState: string): boolean => TERMINAL.has(internalState);

/** 3-way / line match-status → a short badge label + tone. */
export function matchBadge(status: string | null): { label: string; tone: "ok" | "warn" | "no" } | null {
  if (!status) return null;
  switch (status) {
    case "PO_MATCHED":
    case "EXACT_SKU":
      return { label: "matched", tone: "ok" };
    case "OVER_RECEIPT":
      return { label: "over receipt", tone: "no" };
    case "PRICE_VARIANCE":
      return { label: "price variance", tone: "warn" };
    case "NO_PO_LINE":
      return { label: "no PO line", tone: "no" };
    case "GL_CODE_REQUIRED":
      return { label: "needs GL", tone: "warn" };
    case "UNMATCHED":
      return { label: "unmatched", tone: "no" };
    default:
      return { label: status.toLowerCase().replace(/_/g, " "), tone: "warn" };
  }
}

export const money = (n: number | null | undefined): string =>
  n == null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
