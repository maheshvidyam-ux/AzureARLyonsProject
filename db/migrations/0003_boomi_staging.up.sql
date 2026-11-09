/* =============================================================================
 * Migration 0003 — Boomi staging ("final tables") (UP)
 * Target: SQL database in Fabric (ADR 0003/0004).
 *
 * The destination Boomi polls to create AX sales orders. An order lands here ONLY when it is
 * clean + matched + duplicate-claimed (straight-through) or after a CSR corrects and approves
 * it. `publish_status` drives the Boomi hand-off: READY -> (Boomi claims) CLAIMED ->
 * (AX ack) COMPLETED / FAILED. One staging row per operational order (idempotent).
 *
 * NOTE: the exact canonical shape Boomi expects is Q-BOOMI-1; this is a faithful starting
 * shape built from the fields we persist. Co-located in the Fabric SQL DB so the publish is a
 * single transaction (ADR 0004 — a Lakehouse/Warehouse target would swap the write path).
 * ========================================================================== */

CREATE TABLE dbo.staging_sales_order (
    id                      uniqueidentifier NOT NULL CONSTRAINT PK_staging_sales_order PRIMARY KEY DEFAULT NEWID(),
    order_header_id         uniqueidentifier NOT NULL,
    data_area_id            varchar(20)      NOT NULL,     -- AX dataAreaId / legal entity
    erp_customer_account    varchar(50)      NULL,
    customer_po_number      varchar(100)     NULL,
    normalized_po_number    varchar(100)     NULL,
    po_date                 date             NULL,
    requested_delivery_date date             NULL,
    currency                char(3)          NULL,
    total                   decimal(18,4)    NULL,
    line_count              int              NOT NULL DEFAULT 0,
    publish_status          varchar(20)      NOT NULL DEFAULT 'READY',  -- READY | CLAIMED | COMPLETED | FAILED
    claimed_by              varchar(80)      NULL,
    claimed_at              datetime2(3)     NULL,
    ax_sales_order_id       varchar(60)      NULL,
    error_message           nvarchar(2000)   NULL,
    created_at              datetime2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at              datetime2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_staging_order_header FOREIGN KEY (order_header_id) REFERENCES dbo.order_header (id),
    CONSTRAINT UQ_staging_order_header UNIQUE (order_header_id),  -- one staging row per order (idempotent)
    CONSTRAINT CK_staging_status CHECK (publish_status IN ('READY','CLAIMED','COMPLETED','FAILED'))
);
CREATE INDEX IX_staging_sales_order_status ON dbo.staging_sales_order (publish_status, created_at);

CREATE TABLE dbo.staging_sales_order_line (
    id                  uniqueidentifier NOT NULL CONSTRAINT PK_staging_sales_order_line PRIMARY KEY DEFAULT NEWID(),
    staging_order_id    uniqueidentifier NOT NULL,
    line_no             int              NULL,
    erp_item_id         varchar(50)      NULL,
    customer_item_code  varchar(100)     NULL,
    quantity            decimal(18,4)    NULL,
    uom                 varchar(20)      NULL,
    unit_price          decimal(18,4)    NULL,
    requested_date      date             NULL,
    CONSTRAINT FK_staging_line_order FOREIGN KEY (staging_order_id) REFERENCES dbo.staging_sales_order (id)
);
CREATE INDEX IX_staging_line_order ON dbo.staging_sales_order_line (staging_order_id);
