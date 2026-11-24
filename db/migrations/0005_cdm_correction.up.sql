-- 0005 — CDM correction capture (the learning dataset).
-- Every reviewer edit to the canonical model is recorded here as a field-level (original -> corrected)
-- row with enough CONTEXT (customer name, item code/description) for the learning layer to build
-- alias/mapping memory and few-shot examples. Append-only; one row per changed field per edit.

CREATE TABLE dbo.cdm_correction (
    id              uniqueidentifier NOT NULL PRIMARY KEY DEFAULT NEWID(),
    company_id      varchar(20)      NOT NULL,
    module_code     varchar(40)      NOT NULL DEFAULT 'ORDER_PROCESSING',
    order_header_id uniqueidentifier NOT NULL,
    line_id         uniqueidentifier NULL,
    entity          varchar(10)      NOT NULL,   -- header | line
    field_path      varchar(200)     NOT NULL,   -- e.g. header.erp_customer_account, line.erp_item_id
    original_value  nvarchar(400)    NULL,       -- model-extracted value (may be NULL)
    corrected_value nvarchar(400)    NULL,       -- CSR-corrected value
    kind            varchar(20)      NOT NULL,   -- customer_match | item_match | value | format
    context_json    nvarchar(max)    NULL,       -- keys the learning layer maps FROM
    actor           varchar(80)      NOT NULL,
    at              datetime2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_cdm_correction_order FOREIGN KEY (order_header_id) REFERENCES dbo.order_header(id)
);

-- Learning-layer read paths: by company+kind (build aliases), and by order (audit a document).
CREATE INDEX IX_cdm_correction_company_kind ON dbo.cdm_correction (company_id, kind, at DESC);
CREATE INDEX IX_cdm_correction_order ON dbo.cdm_correction (order_header_id);
