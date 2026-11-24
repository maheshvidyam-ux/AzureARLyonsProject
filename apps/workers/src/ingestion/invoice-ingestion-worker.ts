/**
 * AP invoice ingestion worker — the invoice counterpart of IngestionWorker. Consumes Graph message
 * ids from the AP mailbox's ingestion queue, fetches each message's attachments, and runs every one
 * through the invoice pipeline (vendor match → vendor-first PO resolution → 3-way / C&A → persist →
 * stage). Per-message isolation + idempotency are identical to the AR worker.
 */
import type { IngestionMessage, IngestionQueue } from "@coa/messaging";
import { mapGraphMessage, type GraphApiClient } from "./graph/index.js";
import { processInvoice, type InvoicePipelineDeps, type InvoiceResult } from "../invoice/index.js";

export interface InvoiceIngestionWorkerDeps {
  client: GraphApiClient;
  mailbox: string;
  pipeline: InvoicePipelineDeps;
}

export interface InvoiceMessageOutcome {
  messageId: string;
  results: InvoiceResult[];
  error?: string;
}

export class InvoiceIngestionWorker {
  constructor(private readonly deps: InvoiceIngestionWorkerDeps) {}

  async handleMessageId(messageId: string, mailbox = this.deps.mailbox): Promise<InvoiceMessageOutcome> {
    try {
      const resource = await this.deps.client.getMessage({ mailbox, messageId });
      const mail = await mapGraphMessage(this.deps.client, mailbox, resource);
      const results: InvoiceResult[] = [];
      for (let i = 0; i < mail.attachments.length; i++) {
        results.push(await processInvoice(this.deps.pipeline, mail, i));
      }
      return { messageId, results };
    } catch (e) {
      return { messageId, results: [], error: (e as Error).message };
    }
  }

  async drain(queue: IngestionQueue, batchSize = 16): Promise<InvoiceMessageOutcome[]> {
    const outcomes: InvoiceMessageOutcome[] = [];
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
