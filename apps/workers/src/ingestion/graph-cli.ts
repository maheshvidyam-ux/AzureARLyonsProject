/**
 * Graph mailbox CLI for first real tests (spec §4) — no deployment needed for `poll`.
 *
 *   MAILBOX=orders@lyonsmagnus.com tsx apps/workers/src/ingestion/graph-cli.ts poll
 *   MAILBOX=... GRAPH_NOTIFICATION_URL=https://<api>/integration/graph/notifications \
 *     GRAPH_CLIENT_STATE=<secret> tsx apps/workers/src/ingestion/graph-cli.ts subscribe
 *
 * Auth is Entra (DefaultAzureCredential): locally use a service principal that holds the
 * Graph `Mail.Read` application permission (AZURE_CLIENT_ID/TENANT_ID/CLIENT_SECRET), scoped to
 * the order mailbox via an Exchange application-access policy (Q-GRAPH-1).
 */
import { createDefaultGraphApiClient, createMailboxSubscription, GraphMailboxSource } from "./graph/index.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "poll";
  const mailbox = requireEnv("MAILBOX");
  const client = createDefaultGraphApiClient();

  if (cmd === "poll") {
    const source = new GraphMailboxSource({ client, mailbox });
    const { messages, deltaLink } = await source.fetchNewMessages();
    console.log(`Fetched ${messages.length} new message(s) from ${mailbox}:`);
    for (const m of messages) {
      console.log(`  • ${m.graphMessageId}  "${m.subject}"  from ${m.sender}  — ${m.attachments.length} attachment(s): ${m.attachments.map((a) => a.filename).join(", ")}`);
    }
    console.log(`Delta cursor: ${deltaLink ? "advanced" : "none"}`);
  } else if (cmd === "subscribe") {
    const sub = await createMailboxSubscription(client, {
      mailbox,
      notificationUrl: requireEnv("GRAPH_NOTIFICATION_URL"),
      clientState: requireEnv("GRAPH_CLIENT_STATE"),
      now: new Date(),
    });
    console.log(`Subscription ${sub.id} created; expires ${sub.expirationDateTime}`);
  } else {
    console.error(`Unknown command '${cmd}'. Use: poll | subscribe`);
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
