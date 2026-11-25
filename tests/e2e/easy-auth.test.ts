/**
 * Entra Easy Auth authenticator (Azure Container Apps built-in auth). Verifies that the
 * base64 `x-ms-client-principal` header is decoded, the subject + app-role claims are mapped
 * to AppRoles, and that a missing/garbage header fails closed (→ null, i.e. 401).
 */
import { describe, expect, it } from "vitest";
import { easyAuthAuthenticator, roleMapFromEnv, type AppRole } from "../../apps/api/src/auth.js";

interface Claim {
  typ: string;
  val: string;
}

/** Builds the base64 `x-ms-client-principal` header the platform injects. */
function principalHeader(claims: Claim[]): string {
  const principal = { auth_typ: "aad", claims };
  return Buffer.from(JSON.stringify(principal), "utf8").toString("base64");
}

const OID = "http://schemas.microsoft.com/identity/claims/objectidentifier";

describe("easyAuthAuthenticator", () => {
  it("maps the subject and app-role claims to a Principal", async () => {
    const auth = easyAuthAuthenticator();
    const header = principalHeader([
      { typ: OID, val: "user-oid-123" },
      { typ: "preferred_username", val: "jane@lyonsmagnus.com" },
      { typ: "roles", val: "OrderProcessor" },
      { typ: "roles", val: "Supervisor" },
    ]);
    const principal = await auth({ "x-ms-client-principal": header });
    expect(principal).toEqual({ sub: "user-oid-123", roles: ["OrderProcessor", "Supervisor"] });
  });

  it("accepts role names case-insensitively and drops unknown roles", async () => {
    const auth = easyAuthAuthenticator();
    const header = principalHeader([
      { typ: OID, val: "u1" },
      { typ: "roles", val: "administrator" },
      { typ: "roles", val: "SomeRandomRole" },
    ]);
    const principal = await auth({ "x-ms-client-principal": header });
    expect(principal).toEqual({ sub: "u1", roles: ["Administrator"] });
  });

  it("maps group object-ids to roles via a roleMap", async () => {
    const roleMap: Record<string, AppRole> = { "group-abc": "Administrator" };
    const auth = easyAuthAuthenticator({ roleMap });
    const header = principalHeader([
      { typ: OID, val: "u2" },
      { typ: "groups", val: "group-abc" },
    ]);
    const principal = await auth({ "x-ms-client-principal": header });
    expect(principal).toEqual({ sub: "u2", roles: ["Administrator"] });
  });

  it("de-duplicates repeated roles", async () => {
    const auth = easyAuthAuthenticator();
    const header = principalHeader([
      { typ: OID, val: "u3" },
      { typ: "roles", val: "Viewer" },
      { typ: "roles", val: "Viewer" },
    ]);
    const principal = await auth({ "x-ms-client-principal": header });
    expect(principal).toEqual({ sub: "u3", roles: ["Viewer"] });
  });

  it("fails closed when the header is missing", async () => {
    const auth = easyAuthAuthenticator();
    expect(await auth({})).toBeNull();
  });

  it("fails closed when the header is not valid base64 JSON", async () => {
    const auth = easyAuthAuthenticator();
    expect(await auth({ "x-ms-client-principal": "!!!not-base64!!!" })).toBeNull();
  });

  it("returns null when no subject claim is present", async () => {
    const auth = easyAuthAuthenticator();
    const header = principalHeader([{ typ: "roles", val: "Viewer" }]);
    expect(await auth({ "x-ms-client-principal": header })).toBeNull();
  });

  it("authenticates with no roles (read-restricted principal) when subject is present", async () => {
    const auth = easyAuthAuthenticator();
    const header = principalHeader([{ typ: "sub", val: "svc-1" }]);
    expect(await auth({ "x-ms-client-principal": header })).toEqual({ sub: "svc-1", roles: [] });
  });
});

describe("roleMapFromEnv", () => {
  it("parses a comma-separated groupid=role map and ignores unknown roles", () => {
    const map = roleMapFromEnv("group-abc=Administrator, group-def=OrderProcessor, group-x=Nope");
    expect(map).toEqual({ "group-abc": "Administrator", "group-def": "OrderProcessor" });
  });

  it("returns an empty map for an undefined value", () => {
    expect(roleMapFromEnv(undefined)).toEqual({});
  });
});
