/**
 * Manual upload modal — pick AR order vs AP invoice, choose a PDF/XLSX/CSV, and process it through
 * the SAME pipeline as an emailed attachment (POST /uploads). On success the caller navigates to the
 * created order/invoice. Write-role only (the server also returns 403 for a Viewer).
 */
import { useRef, useState } from "react";
import { uploadDocument, ApiError, type UploadModule } from "../api/client.js";
import type { UploadResult } from "../api/contract.js";
import { useAuth } from "../auth/AuthContext.js";
import type { Notify } from "./Toast.js";

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("could not read the file"));
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(",") + 1)); // strip the data:...;base64, prefix
    };
    r.readAsDataURL(file);
  });
}

export function UploadModal({ open, onClose, onUploaded, notify }: { open: boolean; onClose: () => void; onUploaded: (r: UploadResult) => void; notify: Notify }): JSX.Element | null {
  const { identity, canWrite } = useAuth();
  const [module, setModule] = useState<UploadModule>("ORDER_PROCESSING");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const onProcess = async (): Promise<void> => {
    if (!file) return;
    setBusy(true);
    try {
      const contentBase64 = await readBase64(file);
      const res = await uploadDocument(identity, { module, filename: file.name, contentBase64 });
      notify(`Processed ${file.name} → ${res.module === "AP_INVOICE" ? "invoice" : "order"} ${res.reference ?? ""} · ${res.internalState}`);
      setFile(null);
      onUploaded(res);
    } catch (e) {
      notify(e instanceof ApiError ? (e.status === 403 ? "Your role is read-only — upload not permitted." : `Upload failed (${e.status})`) : String(e));
    } finally {
      setBusy(false);
    }
  };

  const seg = (m: UploadModule, label: string, sub: string) => (
    <button type="button" className="seg-btn" aria-pressed={module === m} onClick={() => setModule(m)} disabled={busy}>
      {label}
      <small>{sub}</small>
    </button>
  );

  return (
    <div className="modalwrap" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Upload a document">
        <div className="mh">
          <h3>Upload a document</h3>
          <button className="x" aria-label="Close" onClick={onClose} disabled={busy}>✕</button>
        </div>
        <div className="mb">
          <div>
            <span className="fldlab">Process as</span>
            <div className="seg">
              {seg("ORDER_PROCESSING", "AR · Customer order", "PO → AX sales order")}
              {seg("AP_INVOICE", "AP · Vendor invoice", "Invoice → AX voucher")}
            </div>
          </div>
          <div>
            <span className="fldlab">File</span>
            <label className={`drop${file ? " has" : ""}`}>
              <input ref={fileRef} type="file" accept=".pdf,.xlsx,.xls,.csv" hidden disabled={busy} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              {file ? <span className="fn">{file.name}</span> : <span>Click to choose a PDF, XLSX, or CSV</span>}
            </label>
          </div>
          {!canWrite && <div className="hint bad">Your role is read-only — switch to a write role to upload.</div>}
        </div>
        <div className="mf">
          <button className="btn" style={{ flex: "none", padding: "9px 16px" }} onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" style={{ flex: "none", padding: "9px 16px" }} onClick={() => void onProcess()} disabled={!file || busy || !canWrite}>
            {busy ? "Processing…" : "Process document"}
          </button>
        </div>
      </div>
    </div>
  );
}
