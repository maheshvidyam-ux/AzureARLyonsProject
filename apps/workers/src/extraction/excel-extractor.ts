/**
 * Spreadsheet extractor (spec §4/§5): customers/vendors sometimes send orders/invoices as Excel
 * or CSV rather than a PDF. Those are structured data, not scanned documents — so instead of
 * Document Intelligence (OCR) we parse the workbook and emit the SAME `DiLayoutResult` the DI
 * client produces, so AI Foundry interpretation + normalize + matching + staging are unchanged.
 *
 * Implements the `DocumentIntelligenceClient` port so it drops in behind the routing extractor.
 * The grid→layout mapping is pure and unit-tested; exceljs handles the .xlsx binary.
 */
import ExcelJS from "exceljs";
import type { BlobRef, DiLayoutResult, DiValue, DocumentIntelligenceClient } from "../pipeline/ports.js";
import { fetchBlobBytes, type ResolveBytes } from "./azure-di-client.js";

const snake = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[\s./-]+/g, "_").replace(/[^a-z0-9_]/gi, "").toLowerCase();
const cell = (text: string): DiValue => ({ text: text.trim(), confidence: 1, page: 1, polygon: [] });
const nonEmpty = (row: string[]): number => row.filter((c) => c && c.trim()).length;

/** Parse an .xlsx buffer into a grid (first worksheet). */
export async function parseXlsx(bytes: Uint8Array): Promise<{ sheetName: string; rows: string[][] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return { sheetName: "", rows: [] };
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const arr: string[] = [];
    row.eachCell({ includeEmpty: true }, (c, col) => {
      arr[col - 1] = c.text ?? "";
    });
    rows.push([...arr].map((c) => c ?? ""));
  });
  return { sheetName: sheet.name, rows };
}

/** Parse CSV text into a grid (quote-aware). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === "") continue;
    const cells: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}

/**
 * Map a spreadsheet grid onto a DiLayoutResult: the first row with ≥2 non-empty cells is the
 * line-item header; rows below become line items keyed by column; two-cell rows above it are
 * header key/value fields.
 */
export function mapWorkbookToLayout(rows: string[][], sheetName: string): DiLayoutResult {
  const fields: Record<string, DiValue> = {};
  const lines: Array<Record<string, DiValue>> = [];

  // The line-item header is the widest row (most columns); key/value rows above it are narrower.
  const widths = rows.map(nonEmpty);
  const maxWidth = Math.max(0, ...widths);
  const headerIdx = maxWidth >= 2 ? widths.findIndex((w) => w === maxWidth) : -1;
  const tableStart = headerIdx < 0 ? rows.length : headerIdx;

  for (let i = 0; i < tableStart; i++) {
    const r = rows[i]!.filter((c) => c && c.trim());
    if (r.length >= 2) fields[snake(r[0]!)] = cell(r[1]!);
    else if (r.length === 1 && r[0]!.includes(":")) {
      const [k, ...v] = r[0]!.split(":");
      fields[snake(k!)] = cell(v.join(":"));
    }
  }

  if (headerIdx >= 0) {
    const header = rows[headerIdx]!.map((c) => snake(c));
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i]!;
      if (nonEmpty(row) === 0) continue;
      const rec: Record<string, DiValue> = {};
      header.forEach((col, c) => {
        if (col && row[c] != null && row[c]!.trim()) rec[col] = cell(row[c]!);
      });
      if (Object.keys(rec).length > 0) lines.push(rec);
    }
  }

  return { diModelVersion: `excel:${sheetName || "sheet1"}`, pages: 1, fields, lines, documentQualityFlags: ["SPREADSHEET"] };
}

export interface ExcelExtractorOptions {
  resolveBytes: ResolveBytes;
}

export class ExcelExtractor implements DocumentIntelligenceClient {
  constructor(private readonly opts: ExcelExtractorOptions) {}
  async analyze(input: { blob: BlobRef }): Promise<DiLayoutResult> {
    const bytes = await this.opts.resolveBytes(input.blob);
    if (/\.csv$/i.test(input.blob.filename)) {
      return mapWorkbookToLayout(parseCsv(new TextDecoder().decode(bytes)), "csv");
    }
    const { sheetName, rows } = await parseXlsx(bytes);
    return mapWorkbookToLayout(rows, sheetName);
  }
}

export function createDefaultExcelExtractor(opts?: { resolveBytes?: ResolveBytes }): ExcelExtractor {
  return new ExcelExtractor({ resolveBytes: opts?.resolveBytes ?? fetchBlobBytes });
}
