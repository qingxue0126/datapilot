import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import type { RequestContext } from "../core/types.js";
import { installSessionRoutes } from "./session-routes.js";
import { SqliteSessionStore } from "./session-store.js";

test("session API supports CRUD while hiding sessions from other users", async () => {
  const directory = mkdtempSync(join(tmpdir(), "datapilot-session-api-"));
  const store = new SqliteSessionStore(join(directory, "sessions.sqlite"));
  const app = express();
  app.use(express.json());
  installSessionRoutes(app, store, (request) => ({
    tenantId: "tenant", accountSetId: "books", userId: String(request.header("x-test-user") || "alice"),
    role: "tenant_admin", sessionId: "auth-session",
  } satisfies RequestContext));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const createdResponse = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ datasourceId: "source-a" }) });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { session: { id: string } };
    assert.equal((await fetch(`${base}/api/sessions`)).status, 200);
    assert.equal((await fetch(`${base}/api/sessions/${created.session.id}`, { headers: { "x-test-user": "bob" } })).status, 404);
    const renamed = await fetch(`${base}/api/sessions/${created.session.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "收入分析" }) });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json() as { session: { title: string } }).session.title, "收入分析");
    const pinned = await fetch(`${base}/api/sessions/${created.session.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pinned: true }) });
    assert.equal(pinned.status, 200);
    assert.equal((await pinned.json() as { session: { pinned: boolean } }).session.pinned, true);
    assert.equal((await fetch(`${base}/api/sessions/${created.session.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", "x-test-user": "bob" }, body: JSON.stringify({ pinned: true }) })).status, 404);
    assert.equal((await fetch(`${base}/api/sessions/${created.session.id}`, { method: "DELETE", headers: { "x-test-user": "bob" } })).status, 404);
    assert.equal((await fetch(`${base}/api/sessions/${created.session.id}`, { method: "DELETE" })).status, 204);
  } finally {
    server.close(); await once(server, "close"); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});
