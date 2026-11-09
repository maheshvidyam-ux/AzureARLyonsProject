/**
 * Maps an Azure Document Intelligence `AnalyzeResult` onto our `DiLayoutResult` port shape
 * (spec §5). Kept pure (no SDK import) so it can be unit-tested against recorded DI payloads.
 *
 * Model-agnostic: it snake-cases each document field name and reads the first array field
 * (e.g. prebuilt-invoice `Items`, or a custom PO model's line field) as the line items, so it
 * works for both the prebuilt-invoice stand-in and a future custom PO model (Q-FAB-1).
 *
 * Polygons from DI are in page units (inches); we normalize them to 0..1 using the page
 * dimensions so the reviewer UI's bounding-box highlighting (spec §14) lines up.
 */
import type { DiLayoutResult, DiValue } from "../pipeline/ports.js";

export interface RawDiField {
  content?: string;
  confidence?: number;
  boundingRegions?: Array<{ pageNumber: number; polygon?: number[] }>;
  /** object field sub-fields */
  properties?: Record<string, RawDiField>;
  /** array field entries */
  values?: RawDiField[];
}
export interface RawDiPage {
  pageNumber: number;
  width?: number;
  height?: number;
  angle?: number;
}
export interface RawDiResult {
  modelId?: string;
  serviceVersion?: string;
  apiVersion?: string;
  pages?: RawDiPage[];
  documents?: Array<{ fields?: Record<string, RawDiField> }>;
}

const snake = (s: string): string =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[\s-]+/g, "_").toLowerCase();

export function mapDiResult(raw: RawDiResult, modelId: string): DiLayoutResult {
  const pageDims = new Map<number, RawDiPage>();
  for (const p of raw.pages ?? []) pageDims.set(p.pageNumber, p);

  const toValue = (f: RawDiField): DiValue => {
    const region = f.boundingRegions?.[0];
    const page = region?.pageNumber ?? 1;
    return {
      text: f.content ?? "",
      confidence: f.confidence ?? 0,
      page,
      polygon: normalizePolygon(region?.polygon, pageDims.get(page)),
    };
  };

  const docFields = raw.documents?.[0]?.fields ?? {};
  const fields: Record<string, DiValue> = {};
  const lines: Array<Record<string, DiValue>> = [];

  for (const [name, f] of Object.entries(docFields)) {
    if (Array.isArray(f.values)) {
      // first array field = line items
      if (lines.length === 0) {
        for (const item of f.values) {
          const row: Record<string, DiValue> = {};
          for (const [k, sub] of Object.entries(item.properties ?? {})) row[snake(k)] = toValue(sub);
          lines.push(row);
        }
      }
      continue;
    }
    fields[snake(name)] = toValue(f);
  }

  const flags: DiLayoutResult["documentQualityFlags"] = [];
  if ((raw.pages ?? []).some((p) => Math.abs(p.angle ?? 0) > 3)) flags.push("ROTATED");
  if ((raw.pages?.length ?? 1) > 1 && lines.length > 0) flags.push("TABLE_SPANS_PAGES");

  return {
    diModelVersion: `${modelId}:${raw.serviceVersion ?? raw.apiVersion ?? ""}`,
    pages: raw.pages?.length ?? raw.documents?.length ?? 1,
    fields,
    lines,
    documentQualityFlags: flags,
  };
}

/** Normalize an [x1,y1,...] page-unit polygon to 0..1 using the page width/height. */
export function normalizePolygon(polygon: number[] | undefined, page: RawDiPage | undefined): number[] {
  if (!polygon || polygon.length === 0) return [];
  if (!page?.width || !page?.height) return polygon;
  return polygon.map((v, i) => Number((v / (i % 2 === 0 ? page.width! : page.height!)).toFixed(4)));
}
