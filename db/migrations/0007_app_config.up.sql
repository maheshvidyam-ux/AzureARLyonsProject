-- 0007 — Application config (admin-managed connection coordinates).
-- Holds NON-SECRET connection coordinates the admin screens edit at runtime: the ERP Lakehouse
-- server/database + table & column mappings, and AI endpoint names. Auth everywhere is Entra
-- (managed identity), so no credentials are stored here; true secrets belong in Key Vault.
-- One JSON document per config_key (e.g. 'connections').

CREATE TABLE dbo.app_config (
    config_key  varchar(100)  NOT NULL PRIMARY KEY,
    config_json nvarchar(max) NOT NULL,
    updated_by  varchar(80)   NOT NULL,
    updated_at  datetime2(3)  NOT NULL DEFAULT SYSUTCDATETIME()
);
