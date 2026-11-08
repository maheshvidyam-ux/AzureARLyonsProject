/* =============================================================================
 * Migration 0001 — operational baseline (UP)
 * Target: SQL database in Fabric (T-SQL / SQL Server engine) — ADR 0007.
 *
 * Covers the operational entities the pipeline touches from ingestion through the
 * atomic duplicate claim (docs/03-data-model-erd.md). Learning entities (§10) and the
 * outbox / integration-ack / job tables (Phase 5) are deferred to later migrations.
 *
 * Conventions (ADR 0007 consequences):
 *   - UUID PKs            -> uniqueidentifier DEFAULT NEWID()
 *   - timestamps (UTC)    -> datetime2(3)     DEFAULT SYSUTCDATETIME()
 *   - jsonb               -> nvarchar(max)    + CHECK (ISJSON(col) = 1)
 *   - optimistic lock     -> row_version int  DEFAULT 0
 *   - every row carries company_id (legal entity / dataAreaId)
 * ========================================================================== */

-------------------------------------------------------------------------------
-- mail_message : one received email (idempotent on the immutable Graph id)
-------------------------------------------------------------------------------
CREATE TABLE dbo.mail_message (
    id                  uniqueidentifier NOT NULL CONSTRAINT PK_mail_message PRIMARY KEY DEFAULT NEWID(),
    company_id          varchar(20)      NOT NULL,
    graph_message_id    varchar(512)     NOT NULL,
    mailbox             varchar(320)     NOT NULL,
    sender              varchar(320)     NULL,
    received_at         datetime2(3)     NOT NULL,
    subject             nvarchar(1024)   NULL,
    processing_outcome  varchar(40)      NULL,
    failure_reason      nvarchar(2000)   NULL,
    created_at          datetime2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at          datetime2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_mail_message_graph_id UNIQUE (graph_message_id)
);

-------------------------------------------------------------------------------
-- mail_attachment : content-hash dedupe gives ingestion idempotency (§4)
-------------------------------------------------------------------------------
CREATE TABLE dbo.mail_attachment (
    id                   uniqueidentifier NOT NULL CONSTRAINT PK_mail_attachment PRIMARY KEY DEFAULT NEWID(),
    mail_message_id      uniqueidentifier NOT NULL,
    graph_attachment_id  varchar(512)     NOT NULL,
    content_hash         char(64)         NOT NULL,         -- sha256 hex
    blob_uri             varchar(1024)    NOT NULL,
    content_type         varchar(255)     NULL,
    ingestion_attempts   int              NOT NULL DEFAULT 0,
    created_at           datetime2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_mail_attachment_message FOREIGN KEY (mail_message_id) REFERENCES dbo.mail_message (id),
    CONSTRAINT UQ_mail_attachment_graph_id UNIQUE (graph_attachment_id),
    CONSTRAINT UQ_mail_attachment_content_hash UNIQUE (content_hash)
);

-------------------------------------------------------------------------------
-- source_document : the stored original + raw OCR payload
-------------------------------------------------------------------------------
CREATE TABLE dbo.source_document (
    id                  uniqueidentifier NOT NULL CONSTRAINT PK_source_document PRIMARY KEY DEFAULT NEWID(),
    mail_attachment_id  uniqueidentifier NOT NULL,
    company_id          varchar(20)      NOT NULL,
    classification      varchar(40)      NULL,
    blob_uri_original   varchar(1024)    NOT NULL,
    blob_uri_ocr        varchar(1024)    NULL,
    di_model_version    varchar(128)     NULL,
    created_at          datetime2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_source_document_attachment FOREIGN KEY (mail_attachment_id) REFERENCES dbo.mail_attachment (id),
    -- one source_document per attachment -> idempotent recordDocument
    CONSTRAINT UQ_source_document_attachment UNIQUE (mail_attachment_id)
);

