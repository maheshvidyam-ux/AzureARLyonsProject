/**
 * Reviewer detail — GET /orders/:id into a two-pane workbench (canonical CDM left, document
 * evidence right). Header + line edits PATCH with If-Match; Approve/Reject POST with If-Match.
 * A ConflictError (409) means someone else changed the order: we reload rather than clobber.
 * Viewers get a read-only view (every control disabled); the server also enforces this (403).
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { approveOrder, getOrder, patchOrder, rejectOrder, revalidateOrder, ApiError, ConflictError } from "../api/client.js";
import type { OrderLineDetail, OrderReviewDetail, UpdateOrderInput } from "../api/contract.js";
import { useAuth } from "../auth/AuthContext.js";
import { StatusChip } from "../components/StatusChip.js";
import { DocumentScan } from "../components/DocumentScan.js";
import { isTerminal } from "../lib/status.js";
import type { Notify } from "../components/Toast.js";

interface HeaderForm {
  erpCustomerAccount: string;
  customerPoNumber: string;
  poDate: string;
  shipTo: string;
  billTo: string;
  currency: string;
}

const toForm = (d: OrderReviewDetail): HeaderForm => ({
  erpCustomerAccount: d.header.erpCustomerAccount ?? "",
  customerPoNumber: d.header.customerPoNumber ?? "",
  poDate: d.header.poDate ?? "",
  shipTo: d.header.shipTo ?? "",
  billTo: d.header.billTo ?? "",
  currency: d.header.currency ?? "",
});
const nullable = (s: string): string | null => (s.trim() === "" ? null : s);

/** Safe reads over the stored normalized PO for the document facsimile (customer name, line descriptions). */
function customerName(normalized: unknown): string | null {
  const v = (normalized as { header?: { customer?: { name?: { value?: unknown } } } } | null)?.header?.customer?.name?.value;
  return typeof v === "string" ? v : null;
}
function lineDescription(normalized: unknown, i: number): string | null {
  const v = (normalized as { lines?: Array<{ description?: { value?: unknown } }> } | null)?.lines?.[i]?.description?.value;
  return typeof v === "string" ? v : null;
}

