/**
 * A document facsimile for the reviewer's right pane — a styled rendering of the invoice / PO built
 * from the extracted fields, so the reviewer sees a document (not raw JSON). In production this pane
 * embeds the actual uploaded PDF via a viewer; for extracted/mock data this is the faithful stand-in.
 */
import { money } from "../lib/status.js";

export interface ScanLine {
  left: string | null;
  desc: string | null;
  qty: number | null;
  uom?: string | null;
  unit: number | null;
  amount: number | null;
}

export interface DocumentScanProps {
  docType: string; // "INVOICE" | "PURCHASE ORDER"
  partyName: string;
  number: string;
  date: string | null;
  fields: Array<{ k: string; v: string }>;
  leftHeader: string; // column header for the left line cell ("Item" / "Code")
  lines: ScanLine[];
  total: number | null;
  currency: string | null;
}

export function DocumentScan(props: DocumentScanProps): JSX.Element {
  return (
    <div className="scan">
      <div className="scan-h">
        <div className="scan-co">{props.partyName || "—"}</div>
        <div className="scan-meta">
          <div className="scan-type">{props.docType}</div>
          <div className="mono">{props.number || "—"}</div>
          <div>{props.date ?? "— no date —"}</div>
        </div>
      </div>

      <div className="scan-fields">
        {props.fields.map((f) => (
          <div className="scan-f" key={f.k}>
            <div className="k">{f.k}</div>
            <div className="v">{f.v}</div>
          </div>
        ))}
      </div>

      {props.lines.length > 0 ? (
        <table className="scan-lines">
          <thead>
            <tr>
              <th>{props.leftHeader}</th>
              <th>Description</th>
              <th className="r">Qty</th>
              <th className="r">Unit</th>
              <th className="r">Amount</th>
            </tr>
          </thead>
          <tbody>
            {props.lines.map((l, i) => (
              <tr key={i}>
                <td className="mono">{l.left ?? "—"}</td>
                <td>{l.desc ?? "—"}</td>
                <td className="r num">{l.qty ?? "—"}{l.uom ? ` ${l.uom}` : ""}</td>
                <td className="r num">{money(l.unit)}</td>
                <td className="r num">{money(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="scan-empty">No line items were read from this document.</p>
      )}

      <div className="scan-total">
        Total due <b className="num">{money(props.total)} {props.currency ?? ""}</b>
      </div>
    </div>
  );
}
