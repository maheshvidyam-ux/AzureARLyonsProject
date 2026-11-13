/**
 * Routes a document to the right extractor by file type and emits a common `DiLayoutResult`:
 * PDF/image → Azure Document Intelligence (OCR/layout); Excel/CSV → the spreadsheet extractor.
 * Implements the `DocumentIntelligenceClient` port so it drops in as the pipeline's `di` with no
 * other change — orders/invoices sent as Excel flow through the same Foundry/normalize/match path.
 */
import type { BlobRef, DiLayoutResult, DocumentIntelligenceClient } from "../pipeline/ports.js";

export function isSpreadsheet(filename: string, contentType?: string | null): boolean {
  if (/\.(xlsx|xlsm|xls|csv)$/i.test(filename)) return true;
  const ct = (contentType ?? "").toLowerCase();
  return ct.includes("spreadsheet") || ct.includes("excel") || ct === "text/csv";
}

export interface RoutingExtractorOptions {
  di: DocumentIntelligenceClient;
  excel: DocumentIntelligenceClient;
}

export class RoutingExtractor implements DocumentIntelligenceClient {
  constructor(private readonly opts: RoutingExtractorOptions) {}
  async analyze(input: { blob: BlobRef }): Promise<DiLayoutResult> {
    return isSpreadsheet(input.blob.filename) ? this.opts.excel.analyze(input) : this.opts.di.analyze(input);
  }
}
