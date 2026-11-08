/**
 * Production wiring for the Graph mailbox source: `DefaultAzureCredential` (managed identity in
 * Container Apps; `az login` / service principal locally) → HTTP Graph client → mailbox source.
 * Nothing here is exercised by unit tests (they inject the fake client); this is the real seam.
 */
import { DefaultAzureCredential } from "@azure/identity";
import { HttpGraphApiClient, type AzureTokenCredential } from "./http-graph-api-client.js";
import { GraphMailboxSource, type DeltaStore } from "./mailbox-source.js";

export interface GraphMailboxConfig {
  mailbox: string;
  folder?: string;
  deltaStore?: DeltaStore;
  /** Override the Graph base URL (e.g. a sovereign cloud); defaults to public v1.0. */
  baseUrl?: string;
}

export function createDefaultGraphMailboxSource(config: GraphMailboxConfig): GraphMailboxSource {
  const credential = new DefaultAzureCredential() as unknown as AzureTokenCredential;
  const client = new HttpGraphApiClient({ credential, baseUrl: config.baseUrl });
  return new GraphMailboxSource({
    client,
    mailbox: config.mailbox,
    folder: config.folder,
    deltaStore: config.deltaStore,
  });
}
