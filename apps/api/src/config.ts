/** Environment-driven config for the API service. Secrets come from Key Vault in prod. */
export interface ApiConfig {
  host: string;
  port: number;
  graphClientState: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    host: env.HOST ?? "0.0.0.0",
    port: Number(env.PORT ?? 8080),
    // The subscription clientState secret. REQUIRED in any environment that receives real
    // Graph notifications; a missing value disables verification-backed processing.
    graphClientState: requireEnv(env, "GRAPH_CLIENT_STATE"),
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}
