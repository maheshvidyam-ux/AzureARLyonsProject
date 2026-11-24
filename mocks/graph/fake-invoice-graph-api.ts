/**
 * TEST-ENV-ONLY fake Graph client for the AP mailbox. Returns messages whose attachment filenames
 * line up with the invoice DI/Foundry fixtures, so the AP ingestion worker can be exercised with no
 * live mailbox. Mirrors FakeGraphApiClient but for invoice documents.
 */
import type {
  CreateSubscriptionInput,
  DeltaPage,
  GraphApiClient,
  GraphFileAttachment,
  GraphMessageResource,
  GraphSubscription,
} from "../../apps/workers/src/ingestion/graph/graph-api-client.js";

const MESSAGES: Record<string, { resource: GraphMessageResource; stem: string }> = {
  "inv-001": { resource: { id: "inv-001", subject: "Invoice MP-88231", receivedDateTime: "2026-11-02T09:00:00Z", from: { emailAddress: { address: "ap@acme.example.com" } }, hasAttachments: true }, stem: "sample-inv-po-001" },
  "inv-002": { resource: { id: "inv-002", subject: "Invoice (no PO)", receivedDateTime: "2026-11-02T10:00:00Z", from: { emailAddress: { address: "ap@globex.example.com" } }, hasAttachments: true }, stem: "sample-inv-nonpo-001" },
};

const bytes = (stem: string) => Buffer.from(`%PDF-1.4 mock ${stem}`, "utf8").toString("base64");
const fileAttachment = (stem: string): GraphFileAttachment => ({
  "@odata.type": "#microsoft.graph.fileAttachment",
  id: `att-${stem}`,
  name: `${stem}.pdf`,
  contentType: "application/pdf",
  size: 1234,
  contentBytes: bytes(stem),
});

export class FakeInvoiceGraphApiClient implements GraphApiClient {
  async getDeltaPage(): Promise<DeltaPage> {
    return { messages: Object.values(MESSAGES).map((m) => m.resource), deltaLink: "https://graph.test/ap-delta-1" };
  }
  async getMessage(opts: { mailbox: string; messageId: string }): Promise<GraphMessageResource> {
    const m = MESSAGES[opts.messageId];
    if (!m) throw new Error(`Graph GET message ${opts.messageId} -> 404 Not Found`);
    return structuredClone(m.resource);
  }
  async listFileAttachments(opts: { mailbox: string; messageId: string }): Promise<GraphFileAttachment[]> {
    const m = MESSAGES[opts.messageId];
    return m ? [fileAttachment(m.stem)] : [];
  }
  async createSubscription(input: CreateSubscriptionInput): Promise<GraphSubscription> {
    return { id: "sub-ap-1", resource: input.resource, changeType: input.changeType, notificationUrl: input.notificationUrl, expirationDateTime: input.expirationDateTime, clientState: input.clientState };
  }
  async renewSubscription(input: { subscriptionId: string; expirationDateTime: string }): Promise<GraphSubscription> {
    return { id: input.subscriptionId, resource: "users/ap/mailFolders/Inbox/messages", changeType: "created", notificationUrl: "https://x", expirationDateTime: input.expirationDateTime };
  }
}
