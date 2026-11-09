/**
 * SQL-database-in-Fabric implementation of the Persistence port (ADR 0007). Real
 * parameterized T-SQL against the schema in db/migrations/0001_init.up.sql. Idempotency is
 * get-or-create inside a transaction, backed by the UNIQUE constraints in the schema, so a
 * replay creates no duplicate rows and concurrent inserts lose cleanly on the unique index.
 *
 * Live execution requires a provisioned dev/test Fabric SQL database; unit tests use the
 * in-memory store. Integration coverage is gated behind FABRIC_SQL_SERVER (see tests).
 */
import sql from "mssql";
import type {
  ClaimDuplicateInput,
  DuplicateChannel,
  DuplicateClaimResult,
  IngestionInput,
  IngestionResult,
  ListOrdersFilter,
  MailMessageRow,
  MarkFailedInput,
  OptimisticResult,
  OrderHeaderRow,
  OrderReviewDetail,
  OrderSummaryRow,
  Persistence,
  RecordDocumentInput,
  RecordDocumentResult,
  ReviewDecisionKind,
  SaveProcessedOrderInput,
  SaveProcessedOrderResult,
  SeedExternalClaimInput,
  UpdateOrderInput,
  ValidationRow,
} from "../ports.js";

export class FabricSqlPersistence implements Persistence {
  constructor(private readonly pool: sql.ConnectionPool) {}

