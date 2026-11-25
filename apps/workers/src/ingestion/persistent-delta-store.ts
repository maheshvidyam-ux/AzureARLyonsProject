/**
 * Durable delta cursor for scheduled polling — the key to no-loss ingestion. The `@odata.deltaLink`
 * per mailbox is stored in app_config (via the persistence config store), so a poll run that crashes
 * or a worker restart simply resumes from the last COMMITTED cursor and re-fetches anything not yet
 * handed off. Stored as a config entry, so no extra table/migration is needed.
 */
import type { DeltaStore } from "./graph/index.js";

/** The slice of the persistence port this needs (FabricSqlPersistence / InMemoryPersistence satisfy it). */
export interface ConfigStore {
  getConfig(key: string): Promise<{ value: string } | null>;
  putConfig(key: string, value: string, actor: string): Promise<void>;
}

export class PersistentDeltaStore implements DeltaStore {
  constructor(
    private readonly store: ConfigStore,
    private readonly actor = "graph-poll",
  ) {}

  async get(key: string): Promise<string | null> {
    const row = await this.store.getConfig(`graph-delta:${key}`);
    if (!row) return null;
    try {
      return (JSON.parse(row.value) as { deltaLink?: string }).deltaLink ?? null;
    } catch {
      return null;
    }
  }

  async set(key: string, deltaLink: string): Promise<void> {
    await this.store.putConfig(`graph-delta:${key}`, JSON.stringify({ deltaLink }), this.actor);
  }
}
