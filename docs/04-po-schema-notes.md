# 04 — Normalized PO Schema: Design Notes

The machine-readable schema is `04-po-schema.json` (JSON Schema draft 2020-12). This note explains the
non-obvious modelling choices, all traceable to spec §5 / §7.

## Why every field is a `field` object (value + raw + evidence)

Spec §5: *"Preserve original text and normalized values separately"* and §9/§14 require
**bounding-box highlighting** and **source-to-field navigation** in the reviewer UI. So each extracted
field carries:

- `value` — normalized (typed date, numeric qty, ISO currency);
- `raw` — the original OCR string exactly as seen;
- `confidence` — provider/model confidence;
- `evidence` — page + polygon(s) + text anchors + prediction source/version.

This makes the two-pane viewer's "click field → highlight on PDF" feature a pure data lookup, and it is
what the learning engine records in `learning_event.original_value` (coordinates + page + anchors).

## "Never invent missing IDs" is structural, not advisory

`erp_customer_account` and `erp_item_id` are **nullable** and start `null`. They are filled only by the
deterministic matching step (§7), which also sets `match_status`. The AI interpretation step is
forbidden from populating them. If unmatched, a `validationFinding` with `blocking:true` is emitted —
`UNMATCHED` customer/item cannot stage.

## AI confidence vs blocking checks

`overall_confidence` and per-field `confidence` are informational. Staging authorization reads only
`validation[].blocking`. Encoding "blocking" as a boolean on the finding (not derived from a confidence
threshold) is what enforces §7's *"AI confidence never bypasses blocking checks."*

## Multi-order documents

One PDF may contain multiple POs (§5). Rather than nest, the pipeline emits **one NormalizedPurchaseOrder
per segment**, each with `extraction.multi_order_segment` populated and `ambiguous:true` when
segmentation is uncertain → routes to review.

## Duplicate key field

`header.normalized_po_number` is the canonicalized PO number (trim, case-fold, strip punctuation per the
agreed normalization rule — **Q-DUP-1**). It combines with `customer.erp_customer_account` and
`company.company_id` to form the duplicate business key (§8). It is a first-class field here so the
duplicate-claim worker never re-derives it inconsistently.

## Open schema questions (tracked in 07)

- **Q-PO-1** — Exact header/line fields present in real customer POs vs this proposed set (validate
  against Phase-0 PO samples).
- **Q-PO-2** — Revisions/releases/blanket orders: do they need dedicated header fields (e.g.
  `revision_no`, `release_no`)? Depends on Q-DUP-2.
- **Q-PO-3** — Pricing optionality: when is `unit_price` required vs ignored (pricing policy, §1)?
