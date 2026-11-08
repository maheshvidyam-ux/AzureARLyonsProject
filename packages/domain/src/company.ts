/**
 * Company / legal-entity (dataAreaId) resolution (spec §7).
 *
 * ⚠️ PROVISIONAL (Q-AX-2 / Q-GRAPH-1): the real mapping from sender domain / mailbox /
 * document to a legal entity is a Phase-0 business+ERP decision. Until the `dataAreaId`
 * list and the resolution policy are supplied, this returns a single default company so the
 * pipeline can attach a company_id at ingestion time. It MUST be replaced before matching
 * and duplicate keys depend on the real company partition.
 */
export interface CompanyResolution {
  companyId: string;
  resolvedFrom: "email_domain" | "document" | "manual" | "default";
}

const DEFAULT_COMPANY_ID = "USMF";

export function resolveCompanyId(_input: { sender: string | null; mailbox: string }): CompanyResolution {
  return { companyId: DEFAULT_COMPANY_ID, resolvedFrom: "default" };
}
