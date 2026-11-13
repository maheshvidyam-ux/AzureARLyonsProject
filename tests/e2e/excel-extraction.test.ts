/**
 * Excel/CSV order intake (spec §4/§5). Customers send orders as spreadsheets; those are parsed
 * (not OCR'd) into the same DiLayoutResult as a PDF, then flow through Foundry/normalize/match
 * unchanged. Covers the pure grid→layout mapping, the type router, a real xlsx round-trip, and a
 * full Excel-PO → normalized-PO pipeline run.
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { InMemoryPersistence } from "@coa/persistence";
import {
  ExcelExtractor,
  RoutingExtractor,
  isSpreadsheet,
  mapWorkbookToLayout,
  parseCsv,
} from "../../apps/workers/src/extraction/index.js";
import { processAttachment, type PipelineDeps } from "../../apps/workers/src/pipeline/pipeline.js";
import { InMemoryBlobStore } from "../../mocks/blob/in-memory-blob.js";
import { MockDocumentIntelligenceClient, MockFoundryClient } from "../../mocks/ai/mock-ai-clients.js";
import type { BlobRef, DiLayoutResult, DocumentIntelligenceClient, GraphMailMessage } from "../../apps/workers/src/pipeline/ports.js";

const GRID = [
  ["PO Number", "PO-XL-7788"],
  ["Customer", "Acme Industrial Supply"],
  [],
  ["Item", "Description", "Qty", "UOM", "Unit Price"],
  ["ACM-778", "1/2in Hex Bolt", "500", "EA", "1.50"],
  ["ACM-902", "Flat Washer", "1000", "EA", "0.50"],
];

describe("mapWorkbookToLayout", () => {
  it("puts key/value rows in fields and the widest table as line items", () => {
    const di = mapWorkbookToLayout(GRID, "PO");
    expect(di.fields.po_number!.text).toBe("PO-XL-7788");
    expect(di.fields.customer!.text).toBe("Acme Industrial Supply");
    expect(di.lines).toHaveLength(2);
    expect(di.lines[0]!.item!.text).toBe("ACM-778");
    expect(di.lines[0]!.qty!.text).toBe("500");
    expect(di.lines[1]!.unit_price!.text).toBe("0.50");
    expect(di.documentQualityFlags).toContain("SPREADSHEET");
  });

  it("parses quoted CSV", () => {
    const rows = parseCsv('Item,Description\nACM-778,"Bolt, Hex"\n');
    expect(rows[1]).toEqual(["ACM-778", "Bolt, Hex"]);
  });
});

describe("RoutingExtractor", () => {
  const fake = (tag: string): DocumentIntelligenceClient => ({ async analyze() { return { diModelVersion: tag, pages: 1, fields: {}, lines: [], documentQualityFlags: [] } as DiLayoutResult; } });
  const router = new RoutingExtractor({ di: fake("DI"), excel: fake("EXCEL") });
  const blob = (filename: string): BlobRef => ({ blobUri: "mock://x", filename, contentHash: "h" });

  it("routes by file type", async () => {
    expect(isSpreadsheet("order.xlsx")).toBe(true);
    expect(isSpreadsheet("order.csv")).toBe(true);
    expect(isSpreadsheet("order.pdf")).toBe(false);
    expect((await router.analyze({ blob: blob("order.xlsx") })).diModelVersion).toBe("EXCEL");
    expect((await router.analyze({ blob: blob("order.pdf") })).diModelVersion).toBe("DI");
  });
});

async function buildXlsx(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("PO");
  GRID.forEach((r) => ws.addRow(r));
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

describe("ExcelExtractor (real xlsx)", () => {
  it("parses a real .xlsx buffer into a layout", async () => {
    const bytes = await buildXlsx();
    const extractor = new ExcelExtractor({ resolveBytes: async () => bytes });
    const di = await extractor.analyze({ blob: { blobUri: "mock://x", filename: "order.xlsx", contentHash: "h" } });
    expect(di.lines).toHaveLength(2);
    expect(di.fields.po_number!.text).toBe("PO-XL-7788");
  });
});

describe("Excel PO → pipeline", () => {
  it("an Excel order flows through to a normalized, persisted PO", async () => {
    const bytes = await buildXlsx();
    const persistence = new InMemoryPersistence();
    const deps: PipelineDeps = {
      blob: new InMemoryBlobStore(),
      persistence,
      di: new RoutingExtractor({ di: new MockDocumentIntelligenceClient(), excel: new ExcelExtractor({ resolveBytes: async () => bytes }) }),
      foundry: new MockFoundryClient(),
    };
    const message: GraphMailMessage = {
      graphMessageId: "gm-xl", mailbox: "orders@lyons.example.com", sender: "buyer@acme.example.com", receivedAt: "2026-11-04T09:00:00Z", subject: "PO (xlsx)",
      attachments: [{ graphAttachmentId: "ga-xl", filename: "sample-po-xl-001.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", contentBase64: Buffer.from(bytes).toString("base64") }],
    };
    const r = await processAttachment(deps, message, 0);

    expect(r.decision).toBe("READY");
    expect(r.normalized!.header.normalized_po_number).toBe("POXL7788");
    expect(r.normalized!.lines).toHaveLength(2);
    expect(await persistence.countOrders()).toBe(1);
  });
});
