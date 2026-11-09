# Runbook — Real Document Intelligence & AI Foundry Clients

Phase-2 extraction/interpretation adapters (spec §5). They implement the pipeline's
`DocumentIntelligenceClient` and `FoundryClient` ports, so they drop in behind the mocks with **no
pipeline changes**. Entra auth (no keys). Live use needs provisioned Azure AI resources.

## Document Intelligence (`apps/workers/src/extraction/`)

- `AzureDocumentIntelligenceClient` — `@azure/ai-form-recognizer` `DocumentAnalysisClient` +
  `DefaultAzureCredential`. `analyze({blob})` resolves document bytes (injected `resolveBytes`; default
  fetches an http(s) blob/SAS URL), runs `beginAnalyzeDocument(modelId, bytes)`, and maps the result.
- `mapDiResult` (pure) — snake-cases each document field, reads the first array field as line items
  (works for prebuilt-invoice `Items` and a future custom PO model), and **normalizes polygons** from
  page inches to 0..1 for the reviewer's bounding-box highlighting.
- Config: `DOC_INTEL_ENDPOINT`, `DOC_INTEL_MODEL_ID` (default `prebuilt-invoice`).

> The real PO field set comes from **Q-FAB-1 / a custom DI model**; `prebuilt-invoice` is a stand-in.
> The mapping is model-agnostic so a custom PO model drops in by changing `DOC_INTEL_MODEL_ID`.

## AI Foundry (`apps/workers/src/interpretation/`)

- `AzureFoundryClient` — builds a **versioned, schema-constrained prompt** (`PROMPT_VERSION`,
  recorded per order for traceability/learning) from the DI output, calls the model in JSON mode, and
  returns `{ rawJson, deployment, promptVersion }`. Token usage is logged for cost tracking (spec §15).
- The chat call is behind a `ChatCompleter` seam; `AzureOpenAiCompleter` wraps `AzureOpenAI`
  (`openai` SDK) with Entra via `getBearerTokenProvider`. The model output is validated downstream by
  `normalize` against the authoritative JSON Schema (docs/04) — malformed output degrades to a
  controlled failure (spec §16), already tested.
- Config: `AI_FOUNDRY_ENDPOINT`, `AI_FOUNDRY_DEPLOYMENT`, `AI_FOUNDRY_API_VERSION` (default `2024-10-21`).

## Wiring (production)

```ts
const di = createAzureDocumentIntelligenceClient({ resolveBytes });   // from Blob storage
const foundry = createAzureFoundryClient();
// pipeline deps: { blob, persistence, di, foundry, masters }
```

Nothing in production imports from `mocks/` — the recorded DI/Foundry fixtures stay test-only (spec §18).

## Tests

- `tests/e2e/azure-di.test.ts` — `mapDiResult` snake-casing / line extraction / polygon normalization;
  live client gated behind `DOC_INTEL_ENDPOINT` + `DOC_INTEL_SAMPLE_URL`.
- `tests/e2e/azure-foundry.test.ts` — prompt includes DI text; `interpret` (fake completer) output flows
  through `normalize` to a schema-valid PO; malformed output degrades to UNPARSEABLE; live model gated
  behind `AI_FOUNDRY_ENDPOINT` + `AI_FOUNDRY_DEPLOYMENT`.

## Still needed to run live

- Terraform **`modules/ai`** (Document Intelligence account + AI Foundry / Azure OpenAI deployment) —
  not yet authored; the clients are ready for it.
- A **custom PO DI model** (or confirm prebuilt-invoice is acceptable) and a **data-retention** review
  (spec §3). Strict structured-outputs (json_schema) is a possible hardening over JSON mode.
