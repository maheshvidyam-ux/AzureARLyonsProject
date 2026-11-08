/**
 * Dependencies the HTTP server is built with. Injected so routes have no ambient singletons
 * and the server can be driven in tests via `app.inject()` with no network or cloud access.
 */
export interface GraphNotificationSink {
  /** Hand verified message ids to the workers (Service Bus in prod; injected stub in tests). */
  enqueueMessageIds(ids: string[]): Promise<void>;
  /** Handle Graph lifecycle events (e.g. reauthorizationRequired → renew subscription). */
  onLifecycleEvents?(events: Array<{ subscriptionId?: string; event: string }>): Promise<void>;
}

export interface ServerDeps {
  /** Secret set on the Graph subscription; notifications must echo it (spec §3). */
  graphClientState: string;
  graph: GraphNotificationSink;
  /** Fastify logger option (false in tests). */
  logger?: boolean;
}
