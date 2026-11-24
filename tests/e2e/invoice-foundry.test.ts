/**
 * Invoice Foundry client — uses the INVOICE prompt (not the PO prompt) and returns the model JSON
 * with the invoice prompt version. Driven through a fake ChatCompleter (no live model).
 */
import { describe, expect, it } from "vitest";
import { AzureInvoiceFoundryClient, INVOICE_PROMPT_VERSION, buildInvoiceMessages } from "../../apps/workers/src/invoice/index.js";
import type { ChatCompleter } from "../../apps/workers/src/interpretation/index.js";
import type { BlobRef, DiLayoutResult } from "../../apps/workers/src/pipeline/ports.js";

const di: DiLayoutResult = { diModelVersion: "prebuilt-layout:test", pages: 1, fields: { InvoiceId: { text: "MP-88231", confidence: 0.9, page: 1, polygon: [] } }, lines: [], documentQualityFlags: [] };
const blob: BlobRef = { filename: "inv.pdf", blobUri: "blob://inv", contentHash: "h" };

describe("invoice Foundry client", () => {
  it("builds messages from the INVOICE prompt (vendor/invoice shape, PO-prefix rule)", () => {
    const msgs = buildInvoiceMessages(di);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toContain('"invoice_number"');
    expect(msgs[0]!.content).toContain("erp_vendor_account");
    expect(msgs[0]!.content).toMatch(/do NOT add or strip a "PO-" prefix/);
    expect(msgs[1]!.content).toContain("MP-88231");
  });

  it("returns the model JSON tagged with the invoice prompt version", async () => {
    let seenSystem = "";
    const fake: ChatCompleter = {
      async complete(input) {
        seenSystem = input.messages[0]!.content;
        return { content: '{"company":{"company_id":"USMF"}}' };
      },
    };
    const client = new AzureInvoiceFoundryClient({ completer: fake, deployment: "gpt-4o-inv" });
    const res = await client.interpret({ di, blob });
    expect(res.promptVersion).toBe(INVOICE_PROMPT_VERSION);
    expect(res.deployment).toBe("gpt-4o-inv");
    expect(res.rawJson).toContain("USMF");
    expect(seenSystem).toContain("vendor invoice"); // invoice prompt, not the PO prompt
  });
});
