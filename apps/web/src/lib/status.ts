/** Map the server's internalState to a chip style + human label (prefers the server simpleStatus). */
export type ChipClass = "review" | "dup" | "ready" | "completed" | "rejected" | "failed";

const MAP: Record<string, { cls: ChipClass; label: string }> = {
  NEEDS_REVIEW: { cls: "review", label: "Needs review" },
  DUPLICATE_REVIEW: { cls: "dup", label: "Duplicate review" },
  DUPLICATE: { cls: "dup", label: "Duplicate" },
  READY: { cls: "ready", label: "Ready" },
  STAGED: { cls: "completed", label: "Staged for Boomi" },
  COMPLETED: { cls: "completed", label: "Completed" },
  POSTED: { cls: "completed", label: "Posted to AX" },
  REJECTED: { cls: "rejected", label: "Rejected" },
  FAILED: { cls: "failed", label: "Failed" },
};

export function statusMeta(internalState: string, simpleStatus?: string): { cls: ChipClass; label: string } {
  const m = MAP[internalState] ?? { cls: "review" as ChipClass, label: internalState };
  return { cls: m.cls, label: simpleStatus?.trim() ? simpleStatus : m.label };
}

const TERMINAL = new Set(["STAGED", "COMPLETED", "POSTED", "REJECTED"]);
export const isTerminal = (internalState: string): boolean => TERMINAL.has(internalState);

export const money = (n: number | null | undefined): string =>
  n == null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
