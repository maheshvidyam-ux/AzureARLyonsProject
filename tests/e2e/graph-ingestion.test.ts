/**
 * Phase 2 — Microsoft Graph ingestion adapter (spec §4). Unit coverage for the mailbox
 * source (delta pagination, mapping, cursor persistence), the real HTTP client's request
 * building (fake fetch — no network), notification handling, and subscription lifecycle.
 */
import { describe, expect, it, vi } from "vitest";
import {
  GraphMailboxSource,
  HttpGraphApiClient,
  InMemoryDeltaStore,
  createMailboxSubscription,
  graphValidationResponse,
  needsRenewal,
  nextExpiration,
  parseNotifications,
  renewIfNeeded,
  GRAPH_MESSAGE_MAX_EXPIRATION_MINUTES,
  type AzureTokenCredential,
} from "../../apps/workers/src/ingestion/graph/index.js";
import { FakeGraphApiClient } from "../../mocks/graph/fake-graph-api.js";

const MAILBOX = "orders@lyons.example.com";

describe("GraphMailboxSource", () => {
  it("sweeps delta pages, skips removed + attachment-less messages, maps fields, stores cursor", async () => {
    const client = new FakeGraphApiClient();
    const deltaStore = new InMemoryDeltaStore();
    const source = new GraphMailboxSource({ client, mailbox: MAILBOX, deltaStore });

    const { messages, deltaLink } = await source.fetchNewMessages();

    // msg-001 + msg-002 map; msg-no-att (no attachments) and msg-removed (@removed) are skipped.
    expect(messages.map((m) => m.graphMessageId)).toEqual(["msg-001", "msg-002"]);
    const first = messages[0]!;
    expect(first.mailbox).toBe(MAILBOX);
    expect(first.sender).toBe("buyer@acme.example.com");
    expect(first.attachments).toHaveLength(1);
    expect(first.attachments[0]!.filename).toBe("sample-po-001.pdf");
    expect(first.attachments[0]!.contentBase64.length).toBeGreaterThan(0);

    expect(deltaLink).toBe("https://graph.test/delta-1");
    expect(await deltaStore.get(`${MAILBOX}::Inbox`)).toBe("https://graph.test/delta-1");
  });

  it("second sweep resumes from the stored delta link and returns nothing new", async () => {
    const client = new FakeGraphApiClient();
    const deltaStore = new InMemoryDeltaStore();
    const source = new GraphMailboxSource({ client, mailbox: MAILBOX, deltaStore });

    await source.fetchNewMessages();
    const second = await source.fetchNewMessages();

    expect(second.messages).toHaveLength(0);
    expect(second.deltaLink).toBe("https://graph.test/delta-2");
  });
});

describe("HttpGraphApiClient (fake fetch, no network)", () => {
  const credential: AzureTokenCredential = {
    getToken: vi.fn(async () => ({ token: "tok", expiresOnTimestamp: Date.now() + 3_600_000 })),
  };

  it("builds the delta request, sends a bearer token, parses the page, and caches the token", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      urls.push(String(input));
      expect((init!.headers as Record<string, string>).authorization).toBe("Bearer tok");
      return new Response(JSON.stringify({ value: [{ id: "m1", hasAttachments: true }], "@odata.deltaLink": "d1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new HttpGraphApiClient({ credential, fetchImpl });

    const page = await client.getDeltaPage({ mailbox: MAILBOX, folder: "Inbox" });
    await client.getDeltaPage({ link: "https://graph.test/next", mailbox: MAILBOX, folder: "Inbox" });

    expect(page.messages).toHaveLength(1);
    expect(page.deltaLink).toBe("d1");
    expect(urls[0]).toContain(`/users/${encodeURIComponent(MAILBOX)}/mailFolders/Inbox/messages/delta`);
    expect(urls[1]).toBe("https://graph.test/next"); // absolute link used verbatim
    expect(credential.getToken).toHaveBeenCalledTimes(1); // token cached across calls
  });

  it("throws a descriptive error on a non-2xx Graph response", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("forbidden", { status: 403, statusText: "Forbidden" });
    const client = new HttpGraphApiClient({ credential, fetchImpl });
    await expect(client.listFileAttachments({ mailbox: MAILBOX, messageId: "x" })).rejects.toThrow(/403/);
  });
});

describe("notifications", () => {
  it("echoes the validation token as text/plain", () => {
    expect(graphValidationResponse("abc123")).toEqual({ status: 200, contentType: "text/plain", body: "abc123" });
  });

  it("accepts clientState-verified notifications and rejects bad ones", () => {
    const payload = {
      value: [
        { clientState: "secret", resourceData: { id: "good-1" } },
        { clientState: "WRONG", resourceData: { id: "evil" } },
        { clientState: "secret", resource: "Users/u1/Messages/good-2" },
        { lifecycleEvent: "reauthorizationRequired", subscriptionId: "sub-1" },
      ],
    };
    const parsed = parseNotifications(payload, "secret");
    expect(parsed.messageIds).toEqual(["good-1", "good-2"]);
    expect(parsed.rejected).toBe(1);
    expect(parsed.lifecycleEvents).toEqual([{ subscriptionId: "sub-1", event: "reauthorizationRequired" }]);
  });

  it("returns an empty result for a malformed payload", () => {
    expect(parseNotifications(null, "secret")).toEqual({ messageIds: [], lifecycleEvents: [], rejected: 0 });
  });
});

describe("subscriptions", () => {
  const now = new Date("2026-11-08T00:00:00Z");

  it("caps expiration at the Graph maximum", () => {
    const exp = nextExpiration(now, 99_999);
    const minutes = (new Date(exp).getTime() - now.getTime()) / 60_000;
    expect(minutes).toBe(GRAPH_MESSAGE_MAX_EXPIRATION_MINUTES);
  });

  it("flags renewal only inside the threshold window", () => {
    const soon = new Date(now.getTime() + 30 * 60_000).toISOString();
    const later = new Date(now.getTime() + 600 * 60_000).toISOString();
    expect(needsRenewal(soon, now, 60)).toBe(true);
    expect(needsRenewal(later, now, 60)).toBe(false);
  });

  it("creates a subscription with the right resource, clientState, and expiration", async () => {
    const client = new FakeGraphApiClient();
    const sub = await createMailboxSubscription(client, {
      mailbox: MAILBOX,
      notificationUrl: "https://api.example.com/integration/graph/notifications",
      clientState: "secret",
      now,
    });
    expect(sub.resource).toBe(`users/${MAILBOX}/mailFolders/Inbox/messages`);
    expect(client.created[0]!.clientState).toBe("secret");
    expect(client.created[0]!.changeType).toBe("created");
  });

  it("renews only when near expiry", async () => {
    const client = new FakeGraphApiClient();
    const near = { id: "sub-1", resource: "r", changeType: "created", notificationUrl: "u", expirationDateTime: new Date(now.getTime() + 10 * 60_000).toISOString() };
    const far = { ...near, expirationDateTime: new Date(now.getTime() + 1000 * 60_000).toISOString() };

    expect((await renewIfNeeded(client, near, now)).renewed).toBe(true);
    expect((await renewIfNeeded(client, far, now)).renewed).toBe(false);
    expect(client.renewed).toHaveLength(1);
  });
});
