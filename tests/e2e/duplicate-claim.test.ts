/**
 * Phase 3 — atomic duplicate claim (spec §8, invariant #2). Concurrency (exactly one winner),
 * cross-channel block (EDI pre-registered → Email blocked), and same-order idempotency.
 * In-memory here; the real concurrency guarantee is the Fabric SQL filtered unique index,
 * covered by the gated live test in `packages/persistence/persistence.test.ts` additions.
 */
import { describe, expect, it } from "vitest";
import { InMemoryPersistence } from "@coa/persistence";

const KEY = "USMF::ACME01::PO100045";

describe("duplicate claim", () => {
  it("two different orders racing for the same key → exactly one CLAIMED", async () => {
    const p = new InMemoryPersistence();
    const [a, b] = await Promise.all([
      p.claimDuplicate({ companyId: "USMF", businessKey: KEY, orderHeaderId: "order-A", channel: "EMAIL" }),
      p.claimDuplicate({ companyId: "USMF", businessKey: KEY, orderHeaderId: "order-B", channel: "EMAIL" }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["CLAIMED", "COLLISION"]);
  });

  it("re-claiming by the same order is idempotent (not a collision)", async () => {
    const p = new InMemoryPersistence();
    const first = await p.claimDuplicate({ companyId: "USMF", businessKey: KEY, orderHeaderId: "order-A", channel: "EMAIL" });
    const again = await p.claimDuplicate({ companyId: "USMF", businessKey: KEY, orderHeaderId: "order-A", channel: "EMAIL" });
    expect(first.status).toBe("CLAIMED");
    expect(again.status).toBe("CLAIMED");
  });

  it("cross-channel: a pre-registered EDI claim blocks the Email order", async () => {
    const p = new InMemoryPersistence();
    await p.seedExternalClaim({ companyId: "USMF", businessKey: KEY, channel: "EDI", matchedExistingRef: "EDI-850-99" });
    const email = await p.claimDuplicate({ companyId: "USMF", businessKey: KEY, orderHeaderId: "order-email", channel: "EMAIL" });
    expect(email.status).toBe("COLLISION");
    if (email.status === "COLLISION") {
      expect(email.matchedChannel).toBe("EDI");
      expect(email.matchedExistingRef).toBe("EDI-850-99");
    }
  });
});
