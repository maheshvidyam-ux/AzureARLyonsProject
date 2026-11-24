/**
 * Connections admin screen (Administrator only). Edits the NON-SECRET connection coordinates — the
 * operational Fabric SQL (view + test), the ERP Lakehouse used for customer/item validation
 * (server/database + table & column mappings, editable + test), and the AI endpoints. Save → PUT;
 * Test → a live probe. Auth is Entra everywhere, so no credentials are entered here.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { getConnections, putConnections, testConnection, ApiError } from "../api/client.js";
import type { ConnectionsConfig, ConnectionTestResult } from "../api/contract.js";
import { useAuth } from "../auth/AuthContext.js";
import type { Notify } from "../components/Toast.js";

type Target = "operationalDb" | "lakehouse";

export function Settings({ notify }: { notify: Notify }): JSX.Element {
  const { identity, role } = useAuth();
  const [form, setForm] = useState<ConnectionsConfig | null>(null);
  const [meta, setMeta] = useState<{ updatedBy: string | null; updatedAt: string | null }>({ updatedBy: null, updatedAt: null });
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState<Partial<Record<Target, ConnectionTestResult | "running">>>({});

  const load = useCallback(() => {
    setForm(null);
    setError(null);
    getConnections(identity)
      .then((r) => {
        setForm(r.config);
        setMeta({ updatedBy: r.updatedBy, updatedAt: r.updatedAt });
        setDirty(false);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? (e.status === 403 ? "Administrator role required — switch role in the top bar." : `${e.status} — ${e.message}`) : String(e)));
  }, [identity]);

  useEffect(load, [load]);

  const setLake = (patch: Partial<ConnectionsConfig["lakehouse"]>): void => {
    setForm((f) => (f ? { ...f, lakehouse: { ...f.lakehouse, ...patch } } : f));
    setDirty(true);
  };
  const setAi = (patch: Partial<ConnectionsConfig["ai"]>): void => {
    setForm((f) => (f ? { ...f, ai: { ...f.ai, ...patch } } : f));
    setDirty(true);
  };

  const onSave = async (): Promise<void> => {
    if (!form) return;
    setBusy(true);
    try {
      const r = await putConnections(identity, form);
      setMeta({ updatedBy: r.updatedBy, updatedAt: r.updatedAt });
      setDirty(false);
      notify("Connection settings saved");
    } catch (e) {
      notify(e instanceof ApiError ? `Save failed (${e.status})` : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runTest = async (target: Target): Promise<void> => {
    if (!form) return;
    setTests((t) => ({ ...t, [target]: "running" }));
    try {
      const result = await testConnection(identity, target, form);
      setTests((t) => ({ ...t, [target]: result }));
    } catch (e) {
      setTests((t) => ({ ...t, [target]: { ok: false, error: e instanceof ApiError ? `${e.status}` : String(e) } }));
    }
  };

  if (error) return <div className="state err">{error}</div>;
  if (!form) return <div className="state">Loading settings…</div>;

  return (
    <>
      <div className="gridhead">
        <h2>Connections</h2>
        <span className="chip completed" style={{ marginLeft: 4 }}>
          <span className="dot" />
          {role === "Administrator" ? "Administrator" : "read-only"}
        </span>
        <div className="sp" />
        {meta.updatedAt && <span className="env">updated by {meta.updatedBy ?? "—"}</span>}
        <button className="btn" style={{ flex: "none", padding: "8px 14px" }} disabled={!dirty || busy} onClick={() => void onSave()}>
          Save
        </button>
      </div>

      <div className="settings">
        <Section title="Operational database" sub="SQL database in Fabric — the app's own store. Bootstrap, so view + test only." test={tests.operationalDb} onTest={() => void runTest("operationalDb")}>
          <Field label="Server" value={form.operationalDb.server} disabled />
          <Field label="Database" value={form.operationalDb.database} disabled />
          <Field label="Authentication" value={form.operationalDb.authMode} disabled />
        </Section>

        <Section title="ERP Lakehouse (validation)" sub="Fabric Lakehouse holding customer/item masters used to validate & match orders." test={tests.lakehouse} onTest={() => void runTest("lakehouse")}>
          <div className="twocol">
            <Field label="Server" value={form.lakehouse.server} onChange={(v) => setLake({ server: v })} placeholder="…datawarehouse.fabric.microsoft.com" />
            <Field label="Database / warehouse" value={form.lakehouse.database} onChange={(v) => setLake({ database: v })} />
            <Field label="Customer table" value={form.lakehouse.customerTable} onChange={(v) => setLake({ customerTable: v })} />
            <Field label="Item table" value={form.lakehouse.itemTable} onChange={(v) => setLake({ itemTable: v })} />
            <Field label="Customer account column" value={form.lakehouse.customerAccountColumn} onChange={(v) => setLake({ customerAccountColumn: v })} />
            <Field label="Customer name column" value={form.lakehouse.customerNameColumn} onChange={(v) => setLake({ customerNameColumn: v })} />
            <Field label="dataAreaId column" value={form.lakehouse.dataAreaColumn} onChange={(v) => setLake({ dataAreaColumn: v })} />
            <Field label="Item id column" value={form.lakehouse.itemIdColumn} onChange={(v) => setLake({ itemIdColumn: v })} />
          </div>
        </Section>

        <Section title="AI services" sub="Document Intelligence + AI Foundry endpoints (Entra-authenticated).">
          <Field label="Document Intelligence endpoint" value={form.ai.docIntelEndpoint} onChange={(v) => setAi({ docIntelEndpoint: v })} />
          <div className="twocol">
            <Field label="AI Foundry endpoint" value={form.ai.foundryEndpoint} onChange={(v) => setAi({ foundryEndpoint: v })} />
            <Field label="Foundry deployment" value={form.ai.foundryDeployment} onChange={(v) => setAi({ foundryDeployment: v })} />
          </div>
        </Section>
      </div>
    </>
  );
}

function Field({ label, value, onChange, disabled, placeholder }: { label: string; value: string; onChange?: (v: string) => void; disabled?: boolean; placeholder?: string }): JSX.Element {
  return (
    <div className="cdmfield">
      <span className="lab">{label}</span>
      <input value={value} disabled={disabled || !onChange} placeholder={placeholder} onChange={(e) => onChange?.(e.target.value)} />
    </div>
  );
}

function Section({ title, sub, children, test, onTest }: { title: string; sub: string; children: ReactNode; test?: ConnectionTestResult | "running"; onTest?: () => void }): JSX.Element {
  return (
    <section className="panel" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 14 }}>{title}</h3>
          <p className="psub" style={{ margin: "2px 0 0" }}>{sub}</p>
        </div>
        <div style={{ flex: 1 }} />
        {onTest && (
          <button className="toolbtn" onClick={onTest} disabled={test === "running"}>
            {test === "running" ? "Testing…" : "Test connection"}
          </button>
        )}
      </div>
      {test && test !== "running" && (
        <div className={`finding ${test.ok ? "info" : "error"}`} style={{ marginBottom: 12 }}>
          <span className="ic">{test.ok ? "i" : "!"}</span>
          <span>
            <span>{test.ok ? "Connection OK" : "Connection failed"}</span>
            <span className="code">{test.detail ?? test.error ?? ""}</span>
          </span>
        </div>
      )}
      {children}
    </section>
  );
}
