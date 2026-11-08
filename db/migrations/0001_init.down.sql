/* =============================================================================
 * Migration 0001 — operational baseline (DOWN / rollback)
 * Target: SQL database in Fabric (ADR 0007). Drop in reverse dependency order.
 * ========================================================================== */

DROP INDEX IF EXISTS UX_duplicate_claim_active ON dbo.duplicate_claim;

DROP TABLE IF EXISTS dbo.audit_event;
DROP TABLE IF EXISTS dbo.duplicate_claim;
DROP TABLE IF EXISTS dbo.order_status_history;
DROP TABLE IF EXISTS dbo.order_validation;
DROP TABLE IF EXISTS dbo.order_line;
DROP TABLE IF EXISTS dbo.order_header;
DROP TABLE IF EXISTS dbo.extracted_order;
DROP TABLE IF EXISTS dbo.source_document;
DROP TABLE IF EXISTS dbo.mail_attachment;
DROP TABLE IF EXISTS dbo.mail_message;
