import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { AccountStore, installAuthRoutes } from "../../../../server/modules/auth/index.js";
import { installOrganizationRoutes } from "../../../../server/modules/organization/index.js";

test("organization routes preserve auth URLs, cookie sessions, team switching and RBAC", async () => {
  const directory = mkdtempSync(join(tmpdir(), "datapilot-organization-api-"));
  const app = express();
  const accounts = new AccountStore(join(directory, "accounts.json"));
  app.use(express.json());
  installAuthRoutes(app, accounts);
  installOrganizationRoutes(app, accounts);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = "";
  const request = (url: string, method = "GET", body?: unknown) => fetch(base + url, {
    method, headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    assert.equal((await request("/api/auth/account-center")).status, 401);
    assert.equal((await request("/api/auth/admin/teams", "POST", { name: "Forbidden" })).status, 401);
    const registered = await request("/api/auth/register", "POST", { identifier: "organization-owner", password: "Secure123", confirmPassword: "Secure123" });
    assert.equal(registered.status, 201);
    cookie = registered.headers.get("set-cookie")!.split(";")[0];
    const center = await request("/api/auth/account-center");
    assert.equal(center.status, 200);
    const initial = await center.json();
    assert.equal(initial.user.role, "tenant_owner");
    const created = await request("/api/auth/admin/teams", "POST", { name: "Regression team" });
    assert.equal(created.status, 201);
    const { team } = await created.json();
    const switched = await request("/api/auth/teams/switch", "POST", { tenantId: team.id });
    assert.equal(switched.status, 200);
    assert.equal((await switched.json()).user.tenantId, team.id);
    assert.equal((await request("/api/auth/teams/switch", "POST", { tenantId: "unrelated-tenant" })).status, 403);
    const renamed = await request(`/api/auth/admin/teams/${team.id}`, "PATCH", { name: "Renamed regression team" });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).team.name, "Renamed regression team");
    const key = await request("/api/auth/api-keys", "POST", { name: "Regression key" });
    assert.equal(key.status, 201);
    assert.equal((await request("/api/auth/api-keys")).status, 200);
  } finally {
    server.close(); await once(server, "close");
    rmSync(directory, { recursive: true, force: true });
  }
});
