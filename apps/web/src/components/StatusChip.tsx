import { statusMeta } from "../lib/status.js";

export function StatusChip({ internalState, simpleStatus }: { internalState: string; simpleStatus?: string }): JSX.Element {
  const { cls, label } = statusMeta(internalState, simpleStatus);
  return (
    <span className={`chip ${cls}`}>
      <span className="dot" />
      {label}
    </span>
  );
}
