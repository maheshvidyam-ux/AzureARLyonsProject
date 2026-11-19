/**
 * Builds the API Fastify instance with routes registered. Returns the app WITHOUT listening,
 * so tests drive it via `app.inject()` and the entrypoint (`index.ts`) owns `listen`.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { registerHealthRoutes } from "./routes/health.js";
import { registerGraphNotificationRoutes } from "./routes/graph-notifications.js";
import { registerOrderRoutes } from "./routes/orders.js";
import { registerUploadRoutes } from "./routes/uploads.js";
import { devHeaderAuthenticator } from "./auth.js";
import type { ServerDeps } from "./types.js";

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? false,
    // Graph notification payloads are small; keep a tight body limit.
    bodyLimit: 1_048_576,
  });

  await registerHealthRoutes(app);
  await registerGraphNotificationRoutes(app, deps);

  const authenticate = deps.authenticate ?? devHeaderAuthenticator();

  // Reviewer workbench routes are registered only when a persistence backend is wired.
  if (deps.persistence) {
    await registerOrderRoutes(app, { persistence: deps.persistence, authenticate });
  }
  // Manual upload route is registered only when an upload processor is wired.
  if (deps.uploads) {
    await registerUploadRoutes(app, { uploads: deps.uploads, authenticate });
  }

  return app;
}
