/**
 * One scheduled poll of a mailbox (no-loss). Sweeps new message ids via the delta cursor, enqueues
 * each to the ingestion queue, and advances the cursor ONLY after every id is enqueued. If a publish
 * throws, the cursor is not committed, so the next poll re-fetches the same messages — nothing is
 * lost. Combined with idempotent processing (content-hash get-or-create) this is also no-duplicate.
 *
 * This is the primary ingestion mechanism for high volume: Graph change-notification webhooks are
 * best-effort (Microsoft can drop them), whereas a delta sweep from a durable cursor is complete and
 * resumable. A scheduled Container App Job invokes this every few minutes per mailbox.
 */
import type { GraphMailboxSource } from "./graph/index.js";

export interface PollRunnerDeps {
  source: GraphMailboxSource;
  /** Enqueue one message id to the mailbox's ingestion queue (throws → cursor not advanced). */
  publish: (messageId: string) => Promise<void>;
}

export interface PollOutcome {
  enqueued: number;
  /** true once the delta cursor advanced (only happens after all ids were enqueued). */
  committed: boolean;
}

export async function pollMailboxOnce(deps: PollRunnerDeps): Promise<PollOutcome> {
  const { messageIds, deltaLink } = await deps.source.fetchNewMessageIds();
  for (const id of messageIds) {
    await deps.publish(id); // throws → we never reach commitCursor → re-fetched next poll (no loss)
  }
  if (deltaLink) await deps.source.commitCursor(deltaLink);
  return { enqueued: messageIds.length, committed: Boolean(deltaLink) };
}
