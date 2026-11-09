/* =============================================================================
 * Migration 0002 — allow external (EDI/AX) duplicate claims (DOWN)
 *
 * Revert order_header_id to NOT NULL. Any external (NULL-order) claims must be removed first
 * or the ALTER will fail — intentional: rolling back means external claims are unsupported.
 * ========================================================================== */

DELETE FROM dbo.duplicate_claim WHERE order_header_id IS NULL;
ALTER TABLE dbo.duplicate_claim ALTER COLUMN order_header_id uniqueidentifier NOT NULL;
