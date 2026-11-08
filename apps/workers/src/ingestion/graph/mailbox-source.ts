/**
 * `GraphMailboxSource` implements the existing `GraphSource` port (apps/workers/.../ports.ts)
 * on top of the low-level `GraphApiClient`, so it drops straight into the pipeline in place of
 * the fake mailbox. It performs a delta sweep (following pagination), persists the delta link
 * for incremental reconciliation (spec §4), and maps Graph messages + file attachments onto
 * our `GraphMailMessage`.
 */
import type { GraphMailMessage } from "../../pipeline/ports.js";
import type { GraphApiClient, GraphMessageResource } from "./graph-api-client.js";
import { mapGraphMessage } from "./mapping.js";

/** Persisted delta cursor per mailbox+folder (in-memory here; DB-backed in a later slice). */
export interface DeltaStore {
  get(key: string): Promise<string | null>;
  set(key: string, deltaLink: string): Promise<void>;
}

export class InMemoryDeltaStore implements DeltaStore {
  private readonly links = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.links.get(key) ?? null;
  }
  async set(key: string, deltaLink: string): Promise<void> {
    this.links.set(key, deltaLink);
  }
}

export interface GraphMailboxSourceOptions {
  client: GraphApiClient;
  mailbox: string;
  folder?: string;
  deltaStore?: DeltaStore;
  /** safety bound on pages per sweep to avoid runaway loops */
  maxPages?: number;
}

export class GraphMailboxSource {
  private readonly client: GraphApiClient;
  private readonly mailbox: string;
  private readonly folder: string;
  private readonly deltaStore: DeltaStore;
  private readonly maxPages: number;

  constructor(opts: GraphMailboxSourceOptions) {
    this.client = opts.client;
    this.mailbox = opts.mailbox;
    this.folder = opts.folder ?? "Inbox";
    this.deltaStore = opts.deltaStore ?? new InMemoryDeltaStore();
    this.maxPages = opts.maxPages ?? 50;
  }

  private get cursorKey(): string {
    return `${this.mailbox}::${this.folder}`;
  }

  /** `GraphSource` port method: incremental sweep returning newly-arrived PO emails. */
  async fetchMessages(): Promise<GraphMailMessage[]> {
    const { messages } = await this.fetchNewMessages();
    return messages;
  }

  /**
   * Delta sweep from the stored cursor (or a full enumeration on first run). Returns the mapped
   * messages and the new delta link (also persisted). Removed/deleted items are skipped.
   */
  async fetchNewMessages(): Promise<{ messages: GraphMailMessage[]; deltaLink: string | null }> {
    const resources: GraphMessageResource[] = [];
    let link: string | undefined = (await this.deltaStore.get(this.cursorKey)) ?? undefined;
    let deltaLink: string | null = null;

    for (let page = 0; page < this.maxPages; page++) {
      const result = await this.client.getDeltaPage({ link, mailbox: this.mailbox, folder: this.folder });
      for (const m of result.messages) {
        if (m["@removed"]) continue; // deletion/move — not a new PO
        resources.push(m);
      }
      if (result.nextLink) {
        link = result.nextLink;
        continue;
      }
      deltaLink = result.deltaLink ?? null;
      break;
    }

    if (deltaLink) await this.deltaStore.set(this.cursorKey, deltaLink);

    const messages: GraphMailMessage[] = [];
    for (const m of resources) {
      if (!m.hasAttachments) continue; // POs arrive as attachments in this slice
      const mapped = await mapGraphMessage(this.client, this.mailbox, m);
      if (mapped.attachments.length > 0) messages.push(mapped);
    }

    return { messages, deltaLink };
  }
}