  async ingest(input: IngestionInput): Promise<IngestionResult> {
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      const mailMessageId = await getOrCreateId(
        tx,
        "SELECT id FROM dbo.mail_message WHERE graph_message_id = @gid",
        (r) => r.input("gid", sql.VarChar(512), input.graphMessageId),
        `INSERT INTO dbo.mail_message (company_id, graph_message_id, mailbox, sender, received_at, subject)
         OUTPUT INSERTED.id
         VALUES (@company, @gid, @mailbox, @sender, @received, @subject)`,
        (r) =>
          r
            .input("company", sql.VarChar(20), input.companyId)
            .input("gid", sql.VarChar(512), input.graphMessageId)
            .input("mailbox", sql.VarChar(320), input.mailbox)
            .input("sender", sql.VarChar(320), input.sender)
            .input("received", sql.DateTime2, new Date(input.receivedAt))
            .input("subject", sql.NVarChar(1024), input.subject),
      );

      const att = await getOrCreateIdTracked(
        tx,
        "SELECT id FROM dbo.mail_attachment WHERE graph_attachment_id = @aid",
        (r) => r.input("aid", sql.VarChar(512), input.attachment.graphAttachmentId),
        `INSERT INTO dbo.mail_attachment (mail_message_id, graph_attachment_id, content_hash, blob_uri, content_type)
         OUTPUT INSERTED.id
         VALUES (@mid, @aid, @hash, @uri, @ctype)`,
        (r) =>
          r
            .input("mid", sql.UniqueIdentifier, mailMessageId)
            .input("aid", sql.VarChar(512), input.attachment.graphAttachmentId)
            .input("hash", sql.Char(64), input.attachment.contentHash)
            .input("uri", sql.VarChar(1024), input.attachment.blobUri)
            .input("ctype", sql.VarChar(255), input.attachment.contentType),
      );

      await tx.commit();
      return { mailMessageId, mailAttachmentId: att.id, created: att.created };
    } catch (e) {
      await safeRollback(tx);
      throw e;
    }
  }

  async recordDocument(input: RecordDocumentInput): Promise<RecordDocumentResult> {
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      const doc = await getOrCreateIdTracked(
        tx,
        "SELECT id FROM dbo.source_document WHERE mail_attachment_id = @aid",
        (r) => r.input("aid", sql.UniqueIdentifier, input.mailAttachmentId),
        `INSERT INTO dbo.source_document (mail_attachment_id, company_id, classification, blob_uri_original, blob_uri_ocr, di_model_version)
         OUTPUT INSERTED.id
         VALUES (@aid, @company, @class, @orig, @ocr, @di)`,
        (r) =>
          r
            .input("aid", sql.UniqueIdentifier, input.mailAttachmentId)
            .input("company", sql.VarChar(20), input.companyId)
            .input("class", sql.VarChar(40), input.classification ?? null)
            .input("orig", sql.VarChar(1024), input.blobUriOriginal)
            .input("ocr", sql.VarChar(1024), input.blobUriOcr ?? null)
            .input("di", sql.VarChar(128), input.diModelVersion ?? null),
      );
      await tx.commit();
      return { sourceDocumentId: doc.id, created: doc.created };
    } catch (e) {
      await safeRollback(tx);
      throw e;
    }
  }

  async markFailed(input: MarkFailedInput): Promise<void> {
    await this.pool
      .request()
      .input("id", sql.UniqueIdentifier, input.mailMessageId)
      .input("reason", sql.NVarChar(2000), input.reason)
      .query(
        `UPDATE dbo.mail_message
         SET processing_outcome = 'FAILED', failure_reason = @reason, updated_at = SYSUTCDATETIME()
         WHERE id = @id`,
      );
  }

  async saveProcessedOrder(input: SaveProcessedOrderInput): Promise<SaveProcessedOrderResult> {
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      const extractedOrderId = await getOrCreateId(
        tx,
        "SELECT id FROM dbo.extracted_order WHERE source_document_id = @sid",
        (r) => r.input("sid", sql.UniqueIdentifier, input.sourceDocumentId),
        `INSERT INTO dbo.extracted_order (source_document_id, raw_extraction, normalized, foundry_model_version, overall_confidence)
         OUTPUT INSERTED.id
         VALUES (@sid, @raw, @norm, @fmv, @conf)`,
        (r) =>
          r
            .input("sid", sql.UniqueIdentifier, input.sourceDocumentId)
            .input("raw", sql.NVarChar(sql.MAX), input.extraction.rawExtractionJson)
            .input("norm", sql.NVarChar(sql.MAX), input.extraction.normalizedJson)
            .input("fmv", sql.VarChar(128), input.extraction.foundryModelVersion ?? null)
            .input("conf", sql.Decimal(5, 4), input.extraction.overallConfidence ?? null),
      );

      // Idempotency: one order_header per extracted_order.
      const existing = await new sql.Request(tx)
        .input("eid", sql.UniqueIdentifier, extractedOrderId)
        .query("SELECT id FROM dbo.order_header WHERE extracted_order_id = @eid");
      if (existing.recordset.length > 0) {
        await tx.commit();
        return { extractedOrderId, orderHeaderId: existing.recordset[0].id, created: false };
      }

      const h = input.header;
      const headerRes = await new sql.Request(tx)
        .input("eid", sql.UniqueIdentifier, extractedOrderId)
        .input("company", sql.VarChar(20), input.companyId)
        .input("channel", sql.VarChar(20), h.sourceChannel)
        .input("erpAcct", sql.VarChar(50), h.erpCustomerAccount)
        .input("poNum", sql.VarChar(100), h.customerPoNumber)
        .input("normPo", sql.VarChar(100), h.normalizedPoNumber)
        .input("poDate", sql.Date, h.poDate ? new Date(h.poDate) : null)
        .input("reqDate", sql.Date, h.requestedDeliveryDate ? new Date(h.requestedDeliveryDate) : null)
        .input("shipTo", sql.NVarChar(1024), h.shipTo)
        .input("billTo", sql.NVarChar(1024), h.billTo)
        .input("currency", sql.Char(3), h.currency)
        .input("total", sql.Decimal(18, 4), h.total)
        .input("lineCount", sql.Int, h.lineCount)
        .input("simple", sql.VarChar(20), h.simpleStatus)
        .input("internal", sql.VarChar(20), h.internalState)
        .query(
          `INSERT INTO dbo.order_header
             (extracted_order_id, company_id, source_channel, erp_customer_account, customer_po_number,
              normalized_po_number, po_date, requested_delivery_date, ship_to, bill_to, currency, total,
              line_count, simple_status, internal_state)
           OUTPUT INSERTED.id
           VALUES (@eid, @company, @channel, @erpAcct, @poNum, @normPo, @poDate, @reqDate, @shipTo, @billTo,
                   @currency, @total, @lineCount, @simple, @internal)`,
        );
      const orderHeaderId: string = headerRes.recordset[0].id;

      for (const l of input.lines) {
        await new sql.Request(tx)
          .input("hid", sql.UniqueIdentifier, orderHeaderId)
          .input("lineNo", sql.Int, l.sourceLineNo)
          .input("code", sql.VarChar(100), l.customerItemCode)
          .input("erpItem", sql.VarChar(50), l.erpItemId)
          .input("qty", sql.Decimal(18, 4), l.quantity)
          .input("uom", sql.VarChar(20), l.uom)
          .input("price", sql.Decimal(18, 4), l.unitPrice)
          .input("ext", sql.Decimal(18, 4), l.extendedAmount)
          .input("reqDate", sql.Date, l.requestedDate ? new Date(l.requestedDate) : null)
          .input("evidence", sql.NVarChar(sql.MAX), l.evidenceJson)
          .query(
            `INSERT INTO dbo.order_line
               (order_header_id, source_line_no, customer_item_code, erp_item_id, quantity, uom,
                unit_price, extended_amount, requested_date, evidence)
             VALUES (@hid, @lineNo, @code, @erpItem, @qty, @uom, @price, @ext, @reqDate, @evidence)`,
          );
      }

      for (const v of input.validation) {
        await new sql.Request(tx)
          .input("hid", sql.UniqueIdentifier, orderHeaderId)
          .input("sev", sql.VarChar(10), v.severity)
          .input("code", sql.VarChar(80), v.code)
          .input("fp", sql.VarChar(200), v.fieldPath)
          .input("msg", sql.NVarChar(2000), v.message)
          .input("blocking", sql.Bit, v.blocking)
          .query(
            `INSERT INTO dbo.order_validation (order_header_id, severity, code, field_path, message, blocking)
             VALUES (@hid, @sev, @code, @fp, @msg, @blocking)`,
          );
      }

      const sh = input.statusHistory;
      await new sql.Request(tx)
        .input("hid", sql.UniqueIdentifier, orderHeaderId)
        .input("from", sql.VarChar(20), sh.fromState)
        .input("to", sql.VarChar(20), sh.toState)
        .input("actor", sql.VarChar(40), sh.actor)
        .input("reason", sql.NVarChar(1000), sh.reason)
        .query(
          `INSERT INTO dbo.order_status_history (order_header_id, from_state, to_state, actor, reason)
           VALUES (@hid, @from, @to, @actor, @reason)`,
        );

      await tx.commit();
      return { extractedOrderId, orderHeaderId, created: true };
    } catch (e) {
      await safeRollback(tx);
      throw e;
    }
  }

  async claimDuplicate(input: ClaimDuplicateInput): Promise<DuplicateClaimResult> {
    try {
      const res = await this.pool
        .request()
        .input("company", sql.VarChar(20), input.companyId)
        .input("bk", sql.VarChar(220), input.businessKey)
        .input("oh", sql.UniqueIdentifier, input.orderHeaderId)
        .input("ref", sql.VarChar(100), input.matchedExistingRef ?? null)
        .input("chan", sql.VarChar(10), input.channel)
        .query(
          `INSERT INTO dbo.duplicate_claim (company_id, business_key, order_header_id, status, matched_existing_ref, matched_channel)
           OUTPUT INSERTED.id
           VALUES (@company, @bk, @oh, 'CLAIMED', @ref, @chan)`,
        );
      return { status: "CLAIMED", claimId: res.recordset[0].id };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // Lost the race / key already held — read the winning claim for cross-channel context.
      const existing = await this.pool
        .request()
        .input("bk", sql.VarChar(220), input.businessKey)
        .query(
          `SELECT TOP 1 id, order_header_id, matched_channel, matched_existing_ref
           FROM dbo.duplicate_claim WHERE business_key = @bk AND status IN ('CLAIMED','RESOLVED')`,
        );
      const r = existing.recordset[0];
      // Re-claim by the same order is idempotent (not a duplicate).
      if (r && String(r.order_header_id).toLowerCase() === input.orderHeaderId.toLowerCase()) {
        return { status: "CLAIMED", claimId: r.id };
      }
      return {
        status: "COLLISION",
        matchedChannel: (r?.matched_channel ?? null) as DuplicateChannel | null,
        matchedExistingRef: r?.matched_existing_ref ?? null,
      };
    }
  }

  async seedExternalClaim(input: SeedExternalClaimInput): Promise<void> {
    await this.pool
      .request()
      .input("company", sql.VarChar(20), input.companyId)
      .input("bk", sql.VarChar(220), input.businessKey)
      .input("ref", sql.VarChar(100), input.matchedExistingRef ?? null)
      .input("chan", sql.VarChar(10), input.channel)
      .query(
        `INSERT INTO dbo.duplicate_claim (company_id, business_key, order_header_id, status, matched_existing_ref, matched_channel)
         VALUES (@company, @bk, NULL, 'CLAIMED', @ref, @chan)`,
      );
  }

  async markDuplicateReview(orderHeaderId: string, detail: string): Promise<void> {
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      await new sql.Request(tx)
        .input("id", sql.UniqueIdentifier, orderHeaderId)
        .query(
          `UPDATE dbo.order_header SET internal_state = 'DUPLICATE_REVIEW', simple_status = 'Needs Review', updated_at = SYSUTCDATETIME() WHERE id = @id`,
        );
      await new sql.Request(tx)
        .input("id", sql.UniqueIdentifier, orderHeaderId)
        .input("msg", sql.NVarChar(2000), detail)
        .query(
          `INSERT INTO dbo.order_validation (order_header_id, severity, code, field_path, message, blocking)
           VALUES (@id, 'ERROR', 'DUPLICATE_DETECTED', NULL, @msg, 1)`,
        );
      await new sql.Request(tx)
        .input("id", sql.UniqueIdentifier, orderHeaderId)
        .query(
          `INSERT INTO dbo.order_status_history (order_header_id, from_state, to_state, actor, reason)
           VALUES (@id, 'READY', 'DUPLICATE_REVIEW', 'system', 'duplicate business key')`,
        );
      await tx.commit();
    } catch (e) {
      await safeRollback(tx);
      throw e;
    }
  }

  async listOrders(filter: ListOrdersFilter): Promise<OrderSummaryRow[]> {
    const top = Math.max(1, Math.min(filter.limit ?? 100, 500));
    const res = await this.pool
      .request()
      .input("company", sql.VarChar(20), filter.companyId ?? null)
      .input("state", sql.VarChar(20), filter.internalState ?? null)
      .query(
        `SELECT TOP (${top}) id, company_id, customer_po_number, normalized_po_number, erp_customer_account,
                simple_status, internal_state, total, line_count, row_version
         FROM dbo.order_header
         WHERE (@company IS NULL OR company_id = @company)
           AND (@state IS NULL OR internal_state = @state)
         ORDER BY created_at DESC`,
      );
    return res.recordset.map((r) => ({
      id: r.id,
      companyId: r.company_id,
      customerPoNumber: r.customer_po_number,
      normalizedPoNumber: r.normalized_po_number,
      erpCustomerAccount: r.erp_customer_account,
      simpleStatus: r.simple_status,
      internalState: r.internal_state,
      total: r.total,
      lineCount: r.line_count,
      rowVersion: r.row_version,
    }));
  }

  async getOrderForReview(orderHeaderId: string): Promise<OrderReviewDetail | null> {
    const hRes = await this.pool
      .request()
      .input("id", sql.UniqueIdentifier, orderHeaderId)
      .query(
        `SELECT h.id, h.company_id, h.source_channel, h.customer_po_number, h.normalized_po_number,
                h.erp_customer_account, h.po_date, h.ship_to, h.bill_to, h.currency, h.total,
                h.simple_status, h.internal_state, h.row_version, e.normalized
         FROM dbo.order_header h JOIN dbo.extracted_order e ON e.id = h.extracted_order_id
         WHERE h.id = @id`,
      );
    const r = hRes.recordset[0];
    if (!r) return null;

    const [lines, validation] = await Promise.all([
      this.pool.request().input("id", sql.UniqueIdentifier, orderHeaderId).query(
        `SELECT id, source_line_no, customer_item_code, erp_item_id, quantity, uom, unit_price, extended_amount
         FROM dbo.order_line WHERE order_header_id = @id ORDER BY source_line_no`,
      ),
      this.getValidationByOrderId(orderHeaderId),
    ]);

    let normalized: unknown = null;
    try {
      normalized = r.normalized ? JSON.parse(r.normalized) : null;
    } catch {
      normalized = null;
    }

    return {
      header: {
        id: r.id,
        companyId: r.company_id,
        sourceChannel: r.source_channel,
        customerPoNumber: r.customer_po_number,
        normalizedPoNumber: r.normalized_po_number,
        erpCustomerAccount: r.erp_customer_account,
        poDate: r.po_date ? toDateString(r.po_date) : null,
        shipTo: r.ship_to,
        billTo: r.bill_to,
        currency: r.currency,
        total: r.total,
        simpleStatus: r.simple_status,
        internalState: r.internal_state,
        rowVersion: r.row_version,
      },
      lines: lines.recordset.map((l) => ({
        lineId: l.id,
        sourceLineNo: l.source_line_no,
        customerItemCode: l.customer_item_code,
        erpItemId: l.erp_item_id,
        quantity: l.quantity,
        uom: l.uom,
        unitPrice: l.unit_price,
        extendedAmount: l.extended_amount,
      })),
      validation,
      normalized,
    };
  }

  async updateOrderFields(orderHeaderId: string, expectedRowVersion: number, patch: UpdateOrderInput, actor: string): Promise<OptimisticResult> {
    const current = await this.getOrderForReview(orderHeaderId);
    if (!current) return { status: "NOT_FOUND" };
    if (current.header.rowVersion !== expectedRowVersion) return { status: "CONFLICT", rowVersion: current.header.rowVersion };

    const h = { ...current.header, ...(patch.header ?? {}) };
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      const upd = await new sql.Request(tx)
        .input("id", sql.UniqueIdentifier, orderHeaderId)
        .input("exp", sql.Int, expectedRowVersion)
        .input("erpAcct", sql.VarChar(50), h.erpCustomerAccount)
        .input("poNum", sql.VarChar(100), h.customerPoNumber)
        .input("poDate", sql.Date, h.poDate ? new Date(h.poDate) : null)
        .input("shipTo", sql.NVarChar(1024), h.shipTo)
        .input("billTo", sql.NVarChar(1024), h.billTo)
        .input("currency", sql.Char(3), h.currency)
        .input("total", sql.Decimal(18, 4), h.total)
        .query(
          `UPDATE dbo.order_header
             SET erp_customer_account=@erpAcct, customer_po_number=@poNum, po_date=@poDate, ship_to=@shipTo,
                 bill_to=@billTo, currency=@currency, total=@total, row_version = row_version + 1, updated_at = SYSUTCDATETIME()
           WHERE id=@id AND row_version=@exp`,
        );
      if ((upd.rowsAffected[0] ?? 0) === 0) {
        await safeRollback(tx);
        return { status: "CONFLICT", rowVersion: current.header.rowVersion };
      }

      for (const lp of patch.lines ?? []) {
        const cur = current.lines.find((l) => l.lineId === lp.lineId);
        if (!cur) continue;
        await new sql.Request(tx)
          .input("id", sql.UniqueIdentifier, lp.lineId)
          .input("erpItem", sql.VarChar(50), lp.erpItemId !== undefined ? lp.erpItemId : cur.erpItemId)
          .input("qty", sql.Decimal(18, 4), lp.quantity !== undefined ? lp.quantity : cur.quantity)
          .input("uom", sql.VarChar(20), lp.uom !== undefined ? lp.uom : cur.uom)
          .input("price", sql.Decimal(18, 4), lp.unitPrice !== undefined ? lp.unitPrice : cur.unitPrice)
          .query(`UPDATE dbo.order_line SET erp_item_id=@erpItem, quantity=@qty, uom=@uom, unit_price=@price WHERE id=@id`);
      }

      await insertAudit(tx, current.header.companyId, actor, "ORDER_EDIT", orderHeaderId, JSON.stringify(patch));
      await tx.commit();
      return { status: "OK", rowVersion: expectedRowVersion + 1 };
    } catch (e) {
      await safeRollback(tx);
      throw e;
    }
  }

  async reviewDecision(orderHeaderId: string, decision: ReviewDecisionKind, expectedRowVersion: number, actor: string): Promise<OptimisticResult> {
    const current = await this.getOrderForReview(orderHeaderId);
    if (!current) return { status: "NOT_FOUND" };
    if (current.header.rowVersion !== expectedRowVersion) return { status: "CONFLICT", rowVersion: current.header.rowVersion };

    const internal = decision === "APPROVE" ? "READY" : "REJECTED";
    const simple = decision === "APPROVE" ? "Ready" : "Rejected";
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      const upd = await new sql.Request(tx)
        .input("id", sql.UniqueIdentifier, orderHeaderId)
        .input("exp", sql.Int, expectedRowVersion)
        .input("s", sql.VarChar(20), internal)
        .input("ss", sql.VarChar(20), simple)
        .query(
          `UPDATE dbo.order_header SET internal_state=@s, simple_status=@ss, row_version = row_version + 1, updated_at = SYSUTCDATETIME()
           WHERE id=@id AND row_version=@exp`,
        );
      if ((upd.rowsAffected[0] ?? 0) === 0) {
        await safeRollback(tx);
        return { status: "CONFLICT", rowVersion: current.header.rowVersion };
      }
      await new sql.Request(tx)
        .input("id", sql.UniqueIdentifier, orderHeaderId)
        .input("from", sql.VarChar(20), current.header.internalState)
        .input("to", sql.VarChar(20), internal)
        .input("actor", sql.VarChar(40), actor)
        .query(
          `INSERT INTO dbo.order_status_history (order_header_id, from_state, to_state, actor, reason)
           VALUES (@id, @from, @to, @actor, 'reviewer decision')`,
        );
      await insertAudit(tx, current.header.companyId, actor, decision === "APPROVE" ? "ORDER_APPROVE" : "ORDER_REJECT", orderHeaderId, null);
      await tx.commit();
      return { status: "OK", rowVersion: expectedRowVersion + 1 };
    } catch (e) {
      await safeRollback(tx);
      throw e;
    }
  }

  async getOrderHeaderById(id: string): Promise<OrderHeaderRow | null> {
    const res = await this.pool
      .request()
      .input("id", sql.UniqueIdentifier, id)
      .query(
        `SELECT id, company_id, internal_state, simple_status, normalized_po_number,
                erp_customer_account, total, line_count
         FROM dbo.order_header WHERE id = @id`,
      );
    const r = res.recordset[0];
    if (!r) return null;
    return {
      id: r.id,
      companyId: r.company_id,
      internalState: r.internal_state,
      simpleStatus: r.simple_status,
      normalizedPoNumber: r.normalized_po_number,
      erpCustomerAccount: r.erp_customer_account,
      total: r.total,
      lineCount: r.line_count,
    };
  }

  async getValidationByOrderId(orderHeaderId: string): Promise<ValidationRow[]> {
    const res = await this.pool
      .request()
      .input("hid", sql.UniqueIdentifier, orderHeaderId)
      .query(
        `SELECT code, severity, blocking, field_path FROM dbo.order_validation WHERE order_header_id = @hid`,
      );
    return res.recordset.map((r) => ({
      code: r.code,
      severity: r.severity,
      blocking: Boolean(r.blocking),
      fieldPath: r.field_path,
    }));
  }

  async getMailMessageById(id: string): Promise<MailMessageRow | null> {
    const res = await this.pool
      .request()
      .input("id", sql.UniqueIdentifier, id)
      .query(`SELECT id, processing_outcome, failure_reason FROM dbo.mail_message WHERE id = @id`);
    const r = res.recordset[0];
    if (!r) return null;
    return { id: r.id, processingOutcome: r.processing_outcome, failureReason: r.failure_reason };
  }

  async countOrders(): Promise<number> {
    const res = await this.pool.request().query("SELECT COUNT(*) AS n FROM dbo.order_header");
    return res.recordset[0].n as number;
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}

