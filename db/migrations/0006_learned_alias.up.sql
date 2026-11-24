-- 0006 — Learned alias memory (spec §6 "HISTORY matching").
-- Confirmed match corrections are promoted here: a customer_match teaches "seen name -> ERP account";
-- an item_match teaches "for this account, this item code -> ERP item". The learning-augmented
-- master reader overlays these onto the ERP masters so the matcher stops asking the CSR twice.

CREATE TABLE dbo.learned_alias (
    id                    uniqueidentifier NOT NULL PRIMARY KEY DEFAULT NEWID(),
    company_id           varchar(20)      NOT NULL,
    kind                 varchar(10)      NOT NULL,                 -- customer | item
    text_raw             nvarchar(400)    NOT NULL,                 -- the seen text (name / item code)
    text_norm            nvarchar(400)    NOT NULL,                 -- lower(trim(text)) for matching
    erp_customer_account varchar(50)      NULL,                     -- customer: target; item: scope
    erp_item_id          varchar(50)      NULL,                     -- item: target
    times_confirmed      int              NOT NULL DEFAULT 1,       -- how often a CSR reaffirmed it
    updated_at           datetime2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    -- NULL-safe uniqueness on (company, kind, account-scope, normalized text)
    erp_acct_key AS ISNULL(erp_customer_account, '') PERSISTED
);

CREATE UNIQUE INDEX UX_learned_alias ON dbo.learned_alias (company_id, kind, erp_acct_key, text_norm);
CREATE INDEX IX_learned_alias_company ON dbo.learned_alias (company_id);
