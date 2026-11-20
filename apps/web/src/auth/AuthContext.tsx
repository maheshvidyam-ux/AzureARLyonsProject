/**
 * Dev identity context. Today it models the DEV header authenticator: the user picks a role and
 * every API call carries x-dev-user / x-dev-roles. When Entra OIDC lands, this provider becomes
 * the place that holds the signed-in principal + bearer token — the rest of the app is unchanged
 * because it only ever reads `identity` from here.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { AppRole } from "../api/contract.js";
import type { Identity } from "../api/client.js";

const PRESETS: Record<AppRole, Identity> = {
  Supervisor: { user: "supervisor@lyons", roles: ["Supervisor"] },
  OrderProcessor: { user: "csr@lyons", roles: ["OrderProcessor"] },
  Viewer: { user: "viewer@lyons", roles: ["Viewer"] },
  Administrator: { user: "admin@lyons", roles: ["Administrator"] },
  IntegrationService: { user: "svc@lyons", roles: ["IntegrationService"] },
};

interface AuthValue {
  identity: Identity;
  role: AppRole;
  setRole: (r: AppRole) => void;
  canWrite: boolean;
}

const Ctx = createContext<AuthValue | null>(null);
const WRITE: AppRole[] = ["OrderProcessor", "Supervisor", "Administrator"];

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [role, setRole] = useState<AppRole>("Supervisor");
  const value = useMemo<AuthValue>(
    () => ({ identity: PRESETS[role], role, setRole, canWrite: WRITE.includes(role) }),
    [role],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used within AuthProvider");
  return v;
}

export const SELECTABLE_ROLES: AppRole[] = ["Supervisor", "OrderProcessor", "Viewer"];
