/**
 * AP vendor-invoice reviewer API — the invoice counterpart of routes/orders.ts. Queue, detail
 * (header + lines + 3-way-match status + validation + evidence, ETag = row_version), optimistic
 * edits (incl. GL coding for Non-PO C&A lines), and approve/reject. APPROVE stages the invoice to
 * staging_vendor_invoice (Boomi → AX voucher). A Non-PO invoice can't be approved until every
 * Code-&-Approve line has a GL account.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Persistence } from "@coa/persistence";
import { WRITE_ROLES, hasAnyRole, type Authenticator, type Principal } from "../auth.js";

export interface InvoiceRoutesDeps {
  persistence: Persistence;
  authenticate: Authenticator;
}

export async function registerInvoiceRoutes(app: FastifyInstance, deps: InvoiceRoutesDeps): Promise<void> {
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
  app.get<{ Querystring: { company?: string; state?: string; type?: string; limit?: string } }>("/invoices", async (req, reply) => {
    if (!(await authn(req, reply))) return;
    const rows = await persistence.listInvoices({
      companyId: req.query.company,
      internalState: req.query.state,
      invoiceType: req.query.type,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    return reply.send({ invoices: rows });
  });

  // Detail (ETag = rowVersion).
  app.get<{ Params: { id: string } }>("/invoices/:id", async (req, reply) => {
    if (!(await authn(req, reply))) return;
    const detail = await persistence.getInvoiceForReview(req.params.id);
    if (!detail) return reply.code(404).send({ error: "not found" });
    return reply.header("etag", String(detail.header.rowVersion)).send(detail);
  });

  // Edit header/lines (optimistic concurrency) — includes GL coding for Non-PO.
  app.patch<{ Params: { id: string }; Body: { header?: unknown; lines?: unknown } }>("/invoices/:id", async (req, reply) => {
    const principal = await authn(req, reply);
    if (!principal) return;
    if (!hasAnyRole(principal, WRITE_ROLES)) return reply.code(403).send({ error: "forbidden" });
    const expected = ifMatch(req, reply);
    if (expected == null) return;
    const result = await persistence.updateInvoiceFields(req.params.id, expected, req.body as never, principal.sub);
    return respondOptimistic(reply, result);
  });

  // Approve / reject.
  for (const [path, decision] of [["approve", "APPROVE"], ["reject", "REJECT"]] as const) {
    app.post<{ Params: { id: string } }>(`/invoices/:id/${path}`, async (req, reply) => {
      const principal = await authn(req, reply);
      if (!principal) return;
      if (!hasAnyRole(principal, WRITE_ROLES)) return reply.code(403).send({ error: "forbidden" });
      const expected = ifMatch(req, reply);
      if (expected == null) return;

      // Guard: a Non-PO invoice can't be vouchered until every C&A line is GL-coded.
      if (decision === "APPROVE") {
        const detail = await persistence.getInvoiceForReview(req.params.id);
        if (detail && detail.header.invoiceType === "NON_PO") {
          const uncoded = detail.lines.some((l) => l.isCodeAndApprove && !l.glAccount);
          if (uncoded) return reply.code(409).send({ error: "assign a GL account to the Code & Approve line before approving" });
        }
      }

      const result = await persistence.invoiceReviewDecision(req.params.id, decision, expected, principal.sub);
      return respondOptimistic(reply, result);
    });
  }
}

function respondOptimistic(reply: FastifyReply, result: Awaited<ReturnType<Persistence["updateInvoiceFields"]>>): FastifyReply {
  switch (result.status) {
    case "OK":
      return reply.header("etag", String(result.rowVersion)).send({ rowVersion: result.rowVersion });
    case "CONFLICT":
      return reply.code(409).send({ error: "version conflict", rowVersion: result.rowVersion });
    case "NOT_FOUND":
      return reply.code(404).send({ error: "not found" });
  }
}
