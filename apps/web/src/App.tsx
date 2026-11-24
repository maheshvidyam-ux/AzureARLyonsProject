/**
 * App shell + tiny client router (queue ⇄ order detail). Kept dependency-free: route is a small
 * state object, not a URL router, which is enough for this slice. The top bar hosts the dev role
 * switcher so RBAC behaviour (Viewer is read-only, 403 on write) is visible while testing.
 */
import { useCallback, useState } from "react";
import { useAuth, SELECTABLE_ROLES } from "./auth/AuthContext.js";
import { Queue } from "./views/Queue.js";
import { OrderDetail } from "./views/OrderDetail.js";
import { Settings } from "./views/Settings.js";
import { useToast, ToastHost } from "./components/Toast.js";
import type { AppRole } from "./api/contract.js";

type Route = { name: "queue" } | { name: "detail"; id: string; po: string } | { name: "settings" };

export function App(): JSX.Element {
  const { role, setRole } = useAuth();
  const [route, setRoute] = useState<Route>({ name: "queue" });
  const { toast, notify } = useToast();

  const openOrder = useCallback((id: string, po: string) => setRoute({ name: "detail", id, po }), []);
  const backToQueue = useCallback(() => setRoute({ name: "queue" }), []);

  return (
    <div className="app">
      <nav className="side" aria-label="Primary">
        <div className="logo">OA</div>
        <button className="navi" aria-current={route.name !== "settings"} title="Review queue" onClick={backToQueue}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
            <circle cx="3.5" cy="6" r="1.4" /><circle cx="3.5" cy="12" r="1.4" /><circle cx="3.5" cy="18" r="1.4" />
          </svg>
        </button>
        <div style={{ flex: 1 }} />
        <button className="navi" aria-current={route.name === "settings"} title="Connections" onClick={() => setRoute({ name: "settings" })}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </nav>

      <div className="mainwrap">
        <header className="top">
          <div className="crumbs">
            {route.name === "queue" && <span className="cur">Customer orders</span>}
            {route.name === "settings" && <span className="cur">Connections</span>}
            {route.name === "detail" && (
              <>
                <button onClick={backToQueue}>Customer orders</button>
                <span className="sep">/</span>
                <span className="cur">{route.po}</span>
              </>
            )}
          </div>
          <div className="sp" />
          <label className="rolesel">
            Role:{" "}
            <select value={role} onChange={(e) => setRole(e.target.value as AppRole)} aria-label="Dev role">
              {SELECTABLE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <span className="env">dev · Fabric SQL</span>
        </header>

        <div className={route.name === "detail" ? "view view-detail" : "view"}>
          {route.name === "queue" && <Queue onOpen={openOrder} />}
          {route.name === "settings" && <Settings notify={notify} />}
          {route.name === "detail" && <OrderDetail orderId={route.id} onBack={backToQueue} notify={notify} />}
        </div>
      </div>

      <ToastHost toast={toast} />
    </div>
  );
}
