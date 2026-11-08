/**
 * TEST-ENV-ONLY fake Microsoft Graph mailbox (spec §18 — quarantined mock). Emits
 * deterministic mail messages built from the sample fixtures. No live Graph call is made.
 * The real Graph webhook/delta receiver lives in apps/api and is a later slice.
 */
import type { GraphMailMessage, GraphSource } from "../../apps/workers/src/pipeline/ports.js";

export const SAMPLE_STEMS = ["sample-po-001", "sample-po-002", "sample-po-003"] as const;
export type SampleStem = (typeof SAMPLE_STEMS)[number];

function messageFor(stem: SampleStem, seq: number): GraphMailMessage {
  const bytes = Buffer.from(`%PDF-1.4 mock purchase order ${stem}`, "utf8");
  return {
    graphMessageId: `graph-msg-${stem}`,
    mailbox: "orders@lyons.example.com",
    sender: "buyer@acme.example.com",
    // Fixed timestamps keep the pipeline deterministic (no Date.now() in fixtures).
    receivedAt: `2026-11-0${seq}T09:00:00Z`,
    subject: `Purchase Order ${stem}`,
    attachments: [
      {
        graphAttachmentId: `graph-att-${stem}`,
        filename: `${stem}.pdf`,
        contentType: "application/pdf",
        contentBase64: bytes.toString("base64"),
      },
    ],
  };
}

export class FakeGraphSource implements GraphSource {
  private readonly messages: GraphMailMessage[];

  constructor(stems: readonly SampleStem[] = SAMPLE_STEMS) {
    this.messages = stems.map((stem, i) => messageFor(stem, i + 1));
  }

  async fetchMessages(): Promise<GraphMailMessage[]> {
    // Return copies so callers can't mutate the fixture state.
    return this.messages.map((m) => structuredClone(m));
  }
}
