/**
 * Real Microsoft Graph client over HTTPS (spec §4, §3 least-privilege). Authenticates with an
 * Entra token from any `@azure/identity` credential (managed identity in Container Apps;
 * `az login` / service principal locally). No secrets in code. `fetchImpl` is injectable so
 * the client's own request-building can be unit-tested without network.
 */
import type {
  CreateSubscriptionInput,
  DeltaPage,
  GraphApiClient,
  GraphFileAttachment,
  GraphMessageResource,
  GraphSubscription,
} from "./graph-api-client.js";

/** Minimal shape of an @azure/identity TokenCredential (avoids a hard type import). */
export interface AzureTokenCredential {
  getToken(scopes: string | string[]): Promise<{ token: string; expiresOnTimestamp: number } | null>;
}

const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const DEFAULT_BASE_URL = "https://graph.microsoft.com/v1.0";
// Message delta fields we need; keep the projection tight (spec §3 data minimization).
const MESSAGE_SELECT = "id,subject,receivedDateTime,from,hasAttachments";

export interface HttpGraphApiClientOptions {
  credential: AzureTokenCredential;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class HttpGraphApiClient implements GraphApiClient {
  private readonly credential: AzureTokenCredential;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private cachedToken: { token: string; expiresOnTimestamp: number } | null = null;

  constructor(opts: HttpGraphApiClientOptions) {
    this.credential = opts.credential;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async authHeader(): Promise<string> {
    const now = Date.now();
    if (!this.cachedToken || this.cachedToken.expiresOnTimestamp - now < 60_000) {
      const token = await this.credential.getToken(GRAPH_SCOPE);
      if (!token) throw new Error("Failed to acquire a Microsoft Graph access token");
      this.cachedToken = token;
    }
    return `Bearer ${this.cachedToken.token}`;
  }

  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: await this.authHeader(),
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Graph ${method} ${url} -> ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
    }
    return (await res.json()) as T;
  }

  async getDeltaPage(opts: { link?: string; mailbox: string; folder: string }): Promise<DeltaPage> {
    const url =
      opts.link ??
      `${this.baseUrl}/users/${encodeURIComponent(opts.mailbox)}/mailFolders/${encodeURIComponent(opts.folder)}/messages/delta?$select=${MESSAGE_SELECT}`;
    const json = await this.request<{
      value: GraphMessageResource[];
      "@odata.nextLink"?: string;
      "@odata.deltaLink"?: string;
    }>("GET", url);
    return {
      messages: json.value ?? [],
      nextLink: json["@odata.nextLink"],
      deltaLink: json["@odata.deltaLink"],
    };
  }

  async getMessage(opts: { mailbox: string; messageId: string }): Promise<GraphMessageResource> {
    const url = `${this.baseUrl}/users/${encodeURIComponent(opts.mailbox)}/messages/${encodeURIComponent(opts.messageId)}?$select=${MESSAGE_SELECT}`;
    return this.request<GraphMessageResource>("GET", url);
  }

  async listFileAttachments(opts: { mailbox: string; messageId: string }): Promise<GraphFileAttachment[]> {
    const url = `${this.baseUrl}/users/${encodeURIComponent(opts.mailbox)}/messages/${encodeURIComponent(opts.messageId)}/attachments`;
    const json = await this.request<{ value: GraphFileAttachment[] }>("GET", url);
    return json.value ?? [];
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<GraphSubscription> {
    return this.request<GraphSubscription>("POST", `${this.baseUrl}/subscriptions`, input);
  }

  async renewSubscription(input: { subscriptionId: string; expirationDateTime: string }): Promise<GraphSubscription> {
    return this.request<GraphSubscription>("PATCH", `${this.baseUrl}/subscriptions/${encodeURIComponent(input.subscriptionId)}`, {
      expirationDateTime: input.expirationDateTime,
    });
  }
}
