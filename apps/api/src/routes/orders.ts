/**
 * Reviewer workbench API (spec §13, §14). Queue, order detail (with evidence), optimistic-
 * concurrency edits, and approve/reject — all role-enforced server-side. Edits and decisions
 * require an `If-Match: <rowVersion>` header; a stale version yields 409 so edits are never lost.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Persistence } from "@coa/persistence";
import { WRITE_ROLES, hasAnyRole, type Authenticator, type Principal } from "../auth.js";

export interface OrderRoutesDeps {
  persistence: Persistence;
  authenticate: Authenticator;
}

export async function registerOrderRoutes(app: FastifyInstance, deps: OrderRoutesDeps): Promise<void> {
  const { persistence, authenticate } = deps;

  async function authn(req: FastifyRequest, reply: FastifyReply): Promise<Principal | null> {
    const principal = await authenticate(req.headers);
    if (!principal) {
      await reply.code(401).send({ error: "unauthenticated" });
      return null;
    }
    return principal;
  }

  function ifMatch(req: FastifyRequest, reply: FastifyReply): number | null {
    const raw = req.headers["if-match"];
    const n = Number(Array.isArray(raw) ? raw[0] : raw);
    if (raw == null || Number.isNaN(n)) {
      void reply.code(428).send({ error: "If-Match header with the current rowVersion is required" });
      return null;
    }
    return n;
  }

  // Queue.
  app.get<{ Querystring: { company?: string; state?: string; limit?: string } }>("/orders", async (req, reply) => {
    if (!(await authn(req, reply))) return;
    const rows = await persistence.listOrders({
      companyId: req.query.company,
      internalState: req.query.state,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    return reply.send({ orders: rows });
  });

  // Detail (sets ETag = rowVersion for optimistic concurrency).
  app.get<{ Params: { id: string } }>("/orders/:id", async (req, reply) => {
    if (!(await authn(req, reply))) return;
    const detail = await persistence.getOrderForReview(req.params.id);
    if (!detail) return reply.code(404).send({ error: "not found" });
    return reply.header("etag", String(detail.header.rowVersion)).send(detail);
  });

  // Edit header/lines (optimistic concurrency).
  app.patch<{ Params: { id: string }; Body: { header?: unknown; lines?: unknown } }>("/orders/:id", async (req, reply) => {
    const principal = await authn(req, reply);
    if (!principal) return;
    if (!hasAnyRole(principal, WRITE_ROLES)) return reply.code(403).send({ error: "forbidden" });
    const expected = ifMatch(req, reply);
    if (expected == null) return;

    const result = await persistence.updateOrderFields(req.params.id, expected, req.body as never, principal.sub);
    return respondOptimistic(reply, result);
  });

  // Approve / reject.
  for (const [path, decision] of [["approve", "APPROVE"], ["reject", "REJECT"]] as const) {
    app.post<{ Params: { id: string } }>(`/orders/:id/${path}`, async (req, reply) => {
      const principal = await authn(req, reply);
      if (!principal) return;
      if (!hasAnyRole(principal, WRITE_ROLES)) return reply.code(403).send({ error: "forbidden" });
      const expected = ifMatch(req, reply);
      if (expected == null) return;

      const result = await persistence.reviewDecision(req.params.id, decision, expected, principal.sub);
      return respondOptimistic(reply, result);
    });
  }
}

function respondOptimistic(reply: FastifyReply, result: Awaited<ReturnType<Persistence["updateOrderFields"]>>): FastifyReply {
  switch (result.status) {
    case "OK":
      return reply.header("etag", String(result.rowVersion)).send({ rowVersion: result.rowVersion });
    case "CONFLICT":
      return reply.code(409).send({ error: "version conflict", rowVersion: result.rowVersion });
    case "NOT_FOUND":
      return reply.code(404).send({ error: "not found" });
  }
}
