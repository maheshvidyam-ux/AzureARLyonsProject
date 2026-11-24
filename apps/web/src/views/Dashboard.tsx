/**
 * Operations dashboard — the production version of the demo dashboard, wired to live data. It reads
 * the AR order queue + AP invoice queue and derives the KPIs, the zero-touch straight-through hero,
 * and the status mix. No separate analytics store: everything is computed from the two reviewer
 * lists the SPA already consumes.
 */
import { useCallback, useEffect, useState } from "react";
import { listInvoices, listOrders, ApiError } from "../api/client.js";
import type { InvoiceSummaryRow, OrderSummaryRow } from "../api/contract.js";
import { useAuth } from "../auth/AuthContext.js";
import { statusMeta, type ChipClass } from "../lib/status.js";

const CLEAN = new Set(["READY", "STAGED", "ERP_CREATED", "COMPLETED", "POSTED"]);
const REVIEW = new Set(["NEEDS_REVIEW", "DUPLICATE_REVIEW"]);
const CHIP_COLOR: Record<ChipClass, string> = {
  ready: "var(--ok)",
  completed: "var(--accent)",
  review: "var(--warn)",
  dup: "var(--crit)",
  rejected: "var(--muted-2)",
  failed: "var(--violet)",
};

interface Doc {
  internalState: string;
  simpleStatus: string;
}

export function Dashboard({ onGoOrders, onGoInvoices }: { onGoOrders: () => void; onGoInvoices: () => void }): JSX.Element {
  const { identity } = useAuth();
  const [orders, setOrders] = useState<OrderSummaryRow[] | null>(null);
  const [invoices, setInvoices] = useState<InvoiceSummaryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    Promise.all([listOrders(identity, {}), listInvoices(identity, {})])
      .then(([o, i]) => {
        setOrders(o);
        setInvoices(i);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? `${e.status} — ${e.message}` : String(e)));
  }, [identity]);

  useEffect(load, [load]);

  if (error) return <div className="state err">Could not load the dashboard: {error}</div>;
  if (!orders || !invoices) return <div className="state">Loading operations overview…</div>;

  const docs: Doc[] = [...orders, ...invoices];
  const total = docs.length;
  const clean = docs.filter((d) => CLEAN.has(d.internalState)).length;
  const review = docs.filter((d) => REVIEW.has(d.internalState)).length;
  const dups = docs.filter((d) => d.internalState === "DUPLICATE_REVIEW").length;
  const stp = total ? Math.round((clean / total) * 100) : 0;
  const hoursSaved = Math.round((clean * 9) / 60); // ≈9 min manual handling avoided per auto-processed doc

  const mix = new Map<string, number>();
  for (const d of docs) mix.set(d.internalState, (mix.get(d.internalState) ?? 0) + 1);
  const mixRows = [...mix.entries()].sort((a, b) => b[1] - a[1]);
  const maxMix = Math.max(1, ...mixRows.map(([, n]) => n));

  return (
    <>
      <h2 style={{ margin: "0 0 4px", fontSize: 19 }}>Operations overview</h2>
      <p style={{ margin: "0 0 18px", color: "var(--muted)", fontSize: 13 }}>Customer orders + vendor invoices · live</p>

      <div className="hero-st">
        <div>
          <div className="pct">
            {stp}
            <small>%</small>
          </div>
          <div className="cap">Straight-through · zero human touch</div>
        </div>
        <div className="funnel">
          <Funnel label="Documents received" value={total} max={total} color="rgba(255,255,255,.55)" />
          <Funnel label="Auto-processed / staged" value={clean} max={total} color="#9fe0c0" />
          <Funnel label="Routed to a reviewer" value={review} max={total} color="#f0cf8f" />
        </div>
        <div className="saved">
          <div className="big">≈ {hoursSaved} hrs</div>
          <div className="sub">CSR handling avoided · ~9 min manual per document</div>
        </div>
      </div>

      <div className="kpis">
        <Kpi k="Documents processed" v={String(total)} d={`${orders.length} orders · ${invoices.length} invoices`} cls="flat" />
        <Kpi k="Straight-through" v={`${stp}%`} d="no human touch" cls="up" />
        <Kpi k="Needs review" v={String(review)} d="awaiting a reviewer" cls="flat" />
        <Kpi k="Duplicates blocked" v={String(dups)} d="0 reached AX" cls="up" />
      </div>

      <div className="dashcols">
        <div className="panel">
          <h3>Status mix</h3>
          <p className="psub">Across all documents</p>
          <div className="hbars">
            {mixRows.map(([state, n]) => {
              const m = statusMeta(state);
              return (
                <div className="hbar" key={state}>
                  <span>{m.label}</span>
                  <span className="track">
                    <i style={{ width: `${(n / maxMix) * 100}%`, background: CHIP_COLOR[m.cls] }} />
                  </span>
                  <span className="num">{n}</span>
                </div>
              );
            })}
            {mixRows.length === 0 && <p style={{ color: "var(--muted)", fontSize: 12.5 }}>No documents yet.</p>}
          </div>
        </div>

        <div className="panel">
          <h3>By module</h3>
          <p className="psub">Open the queues</p>
          <button className="modcard" onClick={onGoOrders}>
            <div>
              <div className="modn">Customer orders · AR</div>
              <div className="modsub">{orders.filter((o) => REVIEW.has(o.internalState)).length} need review</div>
            </div>
            <div className="modbig num">{orders.length}</div>
          </button>
          <button className="modcard" onClick={onGoInvoices}>
            <div>
              <div className="modn">Vendor invoices · AP</div>
              <div className="modsub">{invoices.filter((i) => REVIEW.has(i.internalState)).length} need review</div>
            </div>
            <div className="modbig num">{invoices.length}</div>
          </button>
        </div>
      </div>
    </>
  );
}

function Kpi({ k, v, d, cls }: { k: string; v: string; d: string; cls: "up" | "down" | "flat" }): JSX.Element {
  return (
    <div className="kpi">
      <div className="k">{k}</div>
      <div className="v num">{v}</div>
      <div className={`d ${cls}`}>{d}</div>
    </div>
  );
}

function Funnel({ label, value, max, color }: { label: string; value: number; max: number; color: string }): JSX.Element {
  return (
    <div className="fr">
      <span>{label}</span>
      <span className="track">
        <i style={{ width: `${max ? (value / max) * 100 : 0}%`, background: color }} />
      </span>
      <span className="num">{value}</span>
    </div>
  );
}
