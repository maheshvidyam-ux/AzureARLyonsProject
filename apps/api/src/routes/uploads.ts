/**
 * Manual upload endpoint (spec §4): a user uploads a document to be processed like an emailed
 * attachment. Accepts a base64 payload (the SPA encodes the chosen file); large files raise the
 * body limit. Role-enforced (same write roles as editing). Returns the processing outcome inline.
 */
import type { FastifyInstance } from "fastify";
import { MODULE_CODES, type ModuleCode } from "@coa/domain";
import { WRITE_ROLES, hasAnyRole, type Authenticator } from "../auth.js";
import type { UploadProcessor } from "../upload.js";

export interface UploadRoutesDeps {
  uploads: UploadProcessor;
  authenticate: Authenticator;
}

interface UploadBody {
  module?: string;
  filename?: string;
  contentBase64?: string;
  companyId?: string;
}

export async function registerUploadRoutes(app: FastifyInstance, deps: UploadRoutesDeps): Promise<void> {
  app.post<{ Body: UploadBody }>("/uploads", { bodyLimit: 25_000_000 }, async (req, reply) => {
    const principal = await deps.authenticate(req.headers);
    if (!principal) return reply.code(401).send({ error: "unauthenticated" });
    if (!hasAnyRole(principal, WRITE_ROLES)) return reply.code(403).send({ error: "forbidden" });

    const body = req.body ?? {};
    if (!body.module || !(MODULE_CODES as readonly string[]).includes(body.module)) {
      return reply.code(400).send({ error: `module is required and must be one of: ${MODULE_CODES.join(", ")}` });
    }
    if (!body.filename || !body.contentBase64) {
      return reply.code(400).send({ error: "filename and contentBase64 are required" });
    }
    const bytes = Buffer.from(body.contentBase64, "base64");
    if (bytes.length === 0) return reply.code(400).send({ error: "uploaded file is empty or not valid base64" });

    const outcome = await deps.uploads.process({
      module: body.module as ModuleCode,
      filename: body.filename,
      bytes,
      uploadedBy: principal.sub,
      companyId: body.companyId,
    });
    return reply.code(201).send(outcome);
  });
}
