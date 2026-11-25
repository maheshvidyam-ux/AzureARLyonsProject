/**
 * Microsoft Graph change-notification handling (spec §4), as pure functions so the webhook
 * route (a later apps/api slice) stays a thin shell. Covers the subscription validation
 * handshake and clientState-verified parsing of change notifications into message ids.
 *
 * Security (spec §3): a notification whose `clientState` does not match the secret we set on
 * the subscription is rejected — never trusted to trigger a fetch.
 */

export interface ValidationResponse {
  status: number;
  contentType: string;
  body: string;
}

/**
 * Graph validates a new subscription by calling the notificationUrl with `?validationToken=...`
 * and expects the token echoed back as text/plain within 10 seconds.
 */
export function graphValidationResponse(validationToken: string): ValidationResponse {
  return { status: 200, contentType: "text/plain", body: validationToken };
}

export interface ChangeNotification {
  subscriptionId?: string;
  clientState?: string;
  changeType?: string;
  resource?: string;
  resourceData?: { id?: string } | null;
  lifecycleEvent?: string;
}

export interface ParsedNotifications {
  /** all clientState-verified message ids (flat, across routes) */
  messageIds: string[];
  /** message ids grouped by route key — the value the matched clientState maps to (AR/AP). */
  messageIdsByRoute: Record<string, string[]>;
  /** lifecycle events (e.g. reauthorizationRequired, subscriptionRemoved) needing action */
  lifecycleEvents: Array<{ subscriptionId?: string; event: string }>;
  /** count of notifications rejected for a bad/missing clientState */
  rejected: number;
}

/**
 * Parse a Graph notification payload, verifying each `clientState` against the expected secret(s).
 * `expected` is either a single secret (all accepted ids go to route "default") or a map of
 * clientState → route key (e.g. the AR secret → "AR", the AP secret → "AP"), so one webhook routes
 * each mailbox's notifications to its own ingestion queue. Malformed payloads yield an empty result
 * rather than throwing (the webhook must still 202 quickly).
 */
export function parseNotifications(payload: unknown, expected: string | Record<string, string>): ParsedNotifications {
  const routes: Record<string, string> = typeof expected === "string" ? { [expected]: "default" } : expected;
  const out: ParsedNotifications = { messageIds: [], messageIdsByRoute: {}, lifecycleEvents: [], rejected: 0 };
  const value = (payload as { value?: unknown })?.value;
  if (!Array.isArray(value)) return out;

  for (const raw of value as ChangeNotification[]) {
    if (raw.lifecycleEvent) {
      // Lifecycle events are not clientState-verified the same way; surface for the handler.
      out.lifecycleEvents.push({ subscriptionId: raw.subscriptionId, event: raw.lifecycleEvent });
      continue;
    }
    const route = raw.clientState ? routes[raw.clientState] : undefined;
    if (route === undefined) {
      out.rejected += 1;
      continue;
    }
    const id = raw.resourceData?.id ?? messageIdFromResource(raw.resource);
    if (id) {
      out.messageIds.push(id);
      (out.messageIdsByRoute[route] ??= []).push(id);
    }
  }
  return out;
}

/** Fallback: pull a message id out of a resource path like "Users/{uid}/Messages/{mid}". */
function messageIdFromResource(resource?: string): string | undefined {
  if (!resource) return undefined;
  const m = /Messages\/([^/]+)/i.exec(resource);
  return m?.[1];
}
