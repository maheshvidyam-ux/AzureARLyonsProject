# Runbook — First Vertical Slice: "Ingest one PO end-to-no-stage"

Implements backlog §9.3. Proves the processing spine on **quarantined mocks** (spec §18) and
**stops before staging** — no Graph, Blob, Document Intelligence, AI Foundry, Fabric, Boomi, or AX
call is made against a live service.

## What it does

```
Graph (mock mailbox) → idempotent ingestion record (persistence) → Blob (in-memory)
  → Document Intelligence (recorded) → source_document → AI Foundry (recorded)
  → normalize to NormalizedPurchaseOrder (docs/04) → deterministic validation
  → persist order graph (header/lines/validation/history via @coa/persistence)
  → decision: READY | NEEDS_REVIEW | FAILED   ⟵ STOPS HERE (never stages)
```

All operational state is written through the `@coa/persistence` port — in-memory for tests/demo, a
**SQL database in Fabric** adapter for production (ADR 0007).

## Run it

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # vitest — §16 critical cases + idempotency
npm run demo:slice    # prints the trace + outcome for all three sample POs
```

## Sample fixtures & expected outcomes

| Fixture | Scenario | Decision | Key finding |
|---|---|---|---|
| `sample-po-001` | Clean single PO, high confidence | **READY** | none blocking |
| `sample-po-002` | Zero-quantity line, missing PO date | **NEEDS_REVIEW** | `LINE_QUANTITY_INVALID` (blocking) |
| `sample-po-003` | AI returns malformed JSON | **FAILED** | `FOUNDRY_OUTPUT_UNPARSEABLE` (blocking) |

Recorded AI responses live under `mocks/ai/` and are keyed by sample file stem.

## Invariants this slice enforces (and tests)

- **Idempotency (§4):** a replayed message creates exactly one ingestion record and one Blob write.
- **AI suggests; rules authorize (§7):** blocking validation findings force review regardless of AI
  confidence; malformed AI output degrades to a controlled `FAILED`, never a crash.
- **Nothing is staged (§18):** every result carries `stagedBlocked: true`; reaching any post-staging
  state throws a guardrail error (`PRE_STAGING_TERMINAL_STATES`).

## Known limitations / provisional decisions (must revisit)

- **PO-number normalization** (`packages/domain/src/po-number.ts`) is provisional — pending **Q-DUP-1**.
- **Validation policy & confidence threshold** (`validation.ts`, `CONFIDENCE_REVIEW_THRESHOLD`) are
  provisional — pending **Q-VAL-1 / Q-PRICE-1**.
- **Master matching** (customer/item/UOM against Fabric) is **not** in this slice — Phase 3. Unmatched
  customer is an informational warning here, not a block.
- **Persistence** goes through the `@coa/persistence` port (ADR 0007). Tests + demo use the in-memory
  implementation; the **SQL-database-in-Fabric** adapter (`packages/persistence/src/fabric-sql`) is real
  parameterized T-SQL but needs a provisioned dev Fabric SQL database to run against — see
  `db/README.md` and the `FABRIC_SQL_SERVER`-gated integration test in
  `packages/persistence/persistence.test.ts`.
- Mocks are the source of inputs; real Graph/Blob/DI/Foundry adapters implement the same `ports.ts`
  interfaces in later slices.
