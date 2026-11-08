/**
 * Azure Service Bus implementation of the ingestion queue (spec §2, §6.3). Implements both
 * `IngestionPublisher` (the webhook's send side) and `IngestionProcessor` (the worker's
 * consume side) over one `ServiceBusClient`. Entra auth (no SAS keys): the client is built
 * with a credential by the factory below.
 *
 * Settlement uses peek-lock with `autoCompleteMessages`: the handler resolving completes the
 * message; the handler throwing abandons it, and after the queue's maxDeliveryCount it is
 * dead-lettered — the retry/DLQ contract the `IngestionProcessor` port promises.
 */
import { DefaultAzureCredential } from "@azure/identity";
import { ServiceBusClient, type ServiceBusReceiver, type ServiceBusSender } from "@azure/service-bus";
import type {
  IngestionHandler,
  IngestionMessage,
  IngestionProcessor,
  IngestionPublisher,
  IngestionSubscription,
} from "./ports.js";

export interface ServiceBusIngestionOptions {
  client: ServiceBusClient;
  queueName: string;
  /** Concurrent handler invocations for the consumer (default 1). */
  maxConcurrentCalls?: number;
}

export class ServiceBusIngestionQueue implements IngestionPublisher, IngestionProcessor {
  private sender?: ServiceBusSender;
  private receiver?: ServiceBusReceiver;

  constructor(private readonly opts: ServiceBusIngestionOptions) {}

  private getSender(): ServiceBusSender {
    return (this.sender ??= this.opts.client.createSender(this.opts.queueName));
  }

  async publish(message: IngestionMessage): Promise<void> {
    await this.getSender().sendMessages({ body: message, contentType: "application/json" });
  }

  subscribe(handler: IngestionHandler): IngestionSubscription {
    const receiver = (this.receiver ??= this.opts.client.createReceiver(this.opts.queueName)); // peekLock
    const closable = receiver.subscribe(
      {
        processMessage: async (received) => {
          // Throwing here => Service Bus abandons (retry) and eventually dead-letters.
          await handler(received.body as IngestionMessage);
        },
        processError: async (args) => {
          console.error(`[servicebus] processError on ${args.entityPath}: ${args.error?.message ?? args.error}`);
        },
      },
      { maxConcurrentCalls: this.opts.maxConcurrentCalls ?? 1, autoCompleteMessages: true },
    );
    return { close: () => closable.close() };
  }

  async close(): Promise<void> {
    await this.sender?.close();
    await this.receiver?.close();
    await this.opts.client.close();
  }
}

export interface ServiceBusEnv {
  /** e.g. `my-namespace.servicebus.windows.net` */
  fullyQualifiedNamespace: string;
  queueName: string;
}

export function serviceBusEnvFrom(env: NodeJS.ProcessEnv = process.env): ServiceBusEnv {
  const ns = env.SERVICEBUS_NAMESPACE;
  if (!ns) throw new Error("Missing required environment variable SERVICEBUS_NAMESPACE");
  return { fullyQualifiedNamespace: ns, queueName: env.INGESTION_QUEUE_NAME ?? "ingestion" };
}

/** Build a Service Bus ingestion queue with Entra auth (managed identity / az login / SP). */
export function createServiceBusIngestionQueue(env?: ServiceBusEnv): ServiceBusIngestionQueue {
  const resolved = env ?? serviceBusEnvFrom();
  const client = new ServiceBusClient(resolved.fullyQualifiedNamespace, new DefaultAzureCredential());
  return new ServiceBusIngestionQueue({ client, queueName: resolved.queueName });
}
