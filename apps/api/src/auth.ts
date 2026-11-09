/**
 * App roles + authentication seam (spec §3, §13 RBAC). Role enforcement is server-side.
 *
 * The real authenticator validates an Entra OIDC bearer token and maps app roles — that is a
 * later slice. For now a clearly-labelled DEV authenticator reads `x-dev-user` / `x-dev-roles`
 * headers so the reviewer API is testable and runnable locally. The dev authenticator MUST NOT
 * be used in any environment that is network-reachable.
 */
export type AppRole = "Administrator" | "OrderProcessor" | "Supervisor" | "Viewer" | "IntegrationService";

export interface Principal {
  sub: string;
  roles: AppRole[];
}

export type Authenticator = (headers: Record<string, string | string[] | undefined>) => Promise<Principal | null>;

/** Roles permitted to edit/approve/reject orders (Viewer is read-only). */
export const WRITE_ROLES: AppRole[] = ["OrderProcessor", "Supervisor", "Administrator"];

export function hasAnyRole(principal: Principal, roles: AppRole[]): boolean {
  return principal.roles.some((r) => roles.includes(r));
}

/** DEV ONLY — trusts request headers. Replace with Entra OIDC validation before any real use. */
export function devHeaderAuthenticator(): Authenticator {
  return async (headers) => {
    const sub = headers["x-dev-user"];
    if (!sub) return null;
    const roles = String(headers["x-dev-roles"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean) as AppRole[];
    return { sub: String(sub), roles };
  };
}
