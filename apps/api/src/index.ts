/**
 * API service entrypoint (Container App). Wires config + a Graph notification sink and starts
 * the server. The sink's enqueue is a stub that logs; it becomes a Service Bus send to the
 * `ingestion` queue in the next slice, where a worker fetches each message's attachments and
 * runs the pipeline.
 */
import { buildServer } from "./server.js";
import { loadConfig } from "./config.js";
import { resolveIngestionPublisher } from "./publisher.js";
import type { GraphNotificationSink } from "./types.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const publisher = resolveIngestionPublisher();

  const graph: GraphNotificationSink = {
    async enqueueMessageIds(ids) {
      // Publish each verified message id to the `ingestion` queue for the workers to fetch+process.
      for (const id of ids) await publisher.publish({ messageId: id });
    },
    async onLifecycleEvents(events) {
      // TODO(Phase 2): on reauthorizationRequired/subscriptionRemoved, renew/recreate the subscription.
      console.log(`[graph] lifecycle events: ${events.map((e) => e.event).join(", ")}`);
    },
  };

  // NOTE: the reviewer workbench routes (/orders) are intentionally NOT wired here yet. They
  // require the real Entra OIDC authenticator (a later slice) — serving them with the DEV
  // header authenticator on a network-reachable endpoint would be a security hole (spec §3).
  // They are fully built + tested via buildServer({ persistence, authenticate }).
  const app = await buildServer({ graphClientState: config.graphClientState, graph, logger: true });

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err) => {
  console.error("API failed to start:", err);
  process.exitCode = 1;
});
