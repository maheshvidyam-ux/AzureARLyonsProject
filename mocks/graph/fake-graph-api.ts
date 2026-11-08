/**
 * TEST-ENV-ONLY fake Microsoft Graph API client (spec §18 — quarantined mock). Implements the
 * low-level `GraphApiClient` with recorded delta pages, attachments, and subscription
 * responses. Exercises delta pagination, removed-item skipping, and messages without file
 * attachments. Attachment filenames line up with the DI/Foundry fixtures so a full
 * Graph → pipeline test can run with no live mailbox.
 */
import type {
  CreateSubscriptionInput,
  DeltaPage,
  GraphApiClient,
  GraphFileAttachment,
  GraphMessageResource,
  GraphSubscription,
} from "../../apps/workers/src/ingestion/graph/graph-api-client.js";

const MESSAGES: Record<string, GraphMessageResource> = {
  "msg-001": { id: "msg-001", subject: "PO 1", receivedDateTime: "2026-11-01T09:00:00Z", from: { emailAddress: { address: "buyer@acme.example.com" } }, hasAttachments: true },
  "msg-002": { id: "msg-002", subject: "PO 2", receivedDateTime: "2026-11-01T10:00:00Z", from: { emailAddress: { address: "buyer@acme.example.com" } }, hasAttachments: true },
};

const bytes = (stem: string) => Buffer.from(`%PDF-1.4 mock ${stem}`, "utf8").toString("base64");

function fileAttachment(stem: string): GraphFileAttachment {
  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    id: `att-${stem}`,
    name: `${stem}.pdf`,
    contentType: "application/pdf",
    size: 1234,
    contentBytes: bytes(stem),
  };
}

export class FakeGraphApiClient implements GraphApiClient {
  public created: CreateSubscriptionInput[] = [];
  public renewed: Array<{ subscriptionId: string; expirationDateTime: string }> = [];

  async getDeltaPage(opts: { link?: string; mailbox: string; folder: string }): Promise<DeltaPage> {
    // Fresh enumeration (no link): page 1 -> nextLink.
    if (!opts.link) {
      return {
        messages: [
          { id: "msg-001", subject: "PO 1", receivedDateTime: "2026-11-01T09:00:00Z", from: { emailAddress: { address: "buyer@acme.example.com" } }, hasAttachments: true },
          { id: "msg-no-att", subject: "FYI", receivedDateTime: "2026-11-01T09:05:00Z", from: { emailAddress: { address: "buyer@acme.example.com" } }, hasAttachments: false },
        ],
        nextLink: "https://graph.test/page2",
      };
    }
    // Page 2 -> deltaLink (end of sweep). Includes a removed item that must be skipped.
    if (opts.link === "https://graph.test/page2") {
      return {
        messages: [
          { id: "msg-002", subject: "PO 2", receivedDateTime: "2026-11-01T10:00:00Z", from: { emailAddress: { address: "buyer@acme.example.com" } }, hasAttachments: true },
          { id: "msg-removed", "@removed": { reason: "deleted" } },
        ],
        deltaLink: "https://graph.test/delta-1",
      };
    }
    // Incremental re-run from a stored delta link: nothing new.
    return { messages: [], deltaLink: "https://graph.test/delta-2" };
  }

  async getMessage(opts: { mailbox: string; messageId: string }): Promise<GraphMessageResource> {
    const m = MESSAGES[opts.messageId];
    if (!m) throw new Error(`Graph GET message ${opts.messageId} -> 404 Not Found`);
    return structuredClone(m);
  }

  async listFileAttachments(opts: { mailbox: string; messageId: string }): Promise<GraphFileAttachment[]> {
    if (opts.messageId === "msg-001") return [fileAttachment("sample-po-001")];
    if (opts.messageId === "msg-002") return [fileAttachment("sample-po-002")];
    return [];
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<GraphSubscription> {
    this.created.push(input);
    return { id: "sub-1", resource: input.resource, changeType: input.changeType, notificationUrl: input.notificationUrl, expirationDateTime: input.expirationDateTime, clientState: input.clientState };
  }

  async renewSubscription(input: { subscriptionId: string; expirationDateTime: string }): Promise<GraphSubscription> {
    this.renewed.push(input);
    return { id: input.subscriptionId, resource: "users/x/mailFolders/Inbox/messages", changeType: "created", notificationUrl: "https://x", expirationDateTime: input.expirationDateTime };
  }
}
