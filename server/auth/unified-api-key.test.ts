import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { installQueryRoutes } from "../agent/query-routes.js";
import { SqliteSessionStore } from "../context/session-store.js";
import type { RequestContext } from "../core/types.js";
import type { DatabaseConfig } from "../database.js";
import { TestEmbeddingProvider } from "../knowledge/embedding.js";
import { installKnowledgeRoutes } from "../knowledge/knowledge-routes.js";
import { KnowledgeStore } from "../knowledge/knowledge-store.js";
import { LocalVectorStore } from "../knowledge/vector-store.js";
import type { WorkflowEngine } from "../workflow/workflow-engine.js";
import { installWorkflowRoutes } from "../workflow/workflow-routes.js";
import { WorkflowStore } from "../workflow/workflow-store.js";
import { AccountStore, AuthError } from "./account-store.js";
import { createApiKeyGuard } from "./api-key-guard.js";
import { EnvironmentIdentityProvider } from "./identity-provider.js";

const connection: DatabaseConfig = { name: "Test", engine: "mysql", host: "127.0.0.1", port: 3306, database: "test", user: "test", password: "test" };

test("one Bearer API key without cookies can query, run agents with SSE, and retrieve knowledge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "datapilot-unified-key-"));
  const accounts = new AccountStore(join(directory, "accounts.json"));
  const sessions = new SqliteSessionStore(":memory:");
  const workflows = new WorkflowStore(":memory:");
  const knowledge = new KnowledgeStore(":memory:");
  const vectors = new LocalVectorStore(":memory:");
  const embeddings = new TestEmbeddingProvider();
  const owner = await accounts.register("unified-owner", "Secure123", "Secure123");
  const outsider = await accounts.register("unified-outsider", "Secure123", "Secure123");
  const key = accounts.createApiKey(owner.token, "Unified External Agent").key;
  const outsiderKey = accounts.createApiKey(outsider.token, "Outsider").key;
  const identities = new EnvironmentIdentityProvider(accounts);
  const app = express(); app.use(express.json({ limit: "2mb" }));
  app.use("/api", createApiKeyGuard((request) => identities.resolve(request), { limit: 100, log: () => undefined }));
  app.use("/api", (request, response, next) => {
    try { identities.resolve(request); next(); }
    catch (error) { response.status(error instanceof AuthError ? error.status : 401).json({ error: "unauthorized" }); }
  });
  installQueryRoutes(app, {
    identity: (request) => identities.resolve(request), sessions, permissions: { require: () => undefined },
    connection: (id, context) => {
      if (id !== `source-${context.tenantId}`) throw new Error("数据源不存在或无权访问");
      return connection;
    },
    agent: { run: async (input) => ({ summary: `answer:${input.question}`, sessionId: input.sessionId } as Awaited<ReturnType<import("../agent/data-agent.js").DataAgent["run"]>>) },
  });
  const workflowEngine = {
    start: (context: RequestContext, id: string, input: unknown) => { workflows.getAgent(context, id); return { id: "run-sync", agentId: id, input, status: "running" }; },
    run: async (context: RequestContext, id: string, input: unknown, listener: { onStart?: (run: { id: string }) => void; onDelta?: (event: unknown) => void }) => {
      workflows.getAgent(context, id); listener.onStart?.({ id: "run-stream" }); listener.onDelta?.({ runId: "run-stream", nodeId: "message", delta: "ok", text: "ok" });
      return { id: "run-stream", agentId: id, input, status: "success", output: "ok", error: null, durationMs: 1, nodeRuns: [] };
    },
  } as unknown as WorkflowEngine;
  installWorkflowRoutes(app, workflows, workflowEngine, (request) => identities.resolve(request));
  installKnowledgeRoutes(app, knowledge, vectors, embeddings, (request) => identities.resolve(request));

  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${key}` };
  const jsonHeaders = { ...headers, "Content-Type": "application/json" };
  try {
    const query = await fetch(`${base}/api/v1/query`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ question: "收入是多少", datasource_id: `source-${owner.user.tenantId}` }) });
    assert.equal(query.status, 200); assert.ok((await query.json() as { sessionId: string }).sessionId);

    const createdAgent = await fetch(`${base}/api/agents`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ name: "外部智能体" }) });
    assert.equal(createdAgent.status, 201);
    const agentId = (await createdAgent.json() as { agent: { id: string } }).agent.id;
    const run = await fetch(`${base}/api/agents/${agentId}/run`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ input: { query: "你好" } }) });
    assert.equal(run.status, 202);
    const stream = await fetch(`${base}/api/agents/${agentId}/run/stream`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ input: { query: "你好" } }) });
    assert.equal(stream.status, 200); assert.match(stream.headers.get("content-type") || "", /text\/event-stream/);
    const streamBody = await stream.text(); assert.match(streamBody, /event: start/); assert.match(streamBody, /event: delta/); assert.match(streamBody, /event: done/);

    const createdBase = await fetch(`${base}/api/knowledge-bases`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ name: "外部知识库" }) });
    assert.equal(createdBase.status, 201);
    const baseId = (await createdBase.json() as { knowledgeBase: { id: string } }).knowledgeBase.id;
    const upload = new FormData(); upload.append("file", new Blob(["问题,答案\n如何使用,使用同一个 API Key"], { type: "text/csv" }), "knowledge.csv"); upload.append("parserType", "qa"); upload.append("questionColumn", "问题"); upload.append("answerColumn", "答案");
    const uploaded = await fetch(`${base}/api/knowledge-bases/${baseId}/documents`, { method: "POST", headers, body: upload });
    assert.equal(uploaded.status, 201);
    const retrieve = await fetch(`${base}/api/v1/knowledge/retrieve`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ knowledge_base_id: baseId, query: "如何使用", score_threshold: -1 }) });
    assert.equal(retrieve.status, 200); assert.equal((await retrieve.json() as { items: unknown[] }).items.length, 1);

    const deniedAgent = await fetch(`${base}/api/agents/${agentId}/run`, { method: "POST", headers: { Authorization: `Bearer ${outsiderKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ input: {} }) });
    assert.equal(deniedAgent.status, 403);
    const deniedKnowledge = await fetch(`${base}/api/v1/knowledge/retrieve`, { method: "POST", headers: { Authorization: `Bearer ${outsiderKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ knowledge_base_id: baseId, query: "test" }) });
    assert.equal(deniedKnowledge.status, 403);
  } finally {
    server.close(); await once(server, "close"); sessions.close(); rmSync(directory, { recursive: true, force: true });
  }
});
