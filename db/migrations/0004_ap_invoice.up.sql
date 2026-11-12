/* =============================================================================
 * Migration 0004 — AP invoice operational + staging tables (UP)
 * Target: SQL database in Fabric (AP_INVOICE module, ADR 0008).
 *
 * Mirrors the AR order tables for vendor invoices. Idempotent on the document content hash.
 * Invoice dedup reuses dbo.duplicate_claim (module-qualified business_key `AP::...`), so the
 * same vendor invoice can never be posted to AX twice. Boomi picks up from
 * dbo.staging_vendor_invoice to create AX vendor invoices / AP vouchers.
 * ========================================================================== */

CREATE TABLE dbo.ap_invoice_header (
    id                        uniqueidentifier NOT NULL CONSTRAINT PK_ap_invoice_header PRIMARY KEY DEFAULT NEWID(),
    source_hash               char(64)         NOT NULL,          -- content hash → idempotency
    module_code               varchar(20)      NOT NULL DEFAULT 'AP_INVOICE',
    company_id                varchar(20)      NOT NULL,          -- dataAreaId
    invoice_type              varchar(10)      NOT NULL,          -- PO_BASED | NON_PO
    erp_vendor_account        varchar(50)      NULL,
    vendor_name               nvarchar(512)    NULL,
    invoice_number            varchar(100)     NULL,
    normalized_invoice_number varchar(100)     NULL,
    po_number                 varchar(100)     NULL,
    invoice_date              date             NULL,
    currency                  char(3)          NULL,
    subtotal                  decimal(18,4)    NULL,
    tax                       decimal(18,4)    NULL,
    grand_total               decimal(18,4)    NULL,
    line_count                int              NOT NULL DEFAULT 0,
    simple_status             varchar(20)      NOT NULL,
    internal_state            varchar(20)      NOT NULL,
    raw_extraction            nvarchar(max)    NULL,
    normalized                nvarchar(max)    NULL,
    overall_confidence        decimal(5,4)     NULL,
    blob_uri                  varchar(1024)    NULL,
    row_version               int              NOT NULL DEFAULT 0,
    created_at                datetime2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at                datetime2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_ap_invoice_source_hash UNIQUE (source_hash),  -- idempotent save
    CONSTRAINT CK_ap_invoice_type CHECK (invoice_type IN ('PO_BASED','NON_PO')),
    CONSTRAINT CK_ap_invoice_raw_json  CHECK (raw_extraction IS NULL OR ISJSON(raw_extraction) = 1),
    CONSTRAINT CK_ap_invoice_norm_json CHECK (normalized IS NULL OR ISJSON(normalized) = 1)
);
CREATE INDEX IX_ap_invoice_queue  ON dbo.ap_invoice_header (company_id, internal_state);
CREATE INDEX IX_ap_invoice_vendor ON dbo.ap_invoice_header (company_id, erp_vendor_account, normalized_invoice_number);

CREATE TABLE dbo.ap_invoice_line (
    id                    uniqueidentifier NOT NULL CONSTRAINT PK_ap_invoice_line PRIMARY KEY DEFAULT NEWID(),
    ap_invoice_header_id  uniqueidentifier NOT NULL,
    source_line_no        int              NULL,
    po_line_ref           varchar(50)      NULL,
    erp_item_id           varchar(50)      NULL,
    gl_account            varchar(50)      NULL,
    description           nvarchar(512)    NULL,
    quantity              decimal(18,4)    NULL,
    uom                   varchar(20)      NULL,
    unit_price            decimal(18,4)    NULL,
    amount                decimal(18,4)    NULL,
    match_status          varchar(30)      NULL,
    is_code_and_approve   bit              NOT NULL DEFAULT 0,
    CONSTRAINT FK_ap_invoice_line_header FOREIGN KEY (ap_invoice_header_id) REFERENCES dbo.ap_invoice_header (id)
);
CREATE INDEX IX_ap_invoice_line_header ON dbo.ap_invoice_line (ap_invoice_header_id);

CREATE TABLE dbo.ap_invoice_validation (
    id                    uniqueidentifier NOT NULL CONSTRAINT PK_ap_invoice_validation PRIMARY KEY DEFAULT NEWID(),
    ap_invoice_header_id  uniqueidentifier NOT NULL,
    severity              varchar(10)      NOT NULL,
    code                  varchar(80)      NOT NULL,
    field_path            varchar(200)     NULL,
    message               nvarchar(2000)   NULL,
    blocking              bit              NOT NULL,
    evaluated_at          datetime2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_ap_invoice_validation_header FOREIGN KEY (ap_invoice_header_id) REFERENCES dbo.ap_invoice_header (id)
);
CREATE INDEX IX_ap_invoice_validation_header ON dbo.ap_invoice_validation (ap_invoice_header_id);

-- Boomi "final tables" for AP vouchers.
CREATE TABLE dbo.staging_vendor_invoice (
    id                        uniqueidentifier NOT NULL CONSTRAINT PK_staging_vendor_invoice PRIMARY KEY DEFAULT NEWID(),
    ap_invoice_header_id      uniqueidentifier NOT NULL,
    data_area_id              varchar(20)      NOT NULL,
    invoice_type              varchar(10)      NOT NULL,
    erp_vendor_account        varchar(50)      NULL,
    invoice_number            varchar(100)     NULL,
    normalized_invoice_number varchar(100)     NULL,
    po_number                 varchar(100)     NULL,
    invoice_date              date             NULL,
    currency                  char(3)          NULL,
    grand_total               decimal(18,4)    NULL,
    line_count                int              NOT NULL DEFAULT 0,
    publish_status            varchar(20)      NOT NULL DEFAULT 'READY',
    claimed_by                varchar(80)      NULL,
    claimed_at                datetime2(3)     NULL,
    ax_voucher_id             varchar(60)      NULL,
    error_message             nvarchar(2000)   NULL,
    created_at                datetime2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at                datetime2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_staging_vendor_invoice_header FOREIGN KEY (ap_invoice_header_id) REFERENCES dbo.ap_invoice_header (id),
    CONSTRAINT UQ_staging_vendor_invoice_header UNIQUE (ap_invoice_header_id),
    CONSTRAINT CK_staging_vendor_invoice_status CHECK (publish_status IN ('READY','CLAIMED','COMPLETED','FAILED'))
);
CREATE INDEX IX_staging_vendor_invoice_status ON dbo.staging_vendor_invoice (publish_status, created_at);

CREATE TABLE dbo.staging_vendor_invoice_line (
    id                 uniqueidentifier NOT NULL CONSTRAINT PK_staging_vendor_invoice_line PRIMARY KEY DEFAULT NEWID(),
    staging_invoice_id uniqueidentifier NOT NULL,
    line_no            int              NULL,
    po_line_ref        varchar(50)      NULL,
    erp_item_id        varchar(50)      NULL,
    gl_account         varchar(50)      NULL,
    quantity           decimal(18,4)    NULL,
    uom                varchar(20)      NULL,
    unit_price         decimal(18,4)    NULL,
    amount             decimal(18,4)    NULL,
    CONSTRAINT FK_staging_vendor_invoice_line_order FOREIGN KEY (staging_invoice_id) REFERENCES dbo.staging_vendor_invoice (id)
);
CREATE INDEX IX_staging_vendor_invoice_line ON dbo.staging_vendor_invoice_line (staging_invoice_id);
