# ADR 0008 — AP Invoice Automation as a second module

**Status:** Proposed (2026-11-09). Scope expansion: the platform now covers **AR order** *and*
**AP invoice** automation. Project renamed to **AzureARAP…**.

## Context
The platform automates customer purchase orders (AR). Lyons also wants to automate **vendor invoices
(AP)** — email in → extract → validate/match → review → post to Dynamics AX via Boomi. AP is the same
*shape* of problem as AR, so it should reuse the platform rather than fork it. The `module_code` seam
(spec §10) was built for exactly this.

## Decision
Add **`AP_INVOICE`** as a second module alongside **`ORDER_PROCESSING`**, sharing one pipeline. Every
operational/learning/audit row carries `module_code` so the modules never cross-contaminate (module-
scoped, **not** multi-tenant).

### Shared as-is (no duplication)
- Microsoft Graph **ingestion** + webhook + the ingestion worker.
- **Blob** original-document storage.
- **Document Intelligence + AI Foundry** extraction clients (different model/prompt per module).
- **Reviewer workbench** API + UI (document-left / canonical-right, corrections, approve).
- **Persistence** (SQL database in Fabric), **Service Bus**, **Boomi staging** hand-off + ack.
- Optimistic concurrency, RBAC, audit, learning store.

### Module-specific (the deltas to build)
| Concern | AR `ORDER_PROCESSING` | AP `AP_INVOICE` |
|---|---|---|
| Document | Customer PO | Vendor invoice |
| Canonical schema | NormalizedPurchaseOrder (docs/04) | **NormalizedInvoice** (new): vendor, invoice #, invoice date, PO ref, currency, tax, lines (GL/item, qty, price), totals |
| Party match | **Customer** (ax_custmaster) | **Vendor** (ax_vendmaster) |
| Line match | Item (ax_itemmaster) | **PO line / item / GL account** |
| Core validation | item/UOM/price, atomic PO dup claim | **2-way/3-way match** (invoice ↔ PO ↔ receipt), invoice-number dup prevention, tax/total reconciliation |
| Dedup key | normalized_po + cust_acct + company | **vendor_acct + normalized_invoice_no + company** |
| AX target (via Boomi) | sales order | **vendor invoice / AP voucher** |
| Staging table | `staging_sales_order` | **`staging_vendor_invoice`** |

## Consequences
- Pipeline ports stay; AR-specific pieces (po-schema, customer/item matching, PO dup key, sales-order
  staging) get an AP sibling (invoice-schema, vendor/PO matching, invoice dup key, voucher staging).
- `MODULE_CODE` becomes a union (`ORDER_PROCESSING | AP_INVOICE`); routing by module at ingestion
  (classifier decides PO vs invoice) and in persistence/staging.
- The reviewer UI gains an invoice view (vendor, invoice #, 3-way-match status) reusing the same shell.

## Open decisions (confirm before building)
1. **Matching depth:** 2-way (invoice↔PO) or full **3-way** (invoice↔PO↔goods receipt)? Where do PO +
   receipt data live (Fabric `gold.ax_*`)?
2. **AX target:** pending vendor invoice vs AP voucher/journal — which Boomi subprocess posts it?
3. **Non-PO invoices** (expense/GL-coded) in scope, or PO-backed only to start?
4. **Invoice dedup rule** (vendor + invoice number normalization).
5. Separate intake mailbox for AP (`ap-invoices@…`) vs one mailbox + classifier routing.
