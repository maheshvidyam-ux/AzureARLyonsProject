/* =============================================================================
 * Migration 0002 — allow external (EDI/AX) duplicate claims (UP)
 * Target: SQL database in Fabric (ADR 0007).
 *
 * Cross-channel coordination (spec §8, Q-BOOMI-3/Q-AX-1) requires registering a claim for
 * an order that originated in EDI or AX and has NO local order_header. Make the FK column
 * nullable so such external claims can hold the business key against the same filtered unique
 * index that blocks Email duplicates.
 * ========================================================================== */

ALTER TABLE dbo.duplicate_claim ALTER COLUMN order_header_id uniqueidentifier NULL;
