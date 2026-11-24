/**
 * Thin fetch client for the reviewer API. It carries the auth identity as headers and handles
 * optimistic concurrency: GET /orders/:id returns an ETag (the rowVersion); edits and decisions
 * send it back as If-Match. A 409 surfaces as a typed ConflictError so the UI can prompt a reload
 * rather than silently clobbering someone else's edit.
 *
 * In dev the base is "/api" (Vite proxies to the seeded in-memory API). Auth is the DEV header
 * authenticator today; swapping to an Entra bearer token is a one-line change to authHeaders().
 */
import type { OrderReviewDetail, OrderSummaryRow, UpdateOrderInput, AppRole, ConnectionsConfig, ConnectionsResponse, ConnectionTestResult } from "./contract.js";

const BASE = "/api";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
/** 409 — the caller's rowVersion was stale; the order changed underneath them. */
export class ConflictError extends ApiError {
  constructor(readonly currentRowVersion: number) {
    super(409, "This order changed since you opened it.");
    this.name = "ConflictError";
  }
}

export interface Identity {
  user: string;
  roles: AppRole[];
}

function authHeaders(id: Identity): Record<string, string> {
  return { "x-dev-user": id.user, "x-dev-roles": id.roles.join(",") };
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

export async function listOrders(id: Identity, filter: { company?: string; state?: string } = {}): Promise<OrderSummaryRow[]> {
  const qs = new URLSearchParams();
  if (filter.company) qs.set("company", filter.company);
  if (filter.state) qs.set("state", filter.state);
  const res = await fetch(`${BASE}/orders${qs.toString() ? `?${qs}` : ""}`, { headers: authHeaders(id) });
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  return ((await res.json()) as { orders: OrderSummaryRow[] }).orders;
}

export async function getOrder(id: Identity, orderId: string): Promise<OrderReviewDetail> {
  const res = await fetch(`${BASE}/orders/${encodeURIComponent(orderId)}`, { headers: authHeaders(id) });
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  return (await res.json()) as OrderReviewDetail;
}

/** Returns the new rowVersion. Throws ConflictError on 409. */
async function mutate(id: Identity, url: string, rowVersion: number, body?: unknown): Promise<number> {
  const res = await fetch(url, {
    method: body === undefined ? "POST" : "PATCH",
    headers: { ...authHeaders(id), "if-match": String(rowVersion), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 409) throw new ConflictError(((await res.json()) as { rowVersion: number }).rowVersion);
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  return ((await res.json()) as { rowVersion: number }).rowVersion;
}

export function patchOrder(id: Identity, orderId: string, rowVersion: number, patch: UpdateOrderInput): Promise<number> {
  return mutate(id, `${BASE}/orders/${encodeURIComponent(orderId)}`, rowVersion, patch);
}
export function approveOrder(id: Identity, orderId: string, rowVersion: number): Promise<number> {
  return mutate(id, `${BASE}/orders/${encodeURIComponent(orderId)}/approve`, rowVersion);
}
export function revalidateOrder(id: Identity, orderId: string, rowVersion: number): Promise<number> {
  return mutate(id, `${BASE}/orders/${encodeURIComponent(orderId)}/revalidate`, rowVersion);
}
export function rejectOrder(id: Identity, orderId: string, rowVersion: number): Promise<number> {
  return mutate(id, `${BASE}/orders/${encodeURIComponent(orderId)}/reject`, rowVersion);
}

// --- settings / connections (Administrator) ---
export async function getConnections(id: Identity): Promise<ConnectionsResponse> {
  const res = await fetch(`${BASE}/settings/connections`, { headers: authHeaders(id) });
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  return (await res.json()) as ConnectionsResponse;
}
export async function putConnections(id: Identity, config: ConnectionsConfig): Promise<ConnectionsResponse> {
  const res = await fetch(`${BASE}/settings/connections`, { method: "PUT", headers: { ...authHeaders(id), "content-type": "application/json" }, body: JSON.stringify(config) });
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  return (await res.json()) as ConnectionsResponse;
}
export async function testConnection(id: Identity, target: "operationalDb" | "lakehouse", config: ConnectionsConfig): Promise<ConnectionTestResult> {
  const res = await fetch(`${BASE}/settings/connections/test`, { method: "POST", headers: { ...authHeaders(id), "content-type": "application/json" }, body: JSON.stringify({ target, config }) });
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  return (await res.json()) as ConnectionTestResult;
}
