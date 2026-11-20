/** Review queue — GET /orders, rendered as the grid. Click a row to open the reviewer detail. */
import { useCallback, useEffect, useState } from "react";
import { listOrders, ApiError } from "../api/client.js";
import type { OrderSummaryRow } from "../api/contract.js";
import { useAuth } from "../auth/AuthContext.js";
import { StatusChip } from "../components/StatusChip.js";
import { money } from "../lib/status.js";

const STATES = ["", "NEEDS_REVIEW", "READY", "STAGED", "REJECTED", "FAILED"];

export function Queue({ onOpen }: { onOpen: (id: string, po: string) => void }): JSX.Element {
  const { identity } = useAuth();
  const [rows, setRows] = useState<OrderSummaryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState("");

  const load = useCallback(() => {
    setRows(null);
    setError(null);
    listOrders(identity, state ? { state } : {})
      .then(setRows)
      .catch((e: unknown) => setError(e instanceof ApiError ? `${e.status} — ${e.message}` : String(e)));
  }, [identity, state]);

  useEffect(load, [load]);

  const needReview = rows?.filter((r) => r.internalState === "NEEDS_REVIEW" || r.internalState === "DUPLICATE_REVIEW").length ?? 0;

  return (
    <>
      <div className="gridhead">
        <h2>Customer orders</h2>
        {rows && (
          <span className="chip review" style={{ marginLeft: 4 }}>
            <span className="dot" />
            {needReview} need review
          </span>
        )}
        <div className="sp" />
        <label className="rolesel">
          Status:{" "}
          <select value={state} onChange={(e) => setState(e.target.value)}>
            {STATES.map((s) => (
              <option key={s} value={s}>
                {s === "" ? "All" : s}
              </option>
            ))}
          </select>
        </label>
        <button className="toolbtn" onClick={load}>
          Refresh
        </button>
      </div>

      {error && <div className="state err">Could not load the queue: {error}</div>}
      {!rows && !error && <div className="state">Loading orders…</div>}

      {rows && (
        <div className="gridwrap">
          <table className="grid">
            <thead>
              <tr>
                <th>PO #</th>
                <th>Company</th>
                <th>ERP account</th>
                <th>Normalized PO</th>
                <th>Status</th>
                <th style={{ textAlign: "right" }}>Lines</th>
                <th style={{ textAlign: "right" }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id} onClick={() => onOpen(o.id, o.customerPoNumber ?? o.id)}>
                  <td className="po">{o.customerPoNumber ?? "—"}</td>
                  <td>{o.companyId}</td>
                  <td>{o.erpCustomerAccount ?? "—"}</td>
                  <td className="mono">{o.normalizedPoNumber ?? "—"}</td>
                  <td>
                    <StatusChip internalState={o.internalState} simpleStatus={o.simpleStatus} />
                  </td>
                  <td className="r num">{o.lineCount}</td>
                  <td className="r num">{money(o.total)}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: 26, textAlign: "center", color: "var(--muted)" }}>
                    No orders match this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="gridfoot">
            <span>{rows.length} orders</span>
            <span>GET /orders{state ? ` · state=${state}` : ""}</span>
          </div>
        </div>
      )}
    </>
  );
}
