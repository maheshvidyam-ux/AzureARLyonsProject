/**
 * Connection config admin API: Administrator-only GET/PUT of the (non-secret) connection
 * coordinates + a "test connection" probe. The live prober is stubbed so the test needs no Azure.
 */
import { describe, expect, it } from "vitest";
import { InMemoryPersistence } from "@coa/persistence";
import { buildServer } from "../../apps/api/src/server.js";
import type { ConnectionTester } from "../../apps/api/src/settings.js";

const ADMIN = { "x-dev-user": "admin1", "x-dev-roles": "Administrator" };
const SUPER = { "x-dev-user": "sup1", "x-dev-roles": "Supervisor" };
const JSONH = { "content-type": "application/json" };

async function makeApp() {
  const persistence = new InMemoryPersistence();
  const tester: ConnectionTester = async (target) => ({ ok: true, detail: `stub-ok:${target}` });
  const app = await buildServer({ graphClientState: "s", graph: { async enqueueMessageIds() {} }, persistence, connectionTester: tester, logger: false });
  return app;
}

describe("settings / connections", () => {
  it("is Administrator-only", async () => {
    const app = await makeApp();
    expect((await app.inject({ method: "GET", url: "/settings/connections" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/settings/connections", headers: SUPER })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/settings/connections", headers: ADMIN })).statusCode).toBe(200);
    await app.close();
  });

  it("returns an effective config with lakehouse + ai + operationalDb sections", async () => {
    const app = await makeApp();
    const body = (await app.inject({ method: "GET", url: "/settings/connections", headers: ADMIN })).json();
    expect(body.config).toMatchObject({ operationalDb: expect.any(Object), lakehouse: expect.any(Object), ai: expect.any(Object) });
    expect(body.config.lakehouse.customerTable).toBe("gold.ax_custmaster");
    await app.close();
  });

  it("persists an edit (Admin) and refuses it for a Supervisor", async () => {
    const app = await makeApp();
    const current = (await app.inject({ method: "GET", url: "/settings/connections", headers: ADMIN })).json().config;
    current.lakehouse.server = "my-lakehouse.datawarehouse.fabric.microsoft.com";
    current.lakehouse.customerTable = "gold.ax_custmaster_v2";

    expect((await app.inject({ method: "PUT", url: "/settings/connections", headers: { ...SUPER, ...JSONH }, payload: JSON.stringify(current) })).statusCode).toBe(403);

    const put = await app.inject({ method: "PUT", url: "/settings/connections", headers: { ...ADMIN, ...JSONH }, payload: JSON.stringify(current) });
    expect(put.statusCode).toBe(200);
    expect(put.json().updatedBy).toBe("admin1");

    const after = (await app.inject({ method: "GET", url: "/settings/connections", headers: ADMIN })).json().config;
    expect(after.lakehouse.server).toBe("my-lakehouse.datawarehouse.fabric.microsoft.com");
    expect(after.lakehouse.customerTable).toBe("gold.ax_custmaster_v2");
    await app.close();
  });

  it("runs a test-connection probe via the injected tester", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: "/settings/connections/test", headers: { ...ADMIN, ...JSONH }, payload: JSON.stringify({ target: "lakehouse" }) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, detail: "stub-ok:lakehouse" });

    const bad = await app.inject({ method: "POST", url: "/settings/connections/test", headers: { ...ADMIN, ...JSONH }, payload: JSON.stringify({ target: "nope" }) });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});
