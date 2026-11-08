# 03 — Operational Data Model (ERD)

> **Engine update (ADR 0007):** the operational store is a **SQL database in Fabric** (T-SQL / SQL
> Server engine), superseding ADR 0001's PostgreSQL. The entities and keys below are unchanged; the
> physical DDL is T-SQL in `db/migrations/` (e.g. `jsonb`→`nvarchar(max)`+`ISJSON`, partial unique
> index→filtered unique index). Read "PostgreSQL" below as "the operational store."

Covers spec §12. The operational store is the source of truth. All internal IDs are UUIDs; every row
carries `company_id` (legal entity / `dataAreaId`), `source_channel`, row-version/concurrency fields,
and created/updated timestamps. Indices on customer/PO/company and on queue/status columns.

Two bounded contexts share the DB: **Operational** (ingestion → publish) and **Learning** (§10).

## 3.1 Operational entities

```mermaid
erDiagram
    mail_message ||--o{ mail_attachment : has
    mail_attachment ||--o| source_document : yields
    source_document ||--o{ extracted_order : produces
    extracted_order ||--|| order_header : normalizes_to
    order_header ||--o{ order_line : contains
    order_header ||--o{ order_validation : has
    order_header ||--o{ order_status_history : tracks
    order_header ||--o| duplicate_claim : reserves
    order_header ||--o{ outbox_event : emits
    order_header ||--o{ integration_ack : acknowledged_by
    processing_job ||--o{ job_attempt : retried_by
    order_header ||--o{ audit_event : audited_by

    mail_message {
        uuid id PK
        string company_id
        string graph_message_id UK "immutable"
        string mailbox
        string sender
        timestamptz received_at
        string subject
        string processing_outcome
        string failure_reason
    }
    mail_attachment {
        uuid id PK
        uuid mail_message_id FK
        string graph_attachment_id UK "immutable"
        string content_hash UK "dedupe"
        string blob_uri
        string content_type
        int    ingestion_attempts
    }
    source_document {
        uuid id PK
        uuid mail_attachment_id FK
        string company_id
        string classification
        string blob_uri_original
        string blob_uri_ocr "raw OCR payload"
        string di_model_version
    }
    extracted_order {
        uuid id PK
        uuid source_document_id FK
        jsonb raw_extraction "DI + Foundry raw, with evidence"
        jsonb normalized "PO schema, see doc 04"
        string foundry_model_version
        numeric overall_confidence
    }
    order_header {
        uuid id PK
        uuid extracted_order_id FK
        string company_id "dataAreaId"
        string source_channel "EMAIL_PO"
        string erp_customer_account
        string customer_po_number
        string normalized_po_number "dup key component"
        date   po_date
        date   requested_delivery_date
        string ship_to
        string bill_to
        string currency
        numeric total
        int    line_count
        string simple_status
        string internal_state
        int    row_version
    }
    order_line {
        uuid id PK
        uuid order_header_id FK
        int  source_line_no
        string customer_item_code
        string erp_item_id
        numeric quantity
        string uom
        numeric unit_price
        numeric extended_amount
        date requested_date
        jsonb evidence
    }
    order_validation {
        uuid id PK
        uuid order_header_id FK
        string severity "ERROR|WARNING"
        string code
        string field_path
        string message
        bool   blocking
        timestamptz evaluated_at
    }
    order_status_history {
        uuid id PK
        uuid order_header_id FK
        string from_state
        string to_state
        string actor "user|system"
        string reason
        timestamptz at
    }
    duplicate_claim {
        uuid id PK
        string company_id
        string business_key UK "norm_po + erp_acct + company"
        uuid   order_header_id FK
        string status "CLAIMED|RELEASED|RESOLVED"
        string matched_existing_ref
        string matched_channel "EMAIL|EDI|AX"
        timestamptz claimed_at
    }
    processing_job {
        uuid id PK
        uuid order_header_id FK
        string job_type
        string state
        string dedupe_key
    }
    job_attempt {
        uuid id PK
        uuid processing_job_id FK
        int  attempt_no
        string outcome
        string error
        timestamptz started_at
        timestamptz ended_at
    }
    outbox_event {
        uuid id PK
        uuid order_header_id FK
        string event_type "ORDER_APPROVED"
        jsonb payload "complete header+lines"
        string publish_state "PENDING|SENT|RECONCILED|FAILED"
        string correlation_id
        int  checksum
        timestamptz created_at
    }
    integration_ack {
        uuid id PK
        uuid order_header_id FK
        string boomi_status
        string ax_sales_order_id
        string error_code
        int  retries
        timestamptz at
    }
    audit_event {
        uuid id PK
        string company_id
        string actor
        string action
        string target_type
        string target_id
        jsonb before
        jsonb after
        timestamptz at
    }
```

