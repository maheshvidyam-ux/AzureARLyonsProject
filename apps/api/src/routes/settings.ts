/**
 * Connection config admin API (Administrator only). GET returns the effective connections config
 * (stored overlaid on env defaults); PUT persists edits; POST /test opens a transient pool and runs
 * a probe so an admin can verify coordinates before saving. No secrets cross this API — everything
 * is Entra-authenticated coordinates.
 */
import type { FastifyInstance } from "fastify";
import type { Persistence } from "@coa/persistence";
import { ADMIN_ROLES, hasAnyRole, type Authenticator } from "../auth.js";
import {
  CONNECTIONS_KEY,
  defaultConnectionTester,
  mergeConnections,
  type ConnectionsConfig,
  type ConnectionTarget,
  type ConnectionTester,
} from "../settings.js";

export interface SettingsRoutesDeps {
  persistence: Persistence;
  authenticate: Authenticator;
  tester?: ConnectionTester;
}

async function readStored(persistence: Persistence): Promise<{ config: ConnectionsConfig; updatedBy: string | null; updatedAt: string | null }> {
  const row = await persistence.getConfig(CONNECTIONS_KEY);
  let stored: Partial<ConnectionsConfig> | null = null;
  if (row) {
    try {
      stored = JSON.parse(row.value) as Partial<ConnectionsConfig>;
    } catch {
      stored = null;
    }
  }
  return { config: mergeConnections(stored), updatedBy: row?.updatedBy ?? null, updatedAt: row?.updatedAt ?? null };
}

export async function registerSettingsRoutes(app: FastifyInstance, deps: SettingsRoutesDeps): Promise<void> {
  const { persistence, authenticate } = deps;
  const tester = deps.tester ?? defaultConnectionTester;

  app.get("/settings/connections", async (req, reply) => {
    const principal = await authenticate(req.headers);
    if (!principal) return reply.code(401).send({ error: "unauthenticated" });
    if (!hasAnyRole(principal, ADMIN_ROLES)) return reply.code(403).send({ error: "forbidden" });
    return reply.send(await readStored(persistence));
  });

  app.put<{ Body: ConnectionsConfig }>("/settings/connections", async (req, reply) => {
    const principal = await authenticate(req.headers);
    if (!principal) return reply.code(401).send({ error: "unauthenticated" });
    if (!hasAnyRole(principal, ADMIN_ROLES)) return reply.code(403).send({ error: "forbidden" });
    const body = req.body;
    if (!body || typeof body !== "object" || !body.lakehouse || !body.ai) {
      return reply.code(400).send({ error: "connections config with lakehouse + ai sections is required" });
    }
    await persistence.putConfig(CONNECTIONS_KEY, JSON.stringify(body), principal.sub);
    return reply.send(await readStored(persistence));
  });

  app.post<{ Body: { target: ConnectionTarget; config?: ConnectionsConfig } }>("/settings/connections/test", async (req, reply) => {
    const principal = await authenticate(req.headers);
    if (!principal) return reply.code(401).send({ error: "unauthenticated" });
    if (!hasAnyRole(principal, ADMIN_ROLES)) return reply.code(403).send({ error: "forbidden" });
    const target = req.body?.target;
    if (target !== "operationalDb" && target !== "lakehouse") return reply.code(400).send({ error: "target must be operationalDb or lakehouse" });
    const cfg = req.body?.config ?? (await readStored(persistence)).config;
    return reply.send(await tester(target, cfg));
  });
}
