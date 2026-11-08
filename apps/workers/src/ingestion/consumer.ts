/**
 * Bridges the `IngestionProcessor` (Service Bus) to the `IngestionWorker`. The worker's
 * `handleMessageId` swallows errors into `MessageOutcome.error`; here we RE-THROW on error so
 * the queue abandons/dead-letters the message (retry/DLQ contract). A clean outcome resolves,
 * which auto-completes the Service Bus message.
 */
import type { IngestionProcessor, IngestionSubscription } from "@coa/messaging";
import type { IngestionWorker } from "./ingestion-worker.js";

export function runIngestionConsumer(processor: IngestionProcessor, worker: IngestionWorker): IngestionSubscription {
  return processor.subscribe(async (message) => {
    const outcome = await worker.handleMessageId(message.messageId, message.mailbox);
    if (outcome.error) {
      throw new Error(`ingestion failed for message ${message.messageId}: ${outcome.error}`);
    }
  });
}
