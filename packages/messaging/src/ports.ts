/**
 * Messaging port (spec §2 — durable work queues). The webhook publishes message ids onto the
 * `ingestion` queue; the ingestion worker consumes them. Pull-based `receive` maps onto Azure
 * Service Bus `receiveMessages(maxCount)`; an in-memory FIFO backs tests and the local demo.
 */
export interface IngestionMessage {
  /** Graph message id to fetch + process. */
  messageId: string;
  /** Mailbox the id belongs to (defaults to the worker's configured mailbox when omitted). */
  mailbox?: string;
}

/** Pull-based queue (in-memory impl; backs `worker.drain()` for tests + local demo). */
export interface IngestionQueue {
  publish(message: IngestionMessage): Promise<void>;
  /** Pull up to `maxMessages` (default: all currently queued). Empty array when drained. */
  receive(maxMessages?: number): Promise<IngestionMessage[]>;
}

/** Publish side — used by the webhook. Implemented by both the in-memory queue and Service Bus. */
export interface IngestionPublisher {
  publish(message: IngestionMessage): Promise<void>;
  close(): Promise<void>;
}

export type IngestionHandler = (message: IngestionMessage) => Promise<void>;

export interface IngestionSubscription {
  close(): Promise<void>;
}

/**
 * Push-based consumer (Service Bus). A handler that RESOLVES settles (completes) the message; a
 * handler that THROWS causes the message to be abandoned and — after the queue's
 * maxDeliveryCount — dead-lettered. This is the retry/DLQ contract (spec §2, §6.3).
 */
export interface IngestionProcessor {
  subscribe(handler: IngestionHandler): IngestionSubscription;
  close(): Promise<void>;
}