-------------------------------------------------------------------------------
-- extracted_order : DI + Foundry raw, and the normalized PO (docs/04)
-------------------------------------------------------------------------------
CREATE TABLE dbo.extracted_order (
    id                    uniqueidentifier NOT NULL CONSTRAINT PK_extracted_order PRIMARY KEY DEFAULT NEWID(),
    source_document_id    uniqueidentifier NOT NULL,
    raw_extraction        nvarchar(max)    NOT NULL,
    normalized            nvarchar(max)    NOT NULL,
    foundry_model_version varchar(128)     NULL,
    overall_confidence    decimal(5,4)     NULL,
    created_at            datetime2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_extracted_order_document FOREIGN KEY (source_document_id) REFERENCES dbo.source_document (id),
    CONSTRAINT UQ_extracted_order_document UNIQUE (source_document_id),  -- idempotent saveProcessedOrder
    CONSTRAINT CK_extracted_order_raw_json  CHECK (ISJSON(raw_extraction) = 1),
    CONSTRAINT CK_extracted_order_norm_json CHECK (ISJSON(normalized) = 1)
);

-------------------------------------------------------------------------------
-- order_header : the business order (optimistic concurrency via row_version)
-------------------------------------------------------------------------------
CREATE TABLE dbo.order_header (
    id                       uniqueidentifier NOT NULL CONSTRAINT PK_order_header PRIMARY KEY DEFAULT NEWID(),
    extracted_order_id       uniqueidentifier NOT NULL,
    company_id               varchar(20)      NOT NULL,     -- dataAreaId
    source_channel           varchar(20)      NOT NULL DEFAULT 'EMAIL_PO',
    erp_customer_account     varchar(50)      NULL,         -- null until matched (Phase 3)
    customer_po_number       varchar(100)     NULL,
    normalized_po_number     varchar(100)     NULL,         -- dup-key component
    po_date                  date             NULL,
    requested_delivery_date  date             NULL,
    ship_to                  nvarchar(1024)   NULL,
    bill_to                  nvarchar(1024)   NULL,
    currency                 char(3)          NULL,
    total                    decimal(18,4)    NULL,
    line_count               int              NOT NULL DEFAULT 0,
    simple_status            varchar(20)      NOT NULL,
    internal_state           varchar(20)      NOT NULL,
    row_version              int              NOT NULL DEFAULT 0,
    created_at               datetime2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at               datetime2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_order_header_extracted FOREIGN KEY (extracted_order_id) REFERENCES dbo.extracted_order (id),
    CONSTRAINT UQ_order_header_extracted UNIQUE (extracted_order_id)  -- one order per extraction
);
CREATE INDEX IX_order_header_queue   ON dbo.order_header (company_id, internal_state);
CREATE INDEX IX_order_header_customer ON dbo.order_header (company_id, erp_customer_account, normalized_po_number);

-------------------------------------------------------------------------------
-- order_line
-------------------------------------------------------------------------------
CREATE TABLE dbo.order_line (
    id                 uniqueidentifier NOT NULL CONSTRAINT PK_order_line PRIMARY KEY DEFAULT NEWID(),
    order_header_id    uniqueidentifier NOT NULL,
    source_line_no     int              NULL,
    customer_item_code varchar(100)     NULL,
    erp_item_id        varchar(50)      NULL,              -- null until matched (Phase 3)
    quantity           decimal(18,4)    NULL,
    uom                varchar(20)      NULL,
    unit_price         decimal(18,4)    NULL,
    extended_amount    decimal(18,4)    NULL,
    requested_date     date             NULL,
    evidence           nvarchar(max)    NULL,
    CONSTRAINT FK_order_line_header FOREIGN KEY (order_header_id) REFERENCES dbo.order_header (id),
    CONSTRAINT CK_order_line_evidence_json CHECK (evidence IS NULL OR ISJSON(evidence) = 1)
);
CREATE INDEX IX_order_line_header ON dbo.order_line (order_header_id);