### Consistency & keys (§12)
- **Business/duplicate key** = `normalized_po_number + erp_customer_account + company_id`, enforced by a
  **unique partial index** on `duplicate_claim(business_key) WHERE status IN ('CLAIMED','RESOLVED')`.
  This is the atomic cross-worker guarantee (§8).
- **Immutable document hashes** (`mail_attachment.content_hash`) + immutable Graph identifiers give
  ingestion idempotency (§4): a replayed webhook / re-scan / retry cannot create a second business order.
- **Optimistic concurrency** via `order_header.row_version` protects reviewer edits (§13).
- **Outbox** decouples approval from Fabric publish; publisher is retryable + reconciled (§11).

## 3.2 Learning entities (§10, §12)

```mermaid
erDiagram
    template_variant ||--o{ extraction_pattern : groups
    extraction_pattern ||--o{ pattern_evidence : supported_by
    learning_event ||--o| extraction_pattern : refines
    customer_alias }o--|| order_header : derived_from
    customer_item_mapping }o--|| order_line : derived_from
    learning_rule ||--o{ prediction_evaluation : evaluated_by
    model_registry ||--o{ prediction_evaluation : scored_in
    training_dataset ||--o{ prediction_evaluation : sampled_for

    learning_event {
        uuid id PK
        string company_id
        string module_code "ORDER_PROCESSING"
        string customer_id
        string document_type
        string template_variant_id
        string field_path
        jsonb original_value "OCR/AI value + coords + page"
        jsonb corrected_value "selected region + anchors"
        string prediction_source
        string prediction_version
        string user_id
        bool   approved
        string ax_outcome
        bool   reversed
        timestamptz at
    }
    template_variant {
        uuid id PK
        string company_id
        string customer_id
        string fingerprint
        string document_type
    }
    extraction_pattern {
        uuid id PK
        uuid template_variant_id FK
        string field_path
        jsonb region "relative coords + text anchors + page structure"
        string status "CANDIDATE|TRUSTED|DISABLED"
        int    independent_successes
        numeric confidence
    }
    pattern_evidence {
        uuid id PK
        uuid extraction_pattern_id FK
        uuid learning_event_id FK
        string outcome "VALIDATED|CONFLICT"
    }
    customer_alias {
        uuid id PK
        string company_id
        string erp_customer_account
        string alias_text
        string evidence
        int    conflict_count
        timestamptz last_seen
    }
    customer_item_mapping {
        uuid id PK
        string company_id
        string erp_customer_account
        string customer_item_code
        string erp_item_id
        string uom_pattern
        int    conflict_count
        timestamptz last_seen
    }
    learning_rule {
        uuid id PK
        string company_id
        string rule_type
        jsonb definition
        string status
    }
    model_registry {
        uuid id PK
        string name
        string version
        string stage "SHADOW|CANDIDATE|PROMOTED|ROLLED_BACK"
        string artifact_uri
    }
    training_dataset {
        uuid id PK
        string name
        string version
        string selection_criteria
    }
    prediction_evaluation {
        uuid id PK
        string subject_type "RULE|MODEL"
        string subject_ref
        numeric accuracy
        numeric drift
        timestamptz at
    }
```

### Learning guardrails encoded in the model (§10)
- `module_code` on every learning row → **no cross-module contamination**; module-scoped but **not** a
  tenant model.
- First correction → `extraction_pattern.status = CANDIDATE`. Promotion to `TRUSTED` requires
  `independent_successes >= configurable_threshold` **and** master-data revalidation — "no guarantee
  from count alone."
- `customer_alias` / `customer_item_mapping` carry `conflict_count` + recency so **stale learned
  mappings cannot bypass Fabric master validation.**
- `model_registry.stage` supports shadow mode → controlled promotion → rollback (§10 roadmap).
