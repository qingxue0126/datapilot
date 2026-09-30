import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { AccountStore, AuthError } from "../auth/account-store.js";
import { EnvironmentIdentityProvider } from "../auth/identity-provider.js";
import { SqliteSessionStore } from "../context/session-store.js";
import type { DatabaseConfig } from "../database.js";
import { installQueryRoutes, type QueryAuditEntry } from "./query-routes.js";

const connection: DatabaseConfig = { name: "Test", engine: "mysql", host: "127.0.0.1", port: 3306, database: "test", user: "test", password: "test" };

test("v1 query accepts tenant-bound API keys, preserves sessions, limits calls, and rejects invalid credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "datapilot-v1-query-"));
  const accounts = new AccountStore(join(directory, "accounts.json"));
  const sessions = new SqliteSessionStore(":memory:");
  const owner = await accounts.register("query-owner", "Secure123", "Secure123");
  const other = await accounts.register("query-other", "Secure123", "Secure123");
  const blocked = await accounts.register("query-blocked", "Secure123", "Secure123");
  const ownerKey = accounts.createApiKey(owner.token, "External Agent");
  const otherKey = accounts.createApiKey(other.token, "Other Tenant");
  const blockedKey = accounts.createApiKey(blocked.token, "Blocked Agent");
  const identities = new EnvironmentIdentityProvider(accounts);
  const audits: QueryAuditEntry[] = [];
  const observed: { tenantId: string; userId: string; sessionId: string }[] = [];
  const app = express();
  app.use(express.json());
  app.use("/api", (request, response, next) => {
    try { identities.resolve(request); next(); }
    catch (error) { response.status(error instanceof AuthError ? error.status : 401).json({ error: "unauthorized" }); }
  });
  installQueryRoutes(app, {
    identity: (request) => identities.resolve(request), sessions, rateLimit: 2, log: (entry) => audits.push(entry),
    permissions: { require: (context) => { if (context.userId === blocked.user.id) throw new Error("无权执行 agent:query"); } },
    connection: (id, context) => {
      if (id !== `source-${context.tenantId}`) throw new Error("数据源不存在或无权访问");
      return connection;
    },
    agent: { run: async (input) => {
      observed.push({ tenantId: input.context.tenantId, userId: input.context.userId, sessionId: input.sessionId });
      return { summary: "ok", question: input.question, sessionId: input.sessionId } as Awaited<ReturnType<import("./data-agent.js").DataAgent["run"]>>;
    } },
  });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const base = `http://127.0.0.1:${address.port}`;
  const invoke = (key: string, body: object) => fetch(`${base}/api/v1/query`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const first = await invoke(ownerKey.key, { question: "本月收入？", datasource_id: `source-${owner.user.tenantId}` });
    assert.equal(first.status, 200);
    const firstBody = await first.json() as { sessionId: string; requestId: string };
    assert.ok(firstBody.sessionId);
    assert.ok(firstBody.requestId);
    assert.equal(observed[0].tenantId, owner.user.tenantId);
    assert.equal(observed[0].userId, owner.user.id);

    const followUp = await invoke(ownerKey.key, { question: "同比呢？", datasource_id: `source-${owner.user.tenantId}`, session_id: firstBody.sessionId });
    assert.equal(followUp.status, 200);
    assert.equal((await followUp.json() as { sessionId: string }).sessionId, firstBody.sessionId);
    assert.equal(observed[1].sessionId, firstBody.sessionId);
    assert.equal((await invoke(ownerKey.key, { question: "第三次", datasource_id: `source-${owner.user.tenantId}` })).status, 429);

    assert.equal((await invoke("dp_invalid_invalid_invalid_invalid_invalid_invalid", { question: "test", datasource_id: "source-x" })).status, 401);
    assert.equal((await invoke(otherKey.key, { question: "跨租户", datasource_id: `source-${owner.user.tenantId}` })).status, 403);
    assert.equal((await invoke(blockedKey.key, { question: "无权限", datasource_id: `source-${blocked.user.tenantId}` })).status, 403);
    assert.equal((await fetch(`${base}/api/query`, { method: "POST", headers: { Authorization: `Bearer ${otherKey.key}`, "Content-Type": "application/json" }, body: "{}" })).status, 401);

    accounts.setApiKeyEnabled(owner.token, ownerKey.apiKey.id, false);
    assert.equal((await invoke(ownerKey.key, { question: "disabled", datasource_id: `source-${owner.user.tenantId}` })).status, 401);
    accounts.setApiKeyEnabled(owner.token, ownerKey.apiKey.id, true);
    accounts.revokeApiKey(owner.token, ownerKey.apiKey.id);
    assert.equal((await invoke(ownerKey.key, { question: "revoked", datasource_id: `source-${owner.user.tenantId}` })).status, 401);
    assert.ok(audits.some((item) => item.credential === "api-key" && item.status === 200 && item.tenantId === owner.user.tenantId));
    assert.ok(audits.some((item) => item.status === 429));
  } finally {
    server.close(); await once(server, "close"); sessions.close(); rmSync(directory, { recursive: true, force: true });
  }
});
