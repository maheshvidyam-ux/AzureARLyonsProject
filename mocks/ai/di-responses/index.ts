/**
 * TEST-ENV-ONLY recorded Document Intelligence layout results (spec §18 — mocks are
 * quarantined under mocks/ and never reach a production build). Keyed by sample file
 * stem so the fake mailbox, Blob sink, and DI client all line up on the same fixtures.
 */
import type { DiLayoutResult } from "../../../apps/workers/src/pipeline/ports.js";

const box = (page: number, x: number, y: number, w: number, h: number): number[] => [
  x, y, x + w, y, x + w, y + h, x, y + h,
];

export const DI_RESPONSES: Record<string, DiLayoutResult> = {
  // Clean single-order PO — high confidence, all fields present.
  "sample-po-001": {
    diModelVersion: "prebuilt-invoice:2024-11-30",
    pages: 1,
    fields: {
      vendor_name: { text: "Acme Industrial Supply", confidence: 0.98, page: 1, polygon: box(1, 0.08, 0.06, 0.4, 0.03) },
      po_number: { text: "PO-100045", confidence: 0.97, page: 1, polygon: box(1, 0.7, 0.1, 0.2, 0.025) },
      po_date: { text: "2026-10-28", confidence: 0.95, page: 1, polygon: box(1, 0.7, 0.14, 0.2, 0.025) },
      currency: { text: "USD", confidence: 0.99, page: 1, polygon: box(1, 0.7, 0.18, 0.08, 0.02) },
      ship_to: { text: "Lyons DC 4, 100 Dock Rd, Columbus OH", confidence: 0.9, page: 1, polygon: box(1, 0.08, 0.2, 0.45, 0.06) },
      bill_to: { text: "Acme AP, PO Box 22, Columbus OH", confidence: 0.9, page: 1, polygon: box(1, 0.55, 0.2, 0.4, 0.06) },
      subtotal: { text: "1250.00", confidence: 0.96, page: 1, polygon: box(1, 0.8, 0.8, 0.12, 0.02) },
      tax: { text: "0.00", confidence: 0.96, page: 1, polygon: box(1, 0.8, 0.83, 0.12, 0.02) },
      grand_total: { text: "1250.00", confidence: 0.97, page: 1, polygon: box(1, 0.8, 0.86, 0.12, 0.02) },
    },
    lines: [
      {
        item_code: { text: "ACM-778", confidence: 0.96, page: 1, polygon: box(1, 0.08, 0.45, 0.12, 0.02) },
        description: { text: "1/2in Hex Bolt, Zinc", confidence: 0.94, page: 1, polygon: box(1, 0.22, 0.45, 0.3, 0.02) },
        quantity: { text: "500", confidence: 0.97, page: 1, polygon: box(1, 0.55, 0.45, 0.07, 0.02) },
        uom: { text: "EA", confidence: 0.95, page: 1, polygon: box(1, 0.64, 0.45, 0.06, 0.02) },
        unit_price: { text: "1.50", confidence: 0.95, page: 1, polygon: box(1, 0.72, 0.45, 0.1, 0.02) },
        extended_amount: { text: "750.00", confidence: 0.95, page: 1, polygon: box(1, 0.84, 0.45, 0.1, 0.02) },
      },
      {
        item_code: { text: "ACM-902", confidence: 0.95, page: 1, polygon: box(1, 0.08, 0.48, 0.12, 0.02) },
        description: { text: "Flat Washer, Zinc", confidence: 0.93, page: 1, polygon: box(1, 0.22, 0.48, 0.3, 0.02) },
        quantity: { text: "1000", confidence: 0.97, page: 1, polygon: box(1, 0.55, 0.48, 0.07, 0.02) },
        uom: { text: "EA", confidence: 0.95, page: 1, polygon: box(1, 0.64, 0.48, 0.06, 0.02) },
        unit_price: { text: "0.50", confidence: 0.95, page: 1, polygon: box(1, 0.72, 0.48, 0.1, 0.02) },
        extended_amount: { text: "500.00", confidence: 0.95, page: 1, polygon: box(1, 0.84, 0.48, 0.1, 0.02) },
      },
    ],
    documentQualityFlags: [],
  },

  // Problem PO — a line with zero quantity and a missing PO date (drives NEEDS_REVIEW).
  "sample-po-002": {
    diModelVersion: "prebuilt-invoice:2024-11-30",
    pages: 1,
    fields: {
      po_number: { text: "PO-100046", confidence: 0.6, page: 1, polygon: box(1, 0.7, 0.1, 0.2, 0.025) },
      currency: { text: "USD", confidence: 0.9, page: 1, polygon: box(1, 0.7, 0.18, 0.08, 0.02) },
      ship_to: { text: "Lyons DC 4, Columbus OH", confidence: 0.7, page: 1, polygon: box(1, 0.08, 0.2, 0.45, 0.06) },
      grand_total: { text: "90.00", confidence: 0.8, page: 1, polygon: box(1, 0.8, 0.86, 0.12, 0.02) },
    },
    lines: [
      {
        item_code: { text: "ACM-778", confidence: 0.8, page: 1, polygon: box(1, 0.08, 0.45, 0.12, 0.02) },
        description: { text: "1/2in Hex Bolt, Zinc", confidence: 0.8, page: 1, polygon: box(1, 0.22, 0.45, 0.3, 0.02) },
        quantity: { text: "0", confidence: 0.4, page: 1, polygon: box(1, 0.55, 0.45, 0.07, 0.02) },
        uom: { text: "EA", confidence: 0.8, page: 1, polygon: box(1, 0.64, 0.45, 0.06, 0.02) },
        unit_price: { text: "1.50", confidence: 0.8, page: 1, polygon: box(1, 0.72, 0.45, 0.1, 0.02) },
        extended_amount: { text: "0.00", confidence: 0.8, page: 1, polygon: box(1, 0.84, 0.45, 0.1, 0.02) },
      },
    ],
    documentQualityFlags: ["LOW_QUALITY"],
  },

  // sample-po-003 intentionally has NO DI issues; the failure is injected at the Foundry
  // stage (malformed JSON), so its DI result is a normal clean single line.
  "sample-po-003": {
    diModelVersion: "prebuilt-invoice:2024-11-30",
    pages: 2,
    fields: {
      po_number: { text: "PO-100047", confidence: 0.92, page: 1, polygon: box(1, 0.7, 0.1, 0.2, 0.025) },
      po_date: { text: "2026-11-01", confidence: 0.92, page: 1, polygon: box(1, 0.7, 0.14, 0.2, 0.025) },
      currency: { text: "USD", confidence: 0.95, page: 1, polygon: box(1, 0.7, 0.18, 0.08, 0.02) },
      grand_total: { text: "300.00", confidence: 0.9, page: 2, polygon: box(2, 0.8, 0.86, 0.12, 0.02) },
    },
    lines: [
      {
        item_code: { text: "ACM-511", confidence: 0.9, page: 1, polygon: box(1, 0.08, 0.45, 0.12, 0.02) },
        description: { text: "Lock Nut, Steel", confidence: 0.9, page: 1, polygon: box(1, 0.22, 0.45, 0.3, 0.02) },
        quantity: { text: "200", confidence: 0.9, page: 1, polygon: box(1, 0.55, 0.45, 0.07, 0.02) },
        uom: { text: "EA", confidence: 0.9, page: 1, polygon: box(1, 0.64, 0.45, 0.06, 0.02) },
        unit_price: { text: "1.50", confidence: 0.9, page: 1, polygon: box(1, 0.72, 0.45, 0.1, 0.02) },
        extended_amount: { text: "300.00", confidence: 0.9, page: 1, polygon: box(1, 0.84, 0.45, 0.1, 0.02) },
      },
    ],
    documentQualityFlags: ["TABLE_SPANS_PAGES"],
  },
};
