import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import type { RequestContext } from "../core/types.js";
import { installKnowledgeRoutes } from "./knowledge-routes.js";
import { KnowledgeStore } from "./knowledge-store.js";
import { ChromaVectorStore } from "./vector-store.js";

test("knowledge API processes documents, retrieves chunks, and isolates owners", async () => {
  const store = new KnowledgeStore(":memory:");
  const vectors = new ChromaVectorStore(":memory:");
  const app = express(); app.use(express.json());
  installKnowledgeRoutes(app, store, vectors, (request) => ({
    tenantId: String(request.header("x-test-tenant") || "tenant-a"),
    accountSetId: String(request.header("x-test-books") || "books-a"),
    userId: String(request.header("x-test-user") || "alice"),
    role: "tenant_admin", sessionId: "auth-session",
  } satisfies RequestContext));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const createdResponse = await fetch(`${base}/api/knowledge-bases`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "财务制度" }) });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { knowledgeBase: { id: string; config: { chunkSize: number } } };
    assert.equal(created.knowledgeBase.config.chunkSize, 800);

    const form = new FormData(); form.append("file", new Blob(["营业收入按照权责发生制确认。应收账款需要按月核对。"], { type: "text/plain" }), "finance.md");
    const uploaded = await fetch(`${base}/api/knowledge-bases/${created.knowledgeBase.id}/documents`, { method: "POST", body: form });
    assert.equal(uploaded.status, 201);
    const uploadedBody = await uploaded.json() as { document: { id: string; status: string; chunkCount: number } };
    assert.equal(uploadedBody.document.status, "ready"); assert.equal(uploadedBody.document.chunkCount, 1);

    const retrieved = await fetch(`${base}/api/knowledge-bases/${created.knowledgeBase.id}/retrieve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "营业收入如何确认" }) });
    assert.equal(retrieved.status, 200);
    const result = await retrieved.json() as { items: { filename: string; content: string }[] };
    assert.equal(result.items[0]?.filename, "finance.md"); assert.match(result.items[0]?.content || "", /营业收入/);

    for (const headers of [{ "x-test-user": "bob" }, { "x-test-tenant": "tenant-b" }, { "x-test-books": "books-b" }] as Record<string, string>[]) {
      assert.equal((await fetch(`${base}/api/knowledge-bases/${created.knowledgeBase.id}`, { headers })).status, 404);
      assert.equal((await fetch(`${base}/api/documents/${uploadedBody.document.id}`, { method: "DELETE", headers })).status, 404);
    }
    assert.equal((await fetch(`${base}/api/knowledge-bases`, { headers: { "x-test-user": "bob" } }).then((response) => response.json()) as { items: unknown[] }).items.length, 0);
  } finally {
    server.close(); await once(server, "close"); vectors.close(); store.close();
  }
});
