/**
 * Graph mailbox CLI for first real tests (spec §4) — no deployment needed for `poll`.
 *
 *   MAILBOX=orders@lyonsmagnus.com tsx apps/workers/src/ingestion/graph-cli.ts poll
 *   # AR order mailbox → notifications route to the `ingestion` queue:
 *   MAILBOX=... GRAPH_NOTIFICATION_URL=https://<api>/integration/graph/notifications \
 *     GRAPH_CLIENT_STATE=<ar-secret> tsx apps/workers/src/ingestion/graph-cli.ts subscribe
 *   # AP invoice mailbox → the API webhook routes its notifications to `ingestion-ap` by clientState:
 *   AP_MAILBOX=invoices@lyonsmagnus.com GRAPH_NOTIFICATION_URL=... \
 *     GRAPH_CLIENT_STATE_AP=<ap-secret> tsx apps/workers/src/ingestion/graph-cli.ts subscribe ap
 *
 * The AR and AP subscriptions MUST use DIFFERENT clientState secrets — the webhook routes each
 * mailbox's notifications to its own queue by which secret matched. Auth is Entra
 * (DefaultAzureCredential): a service principal with the Graph `Mail.Read` application permission,
 * scoped to the mailbox via an Exchange application-access policy (Q-GRAPH-1).
 */
import { createDefaultGraphApiClient, createMailboxSubscription, GraphMailboxSource } from "./graph/index.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "poll";
  const client = createDefaultGraphApiClient();

  if (cmd === "poll") {
    const mailbox = requireEnv("MAILBOX");
    const source = new GraphMailboxSource({ client, mailbox });
    const { messages, deltaLink } = await source.fetchNewMessages();
    console.log(`Fetched ${messages.length} new message(s) from ${mailbox}:`);
    for (const m of messages) {
      console.log(`  • ${m.graphMessageId}  "${m.subject}"  from ${m.sender}  — ${m.attachments.length} attachment(s): ${m.attachments.map((a) => a.filename).join(", ")}`);
    }
    console.log(`Delta cursor: ${deltaLink ? "advanced" : "none"}`);
  } else if (cmd === "subscribe") {
    const ap = process.argv[3] === "ap";
    const mailbox = ap ? requireEnv("AP_MAILBOX") : requireEnv("MAILBOX");
    const clientState = ap ? requireEnv("GRAPH_CLIENT_STATE_AP") : requireEnv("GRAPH_CLIENT_STATE");
    const sub = await createMailboxSubscription(client, {
      mailbox,
      notificationUrl: requireEnv("GRAPH_NOTIFICATION_URL"),
      clientState,
      now: new Date(),
    });
    console.log(`[${ap ? "AP" : "AR"}] Subscription ${sub.id} created for ${mailbox}; expires ${sub.expirationDateTime}`);
  } else {
    console.error(`Unknown command '${cmd}'. Use: poll | subscribe [ap]`);
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
