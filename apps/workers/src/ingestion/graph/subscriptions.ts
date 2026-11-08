/**
 * Graph subscription lifecycle (spec §4): create and renew the change-notification
 * subscription before it expires. Pure time math (`now` is injected) for deterministic tests;
 * the actual create/renew calls go through the `GraphApiClient`.
 */
import type { CreateSubscriptionInput, GraphApiClient, GraphSubscription } from "./graph-api-client.js";

/**
 * Max subscription lifetime for Outlook message resources is ~4230 minutes (Graph limit). We
 * request slightly under the ceiling and renew well before expiry.
 */
export const GRAPH_MESSAGE_MAX_EXPIRATION_MINUTES = 4230;
export const DEFAULT_RENEWAL_THRESHOLD_MINUTES = 60;

export function nextExpiration(now: Date, minutes: number = GRAPH_MESSAGE_MAX_EXPIRATION_MINUTES): string {
  const capped = Math.min(minutes, GRAPH_MESSAGE_MAX_EXPIRATION_MINUTES);
  return new Date(now.getTime() + capped * 60_000).toISOString();
}

export function needsRenewal(
  expirationDateTime: string,
  now: Date,
  thresholdMinutes: number = DEFAULT_RENEWAL_THRESHOLD_MINUTES,
): boolean {
  const expiresAt = new Date(expirationDateTime).getTime();
  return expiresAt - now.getTime() <= thresholdMinutes * 60_000;
}

export interface EnsureSubscriptionInput {
  mailbox: string;
  folder?: string;
  notificationUrl: string;
  clientState: string;
  now: Date;
  changeType?: string;
  minutes?: number;
}

/** Create a fresh subscription for the mailbox folder's messages. */
export async function createMailboxSubscription(
  client: GraphApiClient,
  input: EnsureSubscriptionInput,
): Promise<GraphSubscription> {
  const folder = input.folder ?? "Inbox";
  const payload: CreateSubscriptionInput = {
    resource: `users/${input.mailbox}/mailFolders/${folder}/messages`,
    changeType: input.changeType ?? "created",
    notificationUrl: input.notificationUrl,
    expirationDateTime: nextExpiration(input.now, input.minutes),
    clientState: input.clientState,
  };
  return client.createSubscription(payload);
}

/** Renew a subscription if it is within the renewal threshold; otherwise return it unchanged. */
export async function renewIfNeeded(
  client: GraphApiClient,
  subscription: GraphSubscription,
  now: Date,
  thresholdMinutes: number = DEFAULT_RENEWAL_THRESHOLD_MINUTES,
  minutes?: number,
): Promise<{ subscription: GraphSubscription; renewed: boolean }> {
  if (!needsRenewal(subscription.expirationDateTime, now, thresholdMinutes)) {
    return { subscription, renewed: false };
  }
  const renewed = await client.renewSubscription({
    subscriptionId: subscription.id,
    expirationDateTime: nextExpiration(now, minutes),
  });
  return { subscription: renewed, renewed: true };
}
