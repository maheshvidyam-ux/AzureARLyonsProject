# Samples

Representative inputs for the processing pipeline and the §16 test matrix.

> **Phase-0 note:** a real representative PO set (clean, scanned, rotated, multi-page, multi-order,
> unknown-template) is still to be obtained from the business — see `docs/07-contract-questions.md`.
> Until then, the first slice uses **synthetic** fixtures.

For the first vertical slice, the synthetic samples are expressed as **recorded Document Intelligence
and AI Foundry responses** (keyed by file stem) under `mocks/ai/`, because the DI/Foundry calls are
mocked — there is no PDF to OCR yet. Each stem here corresponds one-to-one with those recordings:

| Stem | Scenario | Expected decision |
|---|---|---|
| `sample-po-001` | Clean single-order PO | READY |
| `sample-po-002` | Zero-qty line + missing PO date | NEEDS_REVIEW |
| `sample-po-003` | AI returns malformed JSON | FAILED |

When real sample PDFs arrive, drop them in per-stem folders here and switch the mock DI/Foundry clients
to real adapters behind the same `ports.ts` interfaces.
