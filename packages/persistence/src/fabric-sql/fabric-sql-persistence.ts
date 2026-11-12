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
  ClaimInvoiceInput,
  DuplicateChannel,
  DuplicateClaimResult,
  IngestionInput,
  SaveInvoiceInput,
  SaveInvoiceResult,
  StagedVendorInvoiceRow,
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
  StageOrderResult,
  StagedOrderRow,
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

    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      // Optimistic bump (state set below / via staging).
      const upd = await new sql.Request(tx)
        .input("id", sql.UniqueIdentifier, orderHeaderId)
        .input("exp", sql.Int, expectedRowVersion)
        .input("s", sql.VarChar(20), decision === "REJECT" ? "REJECTED" : current.header.internalState)
        .input("ss", sql.VarChar(20), decision === "REJECT" ? "Rejected" : current.header.simpleStatus)
        .query(
          `UPDATE dbo.order_header SET internal_state=@s, simple_status=@ss, row_version = row_version + 1, updated_at = SYSUTCDATETIME()
           WHERE id=@id AND row_version=@exp`,
        );
      if ((upd.rowsAffected[0] ?? 0) === 0) {
        await safeRollback(tx);
        return { status: "CONFLICT", rowVersion: current.header.rowVersion };
      }
      if (decision === "REJECT") {
        await new sql.Request(tx)
          .input("id", sql.UniqueIdentifier, orderHeaderId)
          .input("from", sql.VarChar(20), current.header.internalState)
          .input("actor", sql.VarChar(40), actor)
          .query(`INSERT INTO dbo.order_status_history (order_header_id, from_state, to_state, actor, reason) VALUES (@id, @from, 'REJECTED', @actor, 'reviewer decision')`);
      }
      await insertAudit(tx, current.header.companyId, actor, decision === "APPROVE" ? "ORDER_APPROVE" : "ORDER_REJECT", orderHeaderId, null);
      await tx.commit();
    } catch (e) {
      await safeRollback(tx);
      throw e;
    }
    // Approve stages the order to the Boomi "final tables" (→ STAGED).
    if (decision === "APPROVE") await this.stageOrder(orderHeaderId);
    return { status: "OK", rowVersion: expectedRowVersion + 1 };
  }

  async stageOrder(orderHeaderId: string): Promise<StageOrderResult> {
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      const ex = await new sql.Request(tx).input("id", sql.UniqueIdentifier, orderHeaderId).query("SELECT id FROM dbo.staging_sales_order WHERE order_header_id = @id");
      if (ex.recordset.length > 0) {
        await new sql.Request(tx).input("id", sql.UniqueIdentifier, orderHeaderId).query("UPDATE dbo.order_header SET internal_state='STAGED', simple_status='Ready', updated_at=SYSUTCDATETIME() WHERE id=@id");
        await tx.commit();
        return { stagingId: ex.recordset[0].id, created: false };
      }
      const h = (await new sql.Request(tx).input("id", sql.UniqueIdentifier, orderHeaderId).query(
        `SELECT company_id, erp_customer_account, customer_po_number, normalized_po_number, po_date, requested_delivery_date, currency, total, line_count
         FROM dbo.order_header WHERE id=@id`,
      )).recordset[0];
      if (!h) {
        await safeRollback(tx);
        throw new Error(`Cannot stage unknown order ${orderHeaderId}`);
      }
      const stagingId = (await new sql.Request(tx)
        .input("oh", sql.UniqueIdentifier, orderHeaderId)
        .input("dax", sql.VarChar(20), h.company_id)
        .input("acct", sql.VarChar(50), h.erp_customer_account)
        .input("po", sql.VarChar(100), h.customer_po_number)
        .input("npo", sql.VarChar(100), h.normalized_po_number)
        .input("podate", sql.Date, h.po_date)
        .input("reqdate", sql.Date, h.requested_delivery_date)
        .input("cur", sql.Char(3), h.currency)
        .input("total", sql.Decimal(18, 4), h.total)
        .input("lc", sql.Int, h.line_count)
        .query(
          `INSERT INTO dbo.staging_sales_order (order_header_id, data_area_id, erp_customer_account, customer_po_number, normalized_po_number, po_date, requested_delivery_date, currency, total, line_count, publish_status)
           OUTPUT INSERTED.id VALUES (@oh,@dax,@acct,@po,@npo,@podate,@reqdate,@cur,@total,@lc,'READY')`,
        )).recordset[0].id;

      const lines = await new sql.Request(tx).input("id", sql.UniqueIdentifier, orderHeaderId).query(
        `SELECT source_line_no, erp_item_id, customer_item_code, quantity, uom, unit_price, requested_date FROM dbo.order_line WHERE order_header_id=@id ORDER BY source_line_no`,
      );
      for (const l of lines.recordset) {
        await new sql.Request(tx)
          .input("sid", sql.UniqueIdentifier, stagingId)
          .input("ln", sql.Int, l.source_line_no)
          .input("item", sql.VarChar(50), l.erp_item_id)
          .input("code", sql.VarChar(100), l.customer_item_code)
          .input("qty", sql.Decimal(18, 4), l.quantity)
          .input("uom", sql.VarChar(20), l.uom)
          .input("price", sql.Decimal(18, 4), l.unit_price)
          .input("rd", sql.Date, l.requested_date)
          .query(`INSERT INTO dbo.staging_sales_order_line (staging_order_id, line_no, erp_item_id, customer_item_code, quantity, uom, unit_price, requested_date) VALUES (@sid,@ln,@item,@code,@qty,@uom,@price,@rd)`);
      }
      await new sql.Request(tx).input("id", sql.UniqueIdentifier, orderHeaderId).query("UPDATE dbo.order_header SET internal_state='STAGED', simple_status='Ready', updated_at=SYSUTCDATETIME() WHERE id=@id");
      await new sql.Request(tx).input("id", sql.UniqueIdentifier, orderHeaderId).query("INSERT INTO dbo.order_status_history (order_header_id, from_state, to_state, actor, reason) VALUES (@id,'READY','STAGED','system','staged for Boomi')");
      await tx.commit();
      return { stagingId, created: true };
    } catch (e) {
      await safeRollback(tx);
      throw e;
    }
  }

  async listReadyForBoomi(limit = 100): Promise<StagedOrderRow[]> {
    const top = Math.max(1, Math.min(limit, 500));
    const res = await this.pool.request().query(
      `SELECT TOP (${top}) id, order_header_id, data_area_id, erp_customer_account, customer_po_number, normalized_po_number,
              po_date, requested_delivery_date, currency, total, line_count, publish_status, ax_sales_order_id
       FROM dbo.staging_sales_order WHERE publish_status = 'READY' ORDER BY created_at`,
    );
    return res.recordset.map((r) => ({
      stagingId: r.id,
      orderHeaderId: r.order_header_id,
      dataAreaId: r.data_area_id,
      erpCustomerAccount: r.erp_customer_account,
      customerPoNumber: r.customer_po_number,
      normalizedPoNumber: r.normalized_po_number,
      poDate: r.po_date ? toDateString(r.po_date) : null,
      requestedDeliveryDate: r.requested_delivery_date ? toDateString(r.requested_delivery_date) : null,
      currency: r.currency,
      total: r.total,
      lineCount: r.line_count,
      publishStatus: r.publish_status,
      axSalesOrderId: r.ax_sales_order_id,
    }));
  }

  async markBoomiResult(stagingId: string, result: { axSalesOrderId?: string; error?: string }): Promise<void> {
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      await new sql.Request(tx)
        .input("id", sql.UniqueIdentifier, stagingId)
        .input("st", sql.VarChar(20), result.error ? "FAILED" : "COMPLETED")
        .input("ax", sql.VarChar(60), result.axSalesOrderId ?? null)
        .input("err", sql.NVarChar(2000), result.error ?? null)
        .query(`UPDATE dbo.staging_sales_order SET publish_status=@st, ax_sales_order_id=@ax, error_message=@err, updated_at=SYSUTCDATETIME() WHERE id=@id`);
      if (!result.error) {
        const oh = (await new sql.Request(tx).input("id", sql.UniqueIdentifier, stagingId).query("SELECT order_header_id FROM dbo.staging_sales_order WHERE id=@id")).recordset[0];
        if (oh) {
          await new sql.Request(tx).input("id", sql.UniqueIdentifier, oh.order_header_id).query("UPDATE dbo.order_header SET internal_state='ERP_CREATED', simple_status='Completed', updated_at=SYSUTCDATETIME() WHERE id=@id");
          await new sql.Request(tx).input("id", sql.UniqueIdentifier, oh.order_header_id).input("ax", sql.VarChar(60), result.axSalesOrderId ?? null).query("INSERT INTO dbo.integration_ack (order_header_id, boomi_status, ax_sales_order_id) VALUES (@id,'COMPLETED',@ax)");
        }
      }
      await tx.commit();
    } catch (e) {
      await safeRollback(tx);
      throw e;
    }
  }

  // --- AP invoice ---
  async saveProcessedInvoice(input: SaveInvoiceInput): Promise<SaveInvoiceResult> {
    const ex = await this.pool.request().input("h", sql.Char(64), input.sourceHash).query("SELECT id FROM dbo.ap_invoice_header WHERE source_hash = @h");
    if (ex.recordset.length > 0) return { invoiceHeaderId: ex.recordset[0].id, created: false };

    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      const h = input.header;
      const headRes = await new sql.Request(tx)
        .input("hash", sql.Char(64), input.sourceHash)
        .input("company", sql.VarChar(20), input.companyId)
        .input("type", sql.VarChar(10), input.invoiceType)
        .input("vacct", sql.VarChar(50), h.erpVendorAccount)
        .input("vname", sql.NVarChar(512), h.vendorName)
        .input("invno", sql.VarChar(100), h.invoiceNumber)
        .input("ninvno", sql.VarChar(100), h.normalizedInvoiceNumber)
        .input("po", sql.VarChar(100), h.poNumber)
        .input("idate", sql.Date, h.invoiceDate ? new Date(h.invoiceDate) : null)
        .input("cur", sql.Char(3), h.currency)
        .input("sub", sql.Decimal(18, 4), h.subtotal)
        .input("tax", sql.Decimal(18, 4), h.tax)
        .input("gt", sql.Decimal(18, 4), h.grandTotal)
        .input("lc", sql.Int, h.lineCount)
        .input("ss", sql.VarChar(20), h.simpleStatus)
        .input("is", sql.VarChar(20), h.internalState)
        .input("raw", sql.NVarChar(sql.MAX), input.extraction.rawExtractionJson)
        .input("norm", sql.NVarChar(sql.MAX), input.extraction.normalizedJson)
        .input("conf", sql.Decimal(5, 4), input.extraction.overallConfidence ?? null)
        .input("blob", sql.VarChar(1024), input.blobUri ?? null)
        .query(
          `INSERT INTO dbo.ap_invoice_header
             (source_hash, company_id, invoice_type, erp_vendor_account, vendor_name, invoice_number, normalized_invoice_number,
              po_number, invoice_date, currency, subtotal, tax, grand_total, line_count, simple_status, internal_state,
              raw_extraction, normalized, overall_confidence, blob_uri)
           OUTPUT INSERTED.id
           VALUES (@hash,@company,@type,@vacct,@vname,@invno,@ninvno,@po,@idate,@cur,@sub,@tax,@gt,@lc,@ss,@is,@raw,@norm,@conf,@blob)`,
        );
      const invoiceHeaderId: string = headRes.recordset[0].id;

      for (const l of input.lines) {
        await new sql.Request(tx)
          .input("hid", sql.UniqueIdentifier, invoiceHeaderId)
          .input("ln", sql.Int, l.sourceLineNo)
          .input("poref", sql.VarChar(50), l.poLineRef)
          .input("item", sql.VarChar(50), l.erpItemId)
          .input("gl", sql.VarChar(50), l.glAccount)
          .input("desc", sql.NVarChar(512), l.description)
          .input("qty", sql.Decimal(18, 4), l.quantity)
          .input("uom", sql.VarChar(20), l.uom)
          .input("price", sql.Decimal(18, 4), l.unitPrice)
          .input("amt", sql.Decimal(18, 4), l.amount)
          .input("ms", sql.VarChar(30), l.matchStatus)
          .input("ca", sql.Bit, l.isCodeAndApprove)
          .query(
            `INSERT INTO dbo.ap_invoice_line (ap_invoice_header_id, source_line_no, po_line_ref, erp_item_id, gl_account, description, quantity, uom, unit_price, amount, match_status, is_code_and_approve)
             VALUES (@hid,@ln,@poref,@item,@gl,@desc,@qty,@uom,@price,@amt,@ms,@ca)`,
          );
      }
      for (const v of input.validation) {
        await new sql.Request(tx)
          .input("hid", sql.UniqueIdentifier, invoiceHeaderId)
          .input("sev", sql.VarChar(10), v.severity)
          .input("code", sql.VarChar(80), v.code)
          .input("fp", sql.VarChar(200), v.fieldPath)
          .input("msg", sql.NVarChar(2000), v.message)
          .input("bl", sql.Bit, v.blocking)
          .query(`INSERT INTO dbo.ap_invoice_validation (ap_invoice_header_id, severity, code, field_path, message, blocking) VALUES (@hid,@sev,@code,@fp,@msg,@bl)`);
      }
      await tx.commit();
      return { invoiceHeaderId, created: true };
    } catch (e) {
      await safeRollback(tx);
      if (isUniqueViolation(e)) {
        const again = await this.pool.request().input("h", sql.Char(64), input.sourceHash).query("SELECT id FROM dbo.ap_invoice_header WHERE source_hash = @h");
        if (again.recordset.length > 0) return { invoiceHeaderId: again.recordset[0].id, created: false };
      }
      throw e;
    }
  }

  async claimInvoice(input: ClaimInvoiceInput): Promise<DuplicateClaimResult> {
    try {
      const res = await this.pool
        .request()
        .input("company", sql.VarChar(20), input.companyId)
        .input("bk", sql.VarChar(220), input.businessKey)
        .input("ref", sql.VarChar(100), input.invoiceRef)
        .query(
          `INSERT INTO dbo.duplicate_claim (company_id, business_key, order_header_id, status, matched_existing_ref, matched_channel)
           OUTPUT INSERTED.id VALUES (@company, @bk, NULL, 'CLAIMED', @ref, 'EMAIL')`,
        );
      return { status: "CLAIMED", claimId: res.recordset[0].id };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const existing = await this.pool.request().input("bk", sql.VarChar(220), input.businessKey).query(
        `SELECT TOP 1 id, matched_existing_ref FROM dbo.duplicate_claim WHERE business_key=@bk AND status IN ('CLAIMED','RESOLVED')`,
      );
      const r = existing.recordset[0];
      if (r && r.matched_existing_ref === input.invoiceRef) return { status: "CLAIMED", claimId: r.id };
      return { status: "COLLISION", matchedChannel: "EMAIL", matchedExistingRef: r?.matched_existing_ref ?? null };
    }
  }

  async stageInvoice(invoiceHeaderId: string): Promise<{ stagingId: string; created: boolean }> {
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      const ex = await new sql.Request(tx).input("id", sql.UniqueIdentifier, invoiceHeaderId).query("SELECT id FROM dbo.staging_vendor_invoice WHERE ap_invoice_header_id=@id");
      if (ex.recordset.length > 0) {
        await new sql.Request(tx).input("id", sql.UniqueIdentifier, invoiceHeaderId).query("UPDATE dbo.ap_invoice_header SET internal_state='STAGED', simple_status='Ready', updated_at=SYSUTCDATETIME() WHERE id=@id");
        await tx.commit();
        return { stagingId: ex.recordset[0].id, created: false };
      }
      const h = (await new sql.Request(tx).input("id", sql.UniqueIdentifier, invoiceHeaderId).query(
        `SELECT company_id, invoice_type, erp_vendor_account, invoice_number, normalized_invoice_number, po_number, invoice_date, currency, grand_total, line_count FROM dbo.ap_invoice_header WHERE id=@id`,
      )).recordset[0];
      if (!h) {
        await safeRollback(tx);
        throw new Error(`Cannot stage unknown invoice ${invoiceHeaderId}`);
      }
      const stagingId = (await new sql.Request(tx)
        .input("hid", sql.UniqueIdentifier, invoiceHeaderId)
        .input("dax", sql.VarChar(20), h.company_id)
        .input("type", sql.VarChar(10), h.invoice_type)
        .input("vacct", sql.VarChar(50), h.erp_vendor_account)
        .input("invno", sql.VarChar(100), h.invoice_number)
        .input("ninvno", sql.VarChar(100), h.normalized_invoice_number)
        .input("po", sql.VarChar(100), h.po_number)
        .input("idate", sql.Date, h.invoice_date)
        .input("cur", sql.Char(3), h.currency)
        .input("gt", sql.Decimal(18, 4), h.grand_total)
        .input("lc", sql.Int, h.line_count)
        .query(
          `INSERT INTO dbo.staging_vendor_invoice (ap_invoice_header_id, data_area_id, invoice_type, erp_vendor_account, invoice_number, normalized_invoice_number, po_number, invoice_date, currency, grand_total, line_count, publish_status)
           OUTPUT INSERTED.id VALUES (@hid,@dax,@type,@vacct,@invno,@ninvno,@po,@idate,@cur,@gt,@lc,'READY')`,
        )).recordset[0].id;

      const lines = await new sql.Request(tx).input("id", sql.UniqueIdentifier, invoiceHeaderId).query(
        `SELECT source_line_no, po_line_ref, erp_item_id, gl_account, quantity, uom, unit_price, amount FROM dbo.ap_invoice_line WHERE ap_invoice_header_id=@id ORDER BY source_line_no`,
      );
      for (const l of lines.recordset) {
        await new sql.Request(tx)
          .input("sid", sql.UniqueIdentifier, stagingId)
          .input("ln", sql.Int, l.source_line_no)
          .input("poref", sql.VarChar(50), l.po_line_ref)
          .input("item", sql.VarChar(50), l.erp_item_id)
          .input("gl", sql.VarChar(50), l.gl_account)
          .input("qty", sql.Decimal(18, 4), l.quantity)
          .input("uom", sql.VarChar(20), l.uom)
          .input("price", sql.Decimal(18, 4), l.unit_price)
          .input("amt", sql.Decimal(18, 4), l.amount)
          .query(`INSERT INTO dbo.staging_vendor_invoice_line (staging_invoice_id, line_no, po_line_ref, erp_item_id, gl_account, quantity, uom, unit_price, amount) VALUES (@sid,@ln,@poref,@item,@gl,@qty,@uom,@price,@amt)`);
      }
      await new sql.Request(tx).input("id", sql.UniqueIdentifier, invoiceHeaderId).query("UPDATE dbo.ap_invoice_header SET internal_state='STAGED', simple_status='Ready', updated_at=SYSUTCDATETIME() WHERE id=@id");
      await tx.commit();
      return { stagingId, created: true };
    } catch (e) {
      await safeRollback(tx);
      throw e;
    }
  }

  async listVendorInvoicesForBoomi(limit = 100): Promise<StagedVendorInvoiceRow[]> {
    const top = Math.max(1, Math.min(limit, 500));
    const res = await this.pool.request().query(
      `SELECT TOP (${top}) id, ap_invoice_header_id, data_area_id, invoice_type, erp_vendor_account, invoice_number, normalized_invoice_number,
              po_number, invoice_date, currency, grand_total, line_count, publish_status, ax_voucher_id
       FROM dbo.staging_vendor_invoice WHERE publish_status='READY' ORDER BY created_at`,
    );
    return res.recordset.map((r) => ({
      stagingId: r.id,
      invoiceHeaderId: r.ap_invoice_header_id,
      dataAreaId: r.data_area_id,
      invoiceType: r.invoice_type,
      erpVendorAccount: r.erp_vendor_account,
      invoiceNumber: r.invoice_number,
      normalizedInvoiceNumber: r.normalized_invoice_number,
      poNumber: r.po_number,
      invoiceDate: r.invoice_date ? toDateString(r.invoice_date) : null,
      currency: r.currency,
      grandTotal: r.grand_total,
      lineCount: r.line_count,
      publishStatus: r.publish_status,
      axVoucherId: r.ax_voucher_id,
    }));
  }

  async markVendorInvoiceResult(stagingId: string, result: { axVoucherId?: string; error?: string }): Promise<void> {
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      await new sql.Request(tx)
        .input("id", sql.UniqueIdentifier, stagingId)
        .input("st", sql.VarChar(20), result.error ? "FAILED" : "COMPLETED")
        .input("ax", sql.VarChar(60), result.axVoucherId ?? null)
        .input("err", sql.NVarChar(2000), result.error ?? null)
        .query(`UPDATE dbo.staging_vendor_invoice SET publish_status=@st, ax_voucher_id=@ax, error_message=@err, updated_at=SYSUTCDATETIME() WHERE id=@id`);
      if (!result.error) {
        const row = (await new sql.Request(tx).input("id", sql.UniqueIdentifier, stagingId).query("SELECT ap_invoice_header_id FROM dbo.staging_vendor_invoice WHERE id=@id")).recordset[0];
        if (row) {
          await new sql.Request(tx).input("id", sql.UniqueIdentifier, row.ap_invoice_header_id).query("UPDATE dbo.ap_invoice_header SET internal_state='ERP_CREATED', simple_status='Completed', updated_at=SYSUTCDATETIME() WHERE id=@id");
        }
      }
      await tx.commit();
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
