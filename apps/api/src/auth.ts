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

/** Roles permitted to view/change connection configuration. */
export const ADMIN_ROLES: AppRole[] = ["Administrator"];

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

// ---------------------------------------------------------------------------
// Entra Easy Auth (Azure Container Apps built-in authentication)
// ---------------------------------------------------------------------------
// When Easy Auth is enabled on the Container App, the platform validates the
// Entra ID token at the edge and forwards the signed-in identity to the app as
// the base64-encoded JSON header `x-ms-client-principal`. The app NEVER sees a
// raw token and does no token validation itself — it trusts the header because
// unauthenticated requests are rejected by the platform before reaching us.
//
// We map the token's app-role claims (Entra "App roles" assigned to users, or
// group ids) to our AppRole set. The claim set is configurable so the same code
// works whether the tenant uses App Roles ("roles") or group object ids.

interface EasyAuthClaim {
  typ: string;
  val: string;
}

interface EasyAuthPrincipal {
  auth_typ?: string;
  name_typ?: string;
  role_typ?: string;
  claims?: EasyAuthClaim[];
}

/** Claim types Easy Auth may use for the role/app-role values, in priority order. */
const ROLE_CLAIM_TYPES = [
  "roles",
  "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
  "groups",
];

/** Claim types that carry a stable subject identifier, in priority order. */
const SUBJECT_CLAIM_TYPES = [
  "http://schemas.microsoft.com/identity/claims/objectidentifier",
  "oid",
  "sub",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
  "preferred_username",
  "name",
];

const KNOWN_ROLES: AppRole[] = [
  "Administrator",
  "OrderProcessor",
  "Supervisor",
  "Viewer",
  "IntegrationService",
];

/**
 * Maps a raw claim value to an AppRole. By default accepts the role name verbatim
 * (case-insensitively) — e.g. an Entra App Role with value "OrderProcessor". A
 * `roleMap` lets a tenant map group object-ids (or differently-named roles) onto
 * AppRoles without code changes.
 */
function resolveRole(value: string, roleMap: Record<string, AppRole>): AppRole | null {
  const mapped = roleMap[value];
  if (mapped) return mapped;
  const match = KNOWN_ROLES.find((r) => r.toLowerCase() === value.toLowerCase());
  return match ?? null;
}

function firstClaim(claims: EasyAuthClaim[], types: string[]): string | null {
  for (const type of types) {
    const hit = claims.find((c) => c.typ === type && c.val);
    if (hit) return hit.val;
  }
  return null;
}

export interface EasyAuthOptions {
  /** Optional map from a raw claim value (e.g. a group object-id) to an AppRole. */
  roleMap?: Record<string, AppRole>;
}

/**
 * Authenticator for Azure Container Apps Easy Auth. Decodes `x-ms-client-principal`
 * and maps role/app-role/group claims to AppRoles. Returns null (→ 401) when the
 * header is missing or unparseable, so a misconfigured Easy Auth fails closed.
 */
export function easyAuthAuthenticator(options: EasyAuthOptions = {}): Authenticator {
  const roleMap = options.roleMap ?? {};
  return async (headers) => {
    const raw = headers["x-ms-client-principal"];
    if (!raw) return null;
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!header) return null;

    let principal: EasyAuthPrincipal;
    try {
      principal = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as EasyAuthPrincipal;
    } catch {
      return null;
    }
    const claims = principal.claims ?? [];
    if (claims.length === 0) return null;

    const sub = firstClaim(claims, SUBJECT_CLAIM_TYPES);
    if (!sub) return null;

    const roles = claims
      .filter((c) => ROLE_CLAIM_TYPES.includes(c.typ))
      .map((c) => resolveRole(c.val, roleMap))
      .filter((r): r is AppRole => r !== null);

    // De-duplicate while preserving order.
    const unique = roles.filter((r, i) => roles.indexOf(r) === i);
    return { sub, roles: unique };
  };
}

/**
 * Parses an optional `EASY_AUTH_ROLE_MAP` env value of the form
 * "<claimValue>=<AppRole>,<claimValue>=<AppRole>" (e.g. a group-id → role map).
 * Unknown AppRole targets are ignored.
 */
export function roleMapFromEnv(value: string | undefined): Record<string, AppRole> {
  const map: Record<string, AppRole> = {};
  if (!value) return map;
  for (const pair of value.split(",")) {
    const [key, role] = pair.split("=").map((s) => s.trim());
    if (!key || !role) continue;
    const match = KNOWN_ROLES.find((r) => r.toLowerCase() === role.toLowerCase());
    if (match) map[key] = match;
  }
  return map;
}
