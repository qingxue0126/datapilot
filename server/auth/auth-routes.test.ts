import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { AccountStore } from "./account-store.js";
import { installAuthRoutes } from "./auth-routes.js";

test("auth API persists a cookie session, logs out, and protects an owner account", async () => {
  const directory = mkdtempSync(join(tmpdir(), "datapilot-auth-api-"));
  const app = express();
  app.use(express.json());
  installAuthRoutes(app, new AccountStore(join(directory, "accounts.json")));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const anonymous = await fetch(`${base}/api/auth/me`);
    assert.equal(anonymous.status, 401);

    const registered = await fetch(`${base}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "api-user", password: "Secure123", confirmPassword: "Secure123" }),
    });
    assert.equal(registered.status, 201);
    const cookie = registered.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    assert.match(registered.headers.get("set-cookie") || "", /HttpOnly/i);
    assert.match(registered.headers.get("set-cookie") || "", /SameSite=Lax/i);

    const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });
    assert.equal(me.status, 200);
    const identity = await me.json() as { context: { userId: string; tenantId: string; accountSetId: string; role: string } };
    assert.ok(identity.context.userId);
    assert.ok(identity.context.tenantId);
    assert.ok(identity.context.accountSetId);
    assert.equal(identity.context.role, "tenant_owner");

    const logout = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie } });
    assert.equal(logout.status, 204);
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } })).status, 401);

    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "api-user", password: "Secure123" }),
    });
    const loginCookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.equal(login.status, 200);
    assert.ok(loginCookie);

    const rejectedDelete = await fetch(`${base}/api/auth/account`, { method: "DELETE", headers: { Cookie: loginCookie, "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: "wrong" }) });
    assert.equal(rejectedDelete.status, 400);
    const deleted = await fetch(`${base}/api/auth/account`, { method: "DELETE", headers: { Cookie: loginCookie, "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: "DELETE" }) });
    assert.equal(deleted.status, 400);
    const refusedLogin = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: "api-user", password: "Secure123" }) });
    assert.equal(refusedLogin.status, 200);
  } finally {
    server.close();
    await once(server, "close");
    rmSync(directory, { recursive: true, force: true });
  }
});
