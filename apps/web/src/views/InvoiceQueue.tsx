/** AP vendor-invoice queue — GET /invoices. Click a row to open the invoice reviewer. */
import { useCallback, useEffect, useState } from "react";
import { listInvoices, ApiError } from "../api/client.js";
import type { InvoiceSummaryRow } from "../api/contract.js";
import { useAuth } from "../auth/AuthContext.js";
import { StatusChip } from "../components/StatusChip.js";
import { money } from "../lib/status.js";

const STATES = ["", "NEEDS_REVIEW", "READY", "DUPLICATE_REVIEW", "STAGED", "REJECTED", "FAILED"];
const TYPES = [
  ["", "All types"],
  ["PO_BASED", "PO-based · 3-way"],
  ["NON_PO", "Non-PO · GL / C&A"],
] as const;

export function InvoiceQueue({ onOpen }: { onOpen: (id: string, label: string) => void }): JSX.Element {
  const { identity } = useAuth();
  const [rows, setRows] = useState<InvoiceSummaryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState("");
  const [type, setType] = useState("");

  const load = useCallback(() => {
    setRows(null);
    setError(null);
    listInvoices(identity, { ...(state ? { state } : {}), ...(type ? { type } : {}) })
      .then(setRows)
      .catch((e: unknown) => setError(e instanceof ApiError ? `${e.status} — ${e.message}` : String(e)));
  }, [identity, state, type]);

  useEffect(load, [load]);

  const needReview = rows?.filter((r) => r.internalState === "NEEDS_REVIEW" || r.internalState === "DUPLICATE_REVIEW").length ?? 0;

  return (
    <>
      <div className="gridhead">
        <h2>Vendor invoices</h2>
        {rows && (
          <span className="chip review" style={{ marginLeft: 4 }}>
            <span className="dot" />
            {needReview} need review
          </span>
        )}
        <div className="sp" />
        <label className="rolesel">
          Type:{" "}
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
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

      {error && <div className="state err">Could not load invoices: {error}</div>}
      {!rows && !error && <div className="state">Loading invoices…</div>}

      {rows && (
        <div className="gridwrap">
          <table className="grid">
            <thead>
              <tr>
                <th>Invoice #</th>
                <th>Vendor</th>
                <th>Type</th>
                <th>PO #</th>
                <th>Status</th>
                <th style={{ textAlign: "right" }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} onClick={() => onOpen(i.id, i.invoiceNumber ?? i.id)}>
                  <td className="po">{i.invoiceNumber ?? "—"}</td>
                  <td>{i.vendorName ?? i.erpVendorAccount ?? "—"}</td>
                  <td>
                    <span className={`match ${i.invoiceType === "PO_BASED" ? "man" : "no"}`}>{i.invoiceType === "PO_BASED" ? "PO" : "Non-PO"}</span>
                  </td>
                  <td className="mono">{i.poNumber ?? "—"}</td>
                  <td>
                    <StatusChip internalState={i.internalState} simpleStatus={i.simpleStatus} />
                  </td>
                  <td className="r num">{money(i.grandTotal)}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ padding: 26, textAlign: "center", color: "var(--muted)" }}>
                    No invoices match this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="gridfoot">
            <span>{rows.length} invoices</span>
            <span>GET /invoices{state ? ` · ${state}` : ""}{type ? ` · ${type}` : ""}</span>
          </div>
        </div>
      )}
    </>
  );
}
