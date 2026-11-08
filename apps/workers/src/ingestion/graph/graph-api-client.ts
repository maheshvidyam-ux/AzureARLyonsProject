/**
 * Low-level Microsoft Graph client port (spec §4). This is the seam we fake in tests: the
 * mailbox source, notification handling, and subscription logic are all written against this
 * interface, so none of them need a live mailbox to test. The real implementation
 * (`HttpGraphApiClient`) talks to Graph over HTTPS with an Entra token.
 */

// --- Graph resource shapes (subset we consume) ---
export interface GraphMessageResource {
  id: string;
  subject?: string | null;
  receivedDateTime?: string | null;
  from?: { emailAddress?: { address?: string | null } } | null;
  hasAttachments?: boolean;
  /** present on delta responses for removed items */
  "@removed"?: { reason: string };
}

export interface GraphFileAttachment {
  "@odata.type": string; // "#microsoft.graph.fileAttachment"
  id: string;
  name: string;
  contentType?: string | null;
  size?: number;
  /** base64 of the file bytes (file attachments only) */
  contentBytes?: string;
}

export interface DeltaPage {
  messages: GraphMessageResource[];
  /** absolute URL for the next page; present while paging */
  nextLink?: string;
  /** absolute URL carrying the delta token; present on the final page */
  deltaLink?: string;
}

export interface GraphSubscription {
  id: string;
  resource: string;
  changeType: string;
  notificationUrl: string;
  expirationDateTime: string;
  clientState?: string;
}

export interface CreateSubscriptionInput {
  resource: string; // e.g. users/{mailbox}/mailFolders/{folder}/messages
  changeType: string; // e.g. "created"
  notificationUrl: string;
  expirationDateTime: string;
  clientState: string;
}

export interface GraphApiClient {
  /**
   * Fetch one delta page. Pass `link` (an absolute nextLink or deltaLink from a previous
   * call) to continue; omit it to start a fresh delta enumeration of the folder.
   */
  getDeltaPage(opts: { link?: string; mailbox: string; folder: string }): Promise<DeltaPage>;
  /** Fetch a single message's metadata by id (used when a webhook gives us only the id). */
  getMessage(opts: { mailbox: string; messageId: string }): Promise<GraphMessageResource>;
  listFileAttachments(opts: { mailbox: string; messageId: string }): Promise<GraphFileAttachment[]>;
  createSubscription(input: CreateSubscriptionInput): Promise<GraphSubscription>;
  renewSubscription(input: { subscriptionId: string; expirationDateTime: string }): Promise<GraphSubscription>;
}

export const FILE_ATTACHMENT_ODATA_TYPE = "#microsoft.graph.fileAttachment";
