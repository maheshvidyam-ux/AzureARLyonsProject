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

import type { Persistence } from "@coa/persistence";
import type { MasterDataReader } from "@coa/fabric-read";
import type { Authenticator } from "./auth.js";
import type { UploadProcessor } from "./upload.js";
import type { ConnectionTester } from "./settings.js";

export interface ServerDeps {
  /** Secret set on the Graph subscription; notifications must echo it (spec §3). */
  graphClientState: string;
  graph: GraphNotificationSink;
  /** When provided, the reviewer workbench routes (/orders) are registered. */
  persistence?: Persistence;
  /** Fabric master-data read model; enables order revalidation (re-matching) in the reviewer. */
  masters?: MasterDataReader;
  /** When provided, the manual upload route (POST /uploads) is registered. */
  uploads?: UploadProcessor;
  /** Authenticator for the reviewer + upload routes (defaults to the DEV header authenticator). */
  authenticate?: Authenticator;
  /** Overrides the live "test connection" prober (settings API) — injected in tests. */
  connectionTester?: ConnectionTester;
  /** Fastify logger option (false in tests). */
  logger?: boolean;
}
