/* =============================================================================
 * Migration 0004 — AP invoice tables (DOWN). Drop in reverse dependency order.
 * ========================================================================== */
DROP TABLE IF EXISTS dbo.staging_vendor_invoice_line;
DROP TABLE IF EXISTS dbo.staging_vendor_invoice;
DROP TABLE IF EXISTS dbo.ap_invoice_validation;
DROP TABLE IF EXISTS dbo.ap_invoice_line;
DROP TABLE IF EXISTS dbo.ap_invoice_header;
