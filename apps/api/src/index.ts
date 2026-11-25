/**
 * API service entrypoint (Container App). Wires:
 *   - the Graph notification webhook (AR + AP mailboxes → Service Bus ingestion queues), and
 *   - the reviewer workbench + manual-upload + settings routes, behind Entra Easy Auth.
 *
 * Authentication: this entrypoint ALWAYS uses the Entra Easy Auth authenticator (Azure Container
 * Apps built-in auth validates the token at the edge and forwards `x-ms-client-principal`). The
 * DEV header authenticator is never used here — local development runs the server via the dev
 * harness (apps/web/dev-api.mts), not this entrypoint.
 *
 * Backend wiring is env-gated so the container boots even before everything is configured:
 *   - Reviewer/upload/settings routes register when FABRIC_SQL_SERVER is set (operational DB).
 *   - AR matching + AP uploads turn on when LAKEHOUSE_SQL_SERVER is set.
 * Required secret in any environment that receives real Graph notifications: GRAPH_CLIENT_STATE.
 */
import { createPool, fabricSqlConfigFromEnv, FabricSqlPersistence } from "@coa/persistence";
import { buildServer } from "./server.js";
import { loadConfig } from "./config.js";
import { resolveIngestionPublisher } from "./publisher.js";
import { easyAuthAuthenticator, roleMapFromEnv } from "./auth.js";
import { defaultConnectionTester } from "./settings.js";
import { buildUploadBundle } from "./uploads-pipeline.js";
import type { GraphNotificationSink, ServerDeps } from "./types.js";

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

  // AP invoices — when the AP subscription secret is configured, AP-mailbox notifications are
  // published to the separate `ingestion-ap` queue (consumed by the invoice worker).
  let graphAp: GraphNotificationSink | undefined;
  if (config.graphClientStateAp) {
    const apPublisher = resolveIngestionPublisher(process.env, process.env.AP_INGESTION_QUEUE_NAME ?? "ingestion-ap");
    graphAp = { async enqueueMessageIds(ids) { for (const id of ids) await apPublisher.publish({ messageId: id }); } };
  }

  // Entra Easy Auth: the platform forwards the signed-in identity as `x-ms-client-principal`.
  // Optional EASY_AUTH_ROLE_MAP maps group object-ids → AppRoles when the tenant uses groups.
  const authenticate = easyAuthAuthenticator({ roleMap: roleMapFromEnv(process.env.EASY_AUTH_ROLE_MAP) });

  const deps: ServerDeps = {
    graphClientState: config.graphClientState,
    graph,
    authenticate,
    logger: true,
    ...(config.graphClientStateAp ? { graphClientStateAp: config.graphClientStateAp } : {}),
    ...(graphAp ? { graphAp } : {}),
  };

  // Reviewer workbench + uploads + settings — only when the operational DB is configured.
  if (process.env.FABRIC_SQL_SERVER) {
    const persistence = new FabricSqlPersistence(await createPool(fabricSqlConfigFromEnv()));
    const bundle = await buildUploadBundle(persistence);
    deps.persistence = persistence;
    deps.uploads = bundle.uploads;
    deps.connectionTester = defaultConnectionTester;
    if (bundle.masters) deps.masters = bundle.masters;
    console.log(
      `[api] reviewer + upload + settings routes enabled (masters: ${bundle.masters ? "on" : "deferred"})`,
    );
  } else {
    console.log("[api] FABRIC_SQL_SERVER not set — serving health + Graph webhook only");
  }

  const app = await buildServer(deps);
  await app.listen({ host: config.host, port: config.port });
}

main().catch((err) => {
  console.error("API failed to start:", err);
  process.exitCode = 1;
});
