import type { FastifyInstance } from "fastify";

/** Liveness / readiness / minimal metrics (spec §15; Phase-1 exit `GET /health`, `GET /metrics`). */
export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async () => ({ status: "ready" }));

  // Minimal Prometheus exposition — real metrics (queue depth, latency, AI cost) land in Phase 7.
  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4");
    return `# HELP process_uptime_seconds Process uptime.\n# TYPE process_uptime_seconds gauge\nprocess_uptime_seconds ${process.uptime().toFixed(0)}\n`;
  });
}
