/**
 * Maps a Graph message resource (+ its file attachments) onto our `GraphMailMessage` port
 * type. Shared by the delta-based mailbox source and the webhook-driven ingestion worker so
 * both produce identical inputs to the pipeline.
 */
import type { GraphMailMessage } from "../../pipeline/ports.js";
import { FILE_ATTACHMENT_ODATA_TYPE, type GraphApiClient, type GraphMessageResource } from "./graph-api-client.js";

export async function mapGraphMessage(
  client: GraphApiClient,
  mailbox: string,
  m: GraphMessageResource,
): Promise<GraphMailMessage> {
  const files = await client.listFileAttachments({ mailbox, messageId: m.id });
  const attachments = files
    .filter((a) => a["@odata.type"] === FILE_ATTACHMENT_ODATA_TYPE && a.contentBytes)
    .map((a) => ({
      graphAttachmentId: a.id,
      filename: a.name,
      contentType: a.contentType ?? "application/octet-stream",
      contentBase64: a.contentBytes!,
    }));

  return {
    graphMessageId: m.id,
    mailbox,
    sender: m.from?.emailAddress?.address ?? "unknown",
    receivedAt: m.receivedDateTime ?? "",
    subject: m.subject ?? "",
    attachments,
  };
}
