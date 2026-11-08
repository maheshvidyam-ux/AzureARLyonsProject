/**
 * Microsoft Graph change-notification webhook (spec §4). Two behaviours on one POST endpoint:
 *
 *  1. Subscription validation handshake — Graph POSTs `?validationToken=...`; we echo it back
 *     as text/plain within the timeout so the subscription can be created.
 *  2. Change notifications — a JSON body of notifications. We verify each `clientState` against
 *     our secret (spec §3), enqueue the verified message ids for the workers, surface lifecycle
 *     events, and return 202 fast (heavy work happens asynchronously downstream).
 *
 * The parsing/verification logic is the pure `parseNotifications` from the Graph ingestion
 * module; this route is only the HTTP shell.
 */
import type { FastifyInstance } from "fastify";
import { graphValidationResponse, parseNotifications } from "../../../workers/src/ingestion/graph/index.js";
import type { ServerDeps } from "../types.js";

export async function registerGraphNotificationRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  app.post<{ Querystring: { validationToken?: string } }>(
    "/integration/graph/notifications",
    async (req, reply) => {
      // 1. Validation handshake.
      const validationToken = req.query.validationToken;
      if (validationToken) {
        const v = graphValidationResponse(validationToken);
        return reply.code(v.status).header("content-type", v.contentType).send(v.body);
      }

      // 2. Change notifications.
      const parsed = parseNotifications(req.body, deps.graphClientState);

      if (parsed.messageIds.length > 0) {
        await deps.graph.enqueueMessageIds(parsed.messageIds);
      }
      if (parsed.lifecycleEvents.length > 0 && deps.graph.onLifecycleEvents) {
        await deps.graph.onLifecycleEvents(parsed.lifecycleEvents);
      }
      if (parsed.rejected > 0) {
        req.log.warn({ rejected: parsed.rejected }, "graph notifications rejected (clientState mismatch)");
      }

      // 202 Accepted — Graph only needs acknowledgement; processing is asynchronous.
      return reply.code(202).send();
    },
  );
}
