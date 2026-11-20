/**
 * App shell + tiny client router (queue ⇄ order detail). Kept dependency-free: route is a small
 * state object, not a URL router, which is enough for this slice. The top bar hosts the dev role
 * switcher so RBAC behaviour (Viewer is read-only, 403 on write) is visible while testing.
 */
import { useCallback, useState } from "react";
import { useAuth, SELECTABLE_ROLES } from "./auth/AuthContext.js";
import { Queue } from "./views/Queue.js";
import { OrderDetail } from "./views/OrderDetail.js";
import { useToast, ToastHost } from "./components/Toast.js";
import type { AppRole } from "./api/contract.js";

type Route = { name: "queue" } | { name: "detail"; id: string; po: string };

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
        <button className="navi" aria-current="true" title="Review queue">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
            <circle cx="3.5" cy="6" r="1.4" /><circle cx="3.5" cy="12" r="1.4" /><circle cx="3.5" cy="18" r="1.4" />
          </svg>
        </button>
      </nav>

      <div className="mainwrap">
        <header className="top">
          <div className="crumbs">
            {route.name === "queue" ? (
              <span className="cur">Customer orders</span>
            ) : (
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
          {route.name === "queue" ? (
            <Queue onOpen={openOrder} />
          ) : (
            <OrderDetail orderId={route.id} onBack={backToQueue} notify={notify} />
          )}
        </div>
      </div>

      <ToastHost toast={toast} />
    </div>
  );
}
