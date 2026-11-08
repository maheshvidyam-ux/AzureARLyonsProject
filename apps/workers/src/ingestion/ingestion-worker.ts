/**
 * Ingestion worker (spec §4). Closes the webhook → worker loop: it consumes Graph message ids
 * from the `ingestion` queue, fetches each message's metadata + file attachments via the Graph
 * client, and runs every attachment through the pipeline (which persists to the operational
 * store and stops before staging).
 *
 * Fetch/processing of one message is isolated: a failure (e.g. Graph 404/timeout) is captured
 * on that message's outcome and does NOT abort the batch. Processing is idempotent — the
 * persistence layer makes a replayed message create no duplicate order.
 */
import type { IngestionMessage, IngestionQueue } from "@coa/messaging";
import { mapGraphMessage, type GraphApiClient } from "./graph/index.js";
import { processAttachment, type PipelineDeps, type SliceResult } from "../pipeline/pipeline.js";

export interface IngestionWorkerDeps {
  client: GraphApiClient;
  mailbox: string;
  pipeline: PipelineDeps;
}

export interface MessageOutcome {
  messageId: string;
  results: SliceResult[];
  /** set when the message could not be fetched/processed (kept for retry/dead-letter decisions) */
  error?: string;
}

export class IngestionWorker {
  constructor(private readonly deps: IngestionWorkerDeps) {}

  /** Fetch one message and run each of its attachments through the pipeline. */
  async handleMessageId(messageId: string, mailbox = this.deps.mailbox): Promise<MessageOutcome> {
    try {
      const resource = await this.deps.client.getMessage({ mailbox, messageId });
      const mail = await mapGraphMessage(this.deps.client, mailbox, resource);

      const results: SliceResult[] = [];
      for (let i = 0; i < mail.attachments.length; i++) {
        results.push(await processAttachment(this.deps.pipeline, mail, i));
      }
      return { messageId, results };
    } catch (e) {
      return { messageId, results: [], error: (e as Error).message };
    }
  }

  /** Drain the queue, processing each message. Returns one outcome per message handled. */
  async drain(queue: IngestionQueue, batchSize = 16): Promise<MessageOutcome[]> {
    const outcomes: MessageOutcome[] = [];
    for (;;) {
      const batch: IngestionMessage[] = await queue.receive(batchSize);
      if (batch.length === 0) break;
      for (const m of batch) {
        outcomes.push(await this.handleMessageId(m.messageId, m.mailbox ?? this.deps.mailbox));
      }
    }
    return outcomes;
  }
}