-------------------------------------------------------------------------------
-- order_validation : deterministic findings (errors vs warnings, blocking flag)
-------------------------------------------------------------------------------
CREATE TABLE dbo.order_validation (
    id              uniqueidentifier NOT NULL CONSTRAINT PK_order_validation PRIMARY KEY DEFAULT NEWID(),
    order_header_id uniqueidentifier NOT NULL,
    severity        varchar(10)      NOT NULL,            -- ERROR | WARNING
    code            varchar(80)      NOT NULL,
    field_path      varchar(200)     NULL,
    message         nvarchar(2000)   NULL,
    blocking        bit              NOT NULL,
    evaluated_at    datetime2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_order_validation_header FOREIGN KEY (order_header_id) REFERENCES dbo.order_header (id),
    CONSTRAINT CK_order_validation_severity CHECK (severity IN ('ERROR','WARNING'))
);
CREATE INDEX IX_order_validation_header ON dbo.order_validation (order_header_id);

-------------------------------------------------------------------------------
-- order_status_history : auditable state transitions (§9)
-------------------------------------------------------------------------------
CREATE TABLE dbo.order_status_history (
    id              uniqueidentifier NOT NULL CONSTRAINT PK_order_status_history PRIMARY KEY DEFAULT NEWID(),
    order_header_id uniqueidentifier NOT NULL,
    from_state      varchar(20)      NULL,
    to_state        varchar(20)      NOT NULL,
    actor           varchar(40)      NOT NULL,            -- user | system
    reason          nvarchar(1000)   NULL,
    at              datetime2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_order_status_history_header FOREIGN KEY (order_header_id) REFERENCES dbo.order_header (id)
);
CREATE INDEX IX_order_status_history_header ON dbo.order_status_history (order_header_id, at);

-------------------------------------------------------------------------------
-- duplicate_claim : THE atomic cross-channel reservation (spec §8, invariant #2)
--
-- The business key = normalized_po_number + erp_customer_account + company_id.
-- A FILTERED UNIQUE INDEX over rows in ('CLAIMED','RESOLVED') is the atomic guarantee:
-- exactly one claim can win a concurrent race; a released claim frees the key.
-------------------------------------------------------------------------------
CREATE TABLE dbo.duplicate_claim (
    id                   uniqueidentifier NOT NULL CONSTRAINT PK_duplicate_claim PRIMARY KEY DEFAULT NEWID(),
    company_id           varchar(20)      NOT NULL,
    business_key         varchar(220)     NOT NULL,       -- company::erp_acct::normalized_po
    order_header_id      uniqueidentifier NOT NULL,
    status               varchar(20)      NOT NULL,        -- CLAIMED | RELEASED | RESOLVED
    matched_existing_ref varchar(100)     NULL,
    matched_channel      varchar(10)      NULL,            -- EMAIL | EDI | AX
    claimed_at           datetime2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_duplicate_claim_header FOREIGN KEY (order_header_id) REFERENCES dbo.order_header (id),
    CONSTRAINT CK_duplicate_claim_status CHECK (status IN ('CLAIMED','RELEASED','RESOLVED'))
);
CREATE UNIQUE INDEX UX_duplicate_claim_active
    ON dbo.duplicate_claim (business_key)
    WHERE status IN ('CLAIMED','RESOLVED');

-------------------------------------------------------------------------------
-- audit_event : before/after record for RBAC-sensitive mutations (§3)
-------------------------------------------------------------------------------
CREATE TABLE dbo.audit_event (
    id          uniqueidentifier NOT NULL CONSTRAINT PK_audit_event PRIMARY KEY DEFAULT NEWID(),
    company_id  varchar(20)      NOT NULL,
    actor       varchar(80)      NOT NULL,
    action      varchar(80)      NOT NULL,
    target_type varchar(40)      NOT NULL,
    target_id   varchar(80)      NULL,
    before_json nvarchar(max)    NULL,
    after_json  nvarchar(max)    NULL,
    at          datetime2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_audit_before_json CHECK (before_json IS NULL OR ISJSON(before_json) = 1),
    CONSTRAINT CK_audit_after_json  CHECK (after_json  IS NULL OR ISJSON(after_json)  = 1)
);
CREATE INDEX IX_audit_event_target ON dbo.audit_event (company_id, target_type, target_id);
