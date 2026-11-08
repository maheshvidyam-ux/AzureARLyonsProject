/**
 * Builds the API Fastify instance with routes registered. Returns the app WITHOUT listening,
 * so tests drive it via `app.inject()` and the entrypoint (`index.ts`) owns `listen`.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { registerHealthRoutes } from "./routes/health.js";
import { registerGraphNotificationRoutes } from "./routes/graph-notifications.js";
import type { ServerDeps } from "./types.js";

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? false,
    // Graph notification payloads are small; keep a tight body limit.
    bodyLimit: 1_048_576,
  });

  await registerHealthRoutes(app);
  await registerGraphNotificationRoutes(app, deps);

  return app;
}
