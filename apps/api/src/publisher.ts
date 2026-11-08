/**
 * Resolves the ingestion publisher the webhook sends to: Azure Service Bus when
 * `SERVICEBUS_NAMESPACE` is configured (Entra auth), otherwise a no-op logging stub so the API
 * still runs locally without a namespace. The webhook code depends only on `IngestionPublisher`.
 */
import { createServiceBusIngestionQueue, type IngestionPublisher } from "@coa/messaging";

export function resolveIngestionPublisher(env: NodeJS.ProcessEnv = process.env): IngestionPublisher {
  if (env.SERVICEBUS_NAMESPACE) {
    return createServiceBusIngestionQueue();
  }
  return {
    async publish(message) {
      console.log(`[graph] (no Service Bus configured) would enqueue message id ${message.messageId}`);
    },
    async close() {
      /* no-op */
    },
  };
}
