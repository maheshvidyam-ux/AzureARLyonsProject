/**
 * AP invoice reviewer detail — two-pane (canonical CDM left, evidence right). PO-based invoices show
 * the 3-way-match result per line; Non-PO invoices show the Code-&-Approve line with a GL-account
 * input. Edits PATCH with If-Match; Approve stages to staging_vendor_invoice (a Non-PO can't be
 * approved until every C&A line is GL-coded). 409 → reload rather than clobber.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { approveInvoice, getInvoice, patchInvoice, rejectInvoice, ApiError, ConflictError } from "../api/client.js";
import type { InvoiceLineDetail, InvoiceReviewDetail, UpdateInvoiceInput } from "../api/contract.js";
import { useAuth } from "../auth/AuthContext.js";
import { StatusChip } from "../components/StatusChip.js";
import { isTerminal, matchBadge, money } from "../lib/status.js";
import type { Notify } from "../components/Toast.js";

interface HeaderForm {
  erpVendorAccount: string;
  invoiceNumber: string;
  invoiceDate: string;
  poNumber: string;
  currency: string;
}
const toForm = (d: InvoiceReviewDetail): HeaderForm => ({
  erpVendorAccount: d.header.erpVendorAccount ?? "",
  invoiceNumber: d.header.invoiceNumber ?? "",
  invoiceDate: d.header.invoiceDate ?? "",
  poNumber: d.header.poNumber ?? "",
  currency: d.header.currency ?? "",
});
const nullable = (s: string): string | null => (s.trim() === "" ? null : s);

export function InvoiceDetail({ invoiceId, onBack, notify }: { invoiceId: string; onBack: () => void; notify: Notify }): JSX.Element {
  const { identity, canWrite } = useAuth();
  const [detail, setDetail] = useState<InvoiceReviewDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<HeaderForm | null>(null);
  const [lines, setLines] = useState<InvoiceLineDetail[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setDetail(null);
    setError(null);
    getInvoice(identity, invoiceId)
      .then((d) => {
        setDetail(d);
        setForm(toForm(d));
        setLines(d.lines.map((l) => ({ ...l })));
        setDirty(false);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? `${e.status} — ${e.message}` : String(e)));
  }, [identity, invoiceId]);

  useEffect(load, [load]);

  const setHeader = (patch: Partial<HeaderForm>): void => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setDirty(true);
  };
  const setLine = (lineId: string, patch: Partial<InvoiceLineDetail>): void => {
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
        notify("This invoice changed since you opened it — reloading.");
        load();
      } else if (e instanceof ApiError) {
        notify(e.status === 403 ? "Your role is read-only." : `Error ${e.status}: ${e.message}`);
      } else notify(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSave = (): void => {
    if (!detail || !form) return;
    const body: UpdateInvoiceInput = {
      header: {
        erpVendorAccount: nullable(form.erpVendorAccount),
        invoiceNumber: nullable(form.invoiceNumber),
        invoiceDate: nullable(form.invoiceDate),
        poNumber: nullable(form.poNumber),
        currency: nullable(form.currency),
      },
      lines: lines.map((l) => ({ lineId: l.lineId, erpItemId: l.erpItemId, glAccount: l.glAccount, quantity: l.quantity, uom: l.uom, unitPrice: l.unitPrice, amount: l.amount })),
    };
    void runMutation(() => patchInvoice(identity, invoiceId, detail.header.rowVersion, body), "Saved");
  };

  if (error) return <Shell onBack={onBack} title={invoiceId}><div className="state err">Could not load this invoice: {error}</div></Shell>;
  if (!detail || !form) return <Shell onBack={onBack} title={invoiceId}><div className="state">Loading invoice…</div></Shell>;

  const h = detail.header;
  const isNonPo = h.invoiceType === "NON_PO";
  const terminal = isTerminal(h.internalState);
  const editable = canWrite && !terminal;
  const uncodedCA = lines.some((l) => l.isCodeAndApprove && !(l.glAccount ?? "").trim());
  const approveDisabled = !canWrite || terminal || busy || (isNonPo && uncodedCA);
  const hint = !canWrite
    ? "Your role is read-only."
    : terminal
      ? `Invoice is ${h.internalState.toLowerCase()} — no further action.`
      : isNonPo && uncodedCA
        ? "Assign a GL account to the Code & Approve line to approve."
        : "Approve to stage for Boomi (AX voucher).";

  return (
    <Shell onBack={onBack} title={h.invoiceNumber ?? h.id} chip={<StatusChip internalState={h.internalState} simpleStatus={h.simpleStatus} />} sub={`${isNonPo ? "Non-PO · GL" : "PO-based · 3-way"} · ${h.vendorName ?? h.erpVendorAccount ?? "vendor?"} · ${h.id}`}>
      <div className="twopane">
        <div className="cdm">
          <div className="scrolly">
            <section>
              <h3>Canonical invoice (CDM)</h3>
              <p className="hsub">{isNonPo ? "Non-PO — Code & Approve" : "PO-based — three-way match"} · rowVersion {h.rowVersion}</p>
            </section>

            <section>
              <h3 className="sec">Validation</h3>
              {detail.validation.length === 0 ? (
                <p style={{ color: "var(--ok)", fontSize: 12.5, margin: 0 }}>No validation findings — ready to voucher.</p>
              ) : (
                detail.validation.map((v, i) => {
                  const sev = v.severity.toLowerCase();
                  const cls = sev.startsWith("err") ? "error" : sev.startsWith("warn") ? "warn" : "info";
                  return (
                    <div className={`finding ${cls}`} key={`${v.code}-${i}`}>
                      <span className="ic">{cls === "error" ? "!" : "i"}</span>
                      <span>
                        <span>{v.message ?? v.code}</span>
                        <span className="code">{v.code}{v.blocking ? " · blocking" : ""}</span>
                      </span>
                    </div>
                  );
                })
              )}
            </section>

            <section>
              <h3 className="sec">Vendor (ERP)</h3>
              <div className="cdmfield">
                <span className="lab">Vendor name</span>
                <input value={h.vendorName ?? ""} disabled />
              </div>
              <div className="cdmfield">
                <span className="lab">ERP vendor account</span>
                <input value={form.erpVendorAccount} disabled={!editable} placeholder="e.g. VEND-ACME" onChange={(e) => setHeader({ erpVendorAccount: e.target.value })} />
              </div>
            </section>

            <section>
              <h3 className="sec">Invoice reference</h3>
              <div className="twocol">
                <div className="cdmfield">
                  <span className="lab">Invoice number</span>
                  <input value={form.invoiceNumber} disabled={!editable} onChange={(e) => setHeader({ invoiceNumber: e.target.value })} />
                </div>
                <div className="cdmfield">
                  <span className="lab">Invoice date</span>
                  <input type="date" value={form.invoiceDate} disabled={!editable} onChange={(e) => setHeader({ invoiceDate: e.target.value })} />
                </div>
                <div className="cdmfield">
                  <span className="lab">PO reference</span>
                  <input value={form.poNumber} disabled={!editable || isNonPo} placeholder={isNonPo ? "— none (Non-PO) —" : ""} onChange={(e) => setHeader({ poNumber: e.target.value })} />
                </div>
                <div className="cdmfield">
                  <span className="lab">Currency</span>
                  <input value={form.currency} disabled={!editable} onChange={(e) => setHeader({ currency: e.target.value })} />
                </div>
              </div>
            </section>

            {isNonPo ? (
              <section>
                <h3 className="sec">Code &amp; Approve (GL coding)</h3>
                <p className="hsub">No PO — assign a GL account for the amount. A single C&amp;A line is posted to the AX voucher.</p>
                {lines.map((l) => (
                  <div className="glrow" key={l.lineId} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 16, alignItems: "center", background: "#fbfcfe", border: "1px solid var(--line-soft)", borderRadius: 7, padding: 12 }}>
                    <div>
                      <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase" }}>{l.description ?? "Amount"}</div>
                      <div className="num" style={{ fontSize: 19, fontWeight: 700 }}>{money(l.amount)} {h.currency ?? ""}</div>
                    </div>
                    <div style={{ minWidth: 190 }}>
                      <span className="lab" style={{ fontSize: 11, textTransform: "uppercase", color: "var(--muted)" }}>GL account</span>
                      <input value={l.glAccount ?? ""} disabled={!editable} placeholder="e.g. 6100" onChange={(e) => setLine(l.lineId, { glAccount: e.target.value })} style={{ width: "100%", fontSize: 13, padding: "7px 9px", border: "1px solid var(--line)", borderRadius: 6 }} />
                    </div>
                  </div>
                ))}
              </section>
            ) : (
              <section>
                <h3 className="sec">Three-way match</h3>
                <table className="citems">
                  <thead>
                    <tr>
                      <th>Description</th>
                      <th style={{ width: 60, textAlign: "right" }}>Qty</th>
                      <th style={{ width: 74, textAlign: "right" }}>Unit $</th>
                      <th style={{ width: 84, textAlign: "right" }}>Amount</th>
                      <th style={{ textAlign: "right" }}>Match</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => {
                      const b = matchBadge(l.matchStatus);
                      return (
                        <tr key={l.lineId}>
                          <td>{l.description ?? l.poLineRef ?? "—"}</td>
                          <td className="r num">{l.quantity ?? "—"}</td>
                          <td className="r num">{money(l.unitPrice)}</td>
                          <td className="r num">{money(l.amount)}</td>
                          <td className="r">{b && <span className={`match ${b.tone}`}>{b.label}</span>}</td>
                        </tr>
                      );
                    })}
                    {lines.length === 0 && (
                      <tr>
                        <td colSpan={5} style={{ color: "var(--muted)" }}>No lines were extracted.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </section>
            )}

            <section>
              <h3 className="sec">Totals</h3>
              <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
                <Row label="Subtotal" value={money(h.subtotal)} />
                <Row label="Tax" value={money(h.tax)} />
                <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, borderTop: "1px solid var(--line-soft)", paddingTop: 6 }}>
                  <span>Total</span>
                  <span className="num">{money(h.grandTotal)} {h.currency ?? ""}</span>
                </div>
              </div>
            </section>
          </div>

          <div className="cdmactions">
            <div className="vbar">
              <span>Optimistic concurrency</span>
              <span className="ver">If-Match: v{h.rowVersion}{dirty ? " · unsaved" : ""}</span>
            </div>
            <div className="btns">
              <button className="btn danger" disabled={!canWrite || terminal || busy} onClick={() => void runMutation(() => rejectInvoice(identity, invoiceId, h.rowVersion), "Rejected")}>
                Reject
              </button>
              <button className="btn" disabled={!editable || !dirty || busy} onClick={onSave}>
                Save
              </button>
              <button className="btn primary" disabled={approveDisabled} onClick={() => void runMutation(() => approveInvoice(identity, invoiceId, h.rowVersion), "Approved → staged for Boomi")}>
                Approve
              </button>
            </div>
            <div className={`hint${isNonPo && uncodedCA && canWrite && !terminal ? " bad" : ""}`}>{hint}</div>
          </div>
        </div>

        <div className="imgpane">
          <div className="imgtool">
            <span className="fname">{h.id}.json</span>
            <span>·</span>
            <span>normalized evidence</span>
            <span>·</span>
            <span style={{ color: "var(--muted)" }}>total {money(h.grandTotal)} {h.currency ?? ""}</span>
          </div>
          <div className="scan">
            <h5>Document evidence (normalized invoice)</h5>
            {detail.normalized == null ? (
              <p style={{ color: "#b44", fontSize: 12.5 }}>No normalized evidence available.</p>
            ) : (
              <pre>{JSON.stringify(detail.normalized, null, 2)}</pre>
            )}
          </div>
        </div>
      </div>
    </Shell>
  );
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <span className="num">{value}</span>
    </div>
  );
}

function Shell({ onBack, title, chip, sub, children }: { onBack: () => void; title: string; chip?: JSX.Element; sub?: string; children: ReactNode }): JSX.Element {
  return (
    <>
      <div className="detailbar">
        <span className="po">{title}</span>
        {chip}
        {sub && <span style={{ color: "var(--muted)", fontSize: 13 }}>{sub}</span>}
        <div className="sp" />
        <button className="toolbtn" onClick={onBack}>
          ← Back to invoices
        </button>
      </div>
      {children}
    </>
  );
}