type BindFn = (r: sql.Request) => sql.Request;

/** SELECT-then-INSERT get-or-create returning the id (created flag discarded). */
async function getOrCreateId(
  tx: sql.Transaction,
  selectSql: string,
  bindSelect: BindFn,
  insertSql: string,
  bindInsert: BindFn,
): Promise<string> {
  return (await getOrCreateIdTracked(tx, selectSql, bindSelect, insertSql, bindInsert)).id;
}

async function getOrCreateIdTracked(
  tx: sql.Transaction,
  selectSql: string,
  bindSelect: BindFn,
  insertSql: string,
  bindInsert: BindFn,
): Promise<{ id: string; created: boolean }> {
  const found = await bindSelect(new sql.Request(tx)).query(selectSql);
  if (found.recordset.length > 0) return { id: found.recordset[0].id, created: false };
  const inserted = await bindInsert(new sql.Request(tx)).query(insertSql);
  return { id: inserted.recordset[0].id, created: true };
}

async function insertAudit(
  tx: sql.Transaction,
  companyId: string,
  actor: string,
  action: string,
  targetId: string,
  afterJson: string | null,
): Promise<void> {
  await new sql.Request(tx)
    .input("company", sql.VarChar(20), companyId)
    .input("actor", sql.VarChar(80), actor)
    .input("action", sql.VarChar(80), action)
    .input("ttype", sql.VarChar(40), "order_header")
    .input("tid", sql.VarChar(80), targetId)
    .input("after", sql.NVarChar(sql.MAX), afterJson)
    .query(
      `INSERT INTO dbo.audit_event (company_id, actor, action, target_type, target_id, after_json)
       VALUES (@company, @actor, @action, @ttype, @tid, @after)`,
    );
}

/** Format a mssql Date/datetime value as YYYY-MM-DD. */
function toDateString(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().slice(0, 10);
}

/** SQL Server unique-constraint / unique-index violation error numbers. */
function isUniqueViolation(e: unknown): boolean {
  const n = (e as { number?: number }).number;
  return n === 2601 || n === 2627;
}

async function safeRollback(tx: sql.Transaction): Promise<void> {
  try {
    await tx.rollback();
  } catch {
    /* already rolled back / aborted */
  }
}