export function OrderDetail({ orderId, onBack, notify }: { orderId: string; onBack: () => void; notify: Notify }): JSX.Element {
  const { identity, canWrite } = useAuth();
  const [detail, setDetail] = useState<OrderReviewDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<HeaderForm | null>(null);
  const [lines, setLines] = useState<OrderLineDetail[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showJson, setShowJson] = useState(false);

  const load = useCallback(() => {
    setDetail(null);
    setError(null);
    getOrder(identity, orderId)
      .then((d) => {
        setDetail(d);
        setForm(toForm(d));
        setLines(d.lines.map((l) => ({ ...l })));
        setDirty(false);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? `${e.status} — ${e.message}` : String(e)));
  }, [identity, orderId]);

  useEffect(load, [load]);

  const setHeader = (patch: Partial<HeaderForm>): void => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setDirty(true);
  };
  const setLine = (lineId: string, patch: Partial<OrderLineDetail>): void => {
    setLines((ls) => ls.map((l) => (l.lineId === lineId ? { ...l, ...patch } : l)));
    setDirty(true);
  };

  const runMutation = async (fn: () => Promise<number>, okMsg: string): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      notify(okMsg);
      load();
    } catch (e) {
      if (e instanceof ConflictError) {
        notify("This order changed since you opened it — reloading the latest version.");
        load();
      } else if (e instanceof ApiError) {
        notify(e.status === 403 ? "Your role is read-only — edit not permitted." : `Error ${e.status}: ${e.message}`);
      } else {
        notify(String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const onSave = (): void => {
    if (!detail || !form) return;
    const body: UpdateOrderInput = {
      header: {
        erpCustomerAccount: nullable(form.erpCustomerAccount),
        customerPoNumber: nullable(form.customerPoNumber),
        poDate: nullable(form.poDate),
        shipTo: nullable(form.shipTo),
        billTo: nullable(form.billTo),
        currency: nullable(form.currency),
      },
      lines: lines.map((l) => ({ lineId: l.lineId, erpItemId: l.erpItemId, quantity: l.quantity, uom: l.uom, unitPrice: l.unitPrice })),
    };
    void runMutation(() => patchOrder(identity, orderId, detail.header.rowVersion, body), "Saved");
  };

  if (error) return <DetailShell onBack={onBack} title={orderId}><div className="state err">Could not load this order: {error}</div></DetailShell>;
  if (!detail || !form) return <DetailShell onBack={onBack} title={orderId}><div className="state">Loading order…</div></DetailShell>;

  const h = detail.header;
  const terminal = isTerminal(h.internalState);
  const editable = canWrite && !terminal;
  const blockingFindings = detail.validation.filter((v) => v.blocking);
  const approveDisabled = !canWrite || terminal || busy || blockingFindings.length > 0;
  const hint = !canWrite
    ? "Your role is read-only."
    : terminal
      ? `Order is ${h.internalState.toLowerCase()} — no further action.`
      : blockingFindings.length > 0
        ? "Resolve the blocking validation issues, save, then approve."
        : "Approve to stage for Boomi pickup.";

  return (
    <DetailShell onBack={onBack} title={h.customerPoNumber ?? h.id} chip={<StatusChip internalState={h.internalState} simpleStatus={h.simpleStatus} />} sub={`${h.companyId} · ${h.sourceChannel} · ${h.id}`}>
      <div className="twopane">
        <div className="cdm">
          <div className="scrolly">
            <section>
              <h3>Canonical order (CDM)</h3>
              <p className="hsub">Normalized from the document · rowVersion {h.rowVersion}</p>
            </section>

            <section>
              <h3 className="sec">Validation</h3>
              {detail.validation.length === 0 ? (
                <p style={{ color: "var(--ok)", fontSize: 12.5, margin: 0 }}>No validation findings.</p>
              ) : (
                detail.validation.map((v, i) => {
                  const sev = v.severity.toLowerCase();
                  const cls = sev.startsWith("err") ? "error" : sev.startsWith("warn") ? "warn" : "info";
                  return (
                    <div className={`finding ${cls}`} key={`${v.code}-${i}`}>
                      <span className="ic">{cls === "error" ? "!" : cls === "warn" ? "i" : "i"}</span>
                      <span>
                        <span>{v.message ?? v.code}</span>
                        <span className="code">
                          {v.code}
                          {v.fieldPath ? ` · ${v.fieldPath}` : ""}
                          {v.blocking ? " · blocking" : ""}
                        </span>
                      </span>
                    </div>
                  );
                })
              )}
            </section>

            <section>
              <h3 className="sec">Customer (ERP)</h3>
              <div className="cdmfield">
                <span className="lab">ERP customer account</span>
                <input value={form.erpCustomerAccount} disabled={!editable} placeholder="e.g. ACME01" onChange={(e) => setHeader({ erpCustomerAccount: e.target.value })} />
              </div>
            </section>

            <section>
              <h3 className="sec">Order reference &amp; delivery</h3>
              <div className="cdmfield">
                <span className="lab">Customer PO number</span>
                <input value={form.customerPoNumber} disabled={!editable} onChange={(e) => setHeader({ customerPoNumber: e.target.value })} />
              </div>
              <div className="twocol">
                <div className="cdmfield">
                  <span className="lab">PO date</span>
                  <input type="date" value={form.poDate} disabled={!editable} onChange={(e) => setHeader({ poDate: e.target.value })} />
                </div>
                <div className="cdmfield">
                  <span className="lab">Currency</span>
                  <input value={form.currency} disabled={!editable} onChange={(e) => setHeader({ currency: e.target.value })} />
                </div>
              </div>
              <div className="cdmfield">
                <span className="lab">Ship to</span>
                <input value={form.shipTo} disabled={!editable} onChange={(e) => setHeader({ shipTo: e.target.value })} />
              </div>
              <div className="cdmfield">
                <span className="lab">Bill to</span>
                <input value={form.billTo} disabled={!editable} onChange={(e) => setHeader({ billTo: e.target.value })} />
              </div>
            </section>

            <section>
              <h3 className="sec">Line items · ERP item &amp; qty</h3>
              <table className="citems">
                <thead>
                  <tr>
                    <th>Customer item #</th>
                    <th style={{ width: 70 }}>Qty</th>
                    <th style={{ width: 64 }}>UOM</th>
                    <th>ERP item id</th>
                    <th style={{ width: 82, textAlign: "right" }}>Unit $</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.lineId}>
                      <td className="mono">{l.customerItemCode ?? "—"}</td>
                      <td>
                        <input className="q" type="number" value={l.quantity ?? ""} disabled={!editable} onChange={(e) => setLine(l.lineId, { quantity: e.target.value === "" ? null : Number(e.target.value) })} />
                      </td>
                      <td>
                        <input value={l.uom ?? ""} disabled={!editable} onChange={(e) => setLine(l.lineId, { uom: e.target.value })} />
                      </td>
                      <td>
                        <input value={l.erpItemId ?? ""} disabled={!editable} placeholder="unmatched" onChange={(e) => setLine(l.lineId, { erpItemId: nullable(e.target.value) })} />
                      </td>
                      <td className="r">
                        <input className="q" type="number" value={l.unitPrice ?? ""} disabled={!editable} onChange={(e) => setLine(l.lineId, { unitPrice: e.target.value === "" ? null : Number(e.target.value) })} />
                      </td>
                    </tr>
                  ))}
                  {lines.length === 0 && (
                    <tr>
                      <td colSpan={5} style={{ color: "var(--muted)" }}>
                        No line items were extracted.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </section>
          </div>

          <div className="cdmactions">
            <div className="vbar">
              <span>Optimistic concurrency</span>
              <span className="ver">If-Match: v{h.rowVersion}{dirty ? " · unsaved" : ""}</span>
            </div>
            <button
              className="btn"
              style={{ width: "100%" }}
              disabled={!canWrite || terminal || busy || dirty}
              title={dirty ? "Save your edits first" : "Re-run validation + master matching against the corrected data"}
              onClick={() => void runMutation(() => revalidateOrder(identity, orderId, h.rowVersion), "Revalidated")}
            >
              ↻ Re-run validation
            </button>
            <div className="btns">
              <button className="btn danger" disabled={!canWrite || terminal || busy} onClick={() => void runMutation(() => rejectOrder(identity, orderId, h.rowVersion), "Rejected")}>
                Reject
              </button>
              <button className="btn" disabled={!editable || !dirty || busy} onClick={onSave}>
                Save
              </button>
              <button className="btn primary" disabled={approveDisabled} onClick={() => void runMutation(() => approveOrder(identity, orderId, h.rowVersion), "Approved → staged for Boomi")}>
                Approve
              </button>
            </div>
            <div className={`hint${blockingFindings.length > 0 && canWrite && !terminal ? " bad" : ""}`}>{hint}</div>
          </div>
        </div>

        <div className="imgpane">
          <div className="imgtool">
            <span className="fname">{h.customerPoNumber ?? h.id}.pdf</span>
            <span>·</span>
            <span>customer purchase order</span>
            <span>·</span>
            <span style={{ color: "var(--muted)" }}>page 1 / 1</span>
          </div>
          <DocumentScan
            docType="PURCHASE ORDER"
            partyName={customerName(detail.normalized) ?? h.erpCustomerAccount ?? "Customer"}
            number={h.customerPoNumber ?? "—"}
            date={h.poDate}
            leftHeader="Item"
            fields={[
              { k: "Ship to", v: h.shipTo ?? "—" },
              { k: "Bill to", v: h.billTo ?? "—" },
              { k: "PO date", v: h.poDate ?? "— not stated —" },
              { k: "Currency", v: h.currency ?? "—" },
            ]}
            lines={lines.map((l, i) => ({ left: l.customerItemCode, desc: lineDescription(detail.normalized, i) ?? l.customerItemCode, qty: l.quantity, uom: l.uom, unit: l.unitPrice, amount: l.extendedAmount }))}
            total={h.total}
            currency={h.currency}
          />
          <div className="evtoggle"><button onClick={() => setShowJson((s) => !s)}>{showJson ? "Hide" : "View"} extracted data (JSON)</button></div>
          {showJson && <div className="evjson"><pre>{JSON.stringify(detail.normalized, null, 2)}</pre></div>}
        </div>
      </div>
    </DetailShell>
  );
}

function DetailShell({ onBack, title, chip, sub, children }: { onBack: () => void; title: string; chip?: JSX.Element; sub?: string; children: ReactNode }): JSX.Element {
  return (
    <>
      <div className="detailbar">
        <span className="po">{title}</span>
        {chip}
        {sub && <span style={{ color: "var(--muted)", fontSize: 13 }}>{sub}</span>}
        <div className="sp" />
        <button className="toolbtn" onClick={onBack}>
          ← Back to queue
        </button>
      </div>
      {children}
    </>
  );
}
