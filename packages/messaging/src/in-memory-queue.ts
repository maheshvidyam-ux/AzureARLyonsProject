import type { IngestionMessage, IngestionPublisher, IngestionQueue } from "./ports.js";

/** In-memory FIFO queue (tests / local demo). Service Bus implements the same ports in prod. */
export class InMemoryIngestionQueue implements IngestionQueue, IngestionPublisher {
  private readonly messages: IngestionMessage[] = [];

  async publish(message: IngestionMessage): Promise<void> {
    this.messages.push(message);
  }

  async receive(maxMessages?: number): Promise<IngestionMessage[]> {
    const count = maxMessages == null ? this.messages.length : Math.min(maxMessages, this.messages.length);
    return this.messages.splice(0, count);
  }

  get depth(): number {
    return this.messages.length;
  }

  async close(): Promise<void> {
    /* no-op */
  }
}
