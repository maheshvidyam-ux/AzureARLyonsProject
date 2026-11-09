/**
 * Phase 2 — real Azure Document Intelligence client (spec §5). The OCR/layout mapping is pure
 * and tested against a recorded AnalyzeResult; the live client is gated behind DOC_INTEL_ENDPOINT.
 */
import { describe, expect, it } from "vitest";
import { mapDiResult, normalizePolygon, type RawDiResult } from "../../apps/workers/src/extraction/index.js";

const RAW: RawDiResult = {
  modelId: "prebuilt-invoice",
  serviceVersion: "2023-07-31",
  pages: [{ pageNumber: 1, width: 8.5, height: 11 }],
  documents: [
    {
      fields: {
        CustomerName: { content: "Acme Industrial Supply", confidence: 0.98, boundingRegions: [{ pageNumber: 1, polygon: [0.68, 0.66, 4.08, 0.66, 4.08, 0.99, 0.68, 0.99] }] },
        InvoiceId: { content: "PO-100045", confidence: 0.97, boundingRegions: [{ pageNumber: 1, polygon: [5.95, 1.1, 7.65, 1.1, 7.65, 1.35, 5.95, 1.35] }] },
        Items: {
          values: [
            { properties: { ProductCode: { content: "ACM-778", confidence: 0.96 }, Quantity: { content: "500", confidence: 0.97 }, UnitPrice: { content: "1.50", confidence: 0.95 } } },
            { properties: { ProductCode: { content: "ACM-902", confidence: 0.95 }, Quantity: { content: "1000", confidence: 0.97 } } },
          ],
        },
      },
    },
  ],
};

describe("mapDiResult", () => {
  it("snake-cases header fields and reads the array field as line items", () => {
    const di = mapDiResult(RAW, "prebuilt-invoice");
    expect(di.pages).toBe(1);
    expect(di.diModelVersion).toBe("prebuilt-invoice:2023-07-31");
    expect(di.fields.customer_name!.text).toBe("Acme Industrial Supply");
    expect(di.fields.invoice_id!.text).toBe("PO-100045");
    expect(di.lines).toHaveLength(2);
    expect(di.lines[0]!.product_code!.text).toBe("ACM-778");
    expect(di.lines[0]!.quantity!.text).toBe("500");
    expect(di.lines[1]!.product_code!.text).toBe("ACM-902");
  });

  it("normalizes polygons from page units to 0..1", () => {
    const di = mapDiResult(RAW, "prebuilt-invoice");
    // 0.68in / 8.5in ≈ 0.08 ; 0.66in / 11in ≈ 0.06
    expect(di.fields.customer_name!.polygon[0]).toBeCloseTo(0.08, 2);
    expect(di.fields.customer_name!.polygon[1]).toBeCloseTo(0.06, 2);
    expect(normalizePolygon([4.25], { pageNumber: 1, width: 8.5, height: 11 })).toEqual([0.5]);
    expect(normalizePolygon(undefined, undefined)).toEqual([]);
  });
});

const hasDi = Boolean(process.env.DOC_INTEL_ENDPOINT && process.env.DOC_INTEL_SAMPLE_URL);
describe.skipIf(!hasDi)("AzureDocumentIntelligenceClient (live)", () => {
  it("analyzes a sample document into fields", async () => {
    const { createAzureDocumentIntelligenceClient } = await import("../../apps/workers/src/extraction/index.js");
    const client = createAzureDocumentIntelligenceClient();
    const di = await client.analyze({ blob: { blobUri: process.env.DOC_INTEL_SAMPLE_URL!, filename: "sample.pdf", contentHash: "live" } });
    expect(di.pages).toBeGreaterThan(0);
    expect(Object.keys(di.fields).length).toBeGreaterThan(0);
  }, 120_000); // real DI analysis polls for several seconds
});
