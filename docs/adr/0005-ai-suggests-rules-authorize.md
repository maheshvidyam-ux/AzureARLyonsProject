# ADR 0005 — AI suggests, deterministic rules authorize

**Status:** Accepted (spec §2, §5, §7, §10)

## Context
Two AI components (Document Intelligence, AI Foundry) and a learning engine produce *suggestions*. The
risk is that a confident-but-wrong AI output stages an invalid order to AX.

## Decision
- AI output is always **schema-validated** and **revalidated** by deterministic rules before staging.
- **AI confidence never bypasses a blocking check** (§7). Staging authorization reads only
  `validation[].blocking`, not confidence.
- AI **never invents missing IDs** (§5). ERP customer/item IDs are set only by deterministic matching;
  unknown ⇒ null ⇒ blocking finding.
- Learned patterns and mappings must **revalidate against Fabric masters** — stale learned data cannot
  bypass validation (§10).
- Every suggestion is **explainable with evidence** (coords, anchors, source/version).

## Consequences
- Determinism and auditability over raw automation rate; STP improves via *validated* learning, not by
  trusting confidence.
- Validation policy (Q-VAL-1), price policy (Q-PRICE-1) must be explicit and configurable.
