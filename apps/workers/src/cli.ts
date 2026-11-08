/**
 * Demo runner for the first vertical slice. Wires the TEST-ENV-ONLY mocks + the in-memory
 * persistence to the pipeline and prints, for each sample PO, the trace and outcome.
 * Touches nothing external. (Swap InMemoryPersistence for FabricSqlPersistence + a dev
 * Fabric SQL database to run against the real store — ADR 0007.)
 *
 *   npm run demo:slice
 */
import { InMemoryPersistence } from "@coa/persistence";
import { FakeGraphSource } from "../../../mocks/graph/fake-mailbox.js";
import { InMemoryBlobStore } from "../../../mocks/blob/in-memory-blob.js";
import { MockDocumentIntelligenceClient, MockFoundryClient } from "../../../mocks/ai/mock-ai-clients.js";
import { runSlice, type PipelineDeps } from "./pipeline/pipeline.js";

async function main(): Promise<void> {
  const deps: PipelineDeps = {
    blob: new InMemoryBlobStore(),
    persistence: new InMemoryPersistence(),
    di: new MockDocumentIntelligenceClient(),
    foundry: new MockFoundryClient(),
  };

  const graph = new FakeGraphSource();
  const messages = await graph.fetchMessages();
  const results = await runSlice(deps, messages);

  for (const r of results) {
    console.log("\n" + "=".repeat(72));
    console.log(`document   : ${r.ingestion.filename}  (doc ${r.documentId?.slice(0, 8) ?? "—"}, order ${r.orderHeaderId?.slice(0, 8) ?? "—"})`);
    console.log(`decision   : ${r.decision}  [internal=${r.internalState}, status="${r.simpleStatus}"]`);
    console.log(`staged?    : blocked (stops before staging) = ${r.stagedBlocked}`);
    console.log(`dup key    : ${r.duplicateBusinessKey ?? "(not computable — customer unmatched, Phase 3)"}`);
    if (r.normalized) {
      console.log(`po number  : ${r.normalized.header.normalized_po_number ?? "∅"}  lines=${r.normalized.lines.length}  confidence=${r.normalized.extraction.overall_confidence}`);
    }
    console.log("trace      :");
    for (const t of r.trace) console.log(`   • ${t}`);
    if (r.findings.length) {
      console.log("findings   :");
      for (const f of r.findings) {
        console.log(`   [${f.severity}${f.blocking ? "/BLOCKING" : ""}] ${f.code} @ ${f.field_path ?? "-"} : ${f.message ?? ""}`);
      }
    }
  }
  console.log("\n" + "=".repeat(72));
  console.log(`Processed ${results.length} document(s). Persisted orders: ${await deps.persistence.countOrders()}. Blob writes: ${deps.blob.writeCount()}.`);
  console.log("No order was staged, and nothing external was contacted. ✅");
  await deps.persistence.close();
}

main().catch((err) => {
  console.error("Slice demo failed:", err);
  process.exitCode = 1;
});
