import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express, { type Request } from "express";
import type { RequestContext } from "../core/types.js";
import { TestEmbeddingProvider } from "./embedding.js";
import { installKnowledgeRoutes } from "./knowledge-routes.js";
import { KnowledgeStore } from "./knowledge-store.js";
import { LocalVectorStore } from "./vector-store.js";

test("knowledge API supports retrieval, chunk CRUD, reparse, disabled filtering, and owner isolation", async () => {
  const store = new KnowledgeStore(":memory:");
  const vectors = new LocalVectorStore(":memory:");
  const app = express(); app.use(express.json());
  installKnowledgeRoutes(app, store, vectors, new TestEmbeddingProvider(), (request: Request) => ({
    tenantId: String(request.header("x-test-tenant") || "tenant-a"),
    accountSetId: String(request.header("x-test-books") || "books-a"),
    userId: String(request.header("x-test-user") || "alice"),
    role: "tenant_admin", sessionId: "auth-session",
  } satisfies RequestContext));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const createdResponse = await fetch(`${base}/api/knowledge-bases`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "产品问答" }) });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { knowledgeBase: { id: string } };

    const csv = "产品,模块,问题,答案\n好会计,凭证,如何删除凭证,打开凭证列表后选择删除\n易代账,报表,如何导出报表,点击导出按钮";
    const form = new FormData(); form.append("file", new Blob([csv], { type: "text/csv" }), "faq.csv"); form.append("parserType", "qa");
    form.append("questionColumn", "问题"); form.append("answerColumn", "答案"); form.append("metadataFields", JSON.stringify(["产品", "模块"]));
    const uploaded = await fetch(`${base}/api/knowledge-bases/${created.knowledgeBase.id}/documents`, { method: "POST", body: form });
    assert.equal(uploaded.status, 201);
    const uploadedBody = await uploaded.json() as { document: { id: string; status: string; chunkCount: number } };
    assert.equal(uploadedBody.document.status, "ready"); assert.equal(uploadedBody.document.chunkCount, 2);

    const chunksResponse = await fetch(`${base}/api/documents/${uploadedBody.document.id}/chunks`);
    assert.equal(chunksResponse.status, 200);
    const chunks = await chunksResponse.json() as { items: { id: string; content: string; metadata: Record<string, unknown>; enabled: boolean }[] };
    assert.equal(chunks.items[0].metadata["产品"], "好会计");
    assert.match(chunks.items[0].content, /问题：如何删除凭证/);

    const retrieve = (body: object) => fetch(`${base}/api/knowledge-bases/${created.knowledgeBase.id}/retrieve`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const retrieved = await retrieve({ query: "好会计怎么删除凭证", topK: 5, scoreThreshold: -1, metadataFilter: { 产品: "好会计" } });
    assert.equal(retrieved.status, 200);
    const result = await retrieved.json() as { items: { rank: number; filename: string; metadata: Record<string, unknown> }[] };
    assert.equal(result.items.length, 1); assert.equal(result.items[0].rank, 1); assert.equal(result.items[0].filename, "faq.csv");

    const chunkId = chunks.items[0].id;
    const disabled = await fetch(`${base}/api/chunks/${chunkId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    assert.equal(disabled.status, 200);
    assert.equal((await retrieve({ query: "删除凭证", scoreThreshold: -1, metadataFilter: { 产品: "好会计" } }).then((response) => response.json()) as { items: unknown[] }).items.length, 0);

    const edited = await fetch(`${base}/api/chunks/${chunkId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true, content: "问题：如何删除凭证？\n答案：先反记账再删除。", metadata: { 产品: "好会计", 模块: "凭证" } }) });
    assert.equal(edited.status, 200);
    assert.match((await edited.json() as { chunk: { content: string } }).chunk.content, /反记账/);

    for (const headers of [{ "x-test-user": "bob" }, { "x-test-tenant": "tenant-b" }, { "x-test-books": "books-b" }] as Record<string, string>[]) {
      assert.equal((await fetch(`${base}/api/knowledge-bases/${created.knowledgeBase.id}`, { headers })).status, 404);
      assert.equal((await fetch(`${base}/api/documents/${uploadedBody.document.id}/chunks`, { headers })).status, 404);
      assert.equal((await fetch(`${base}/api/chunks/${chunkId}`, { method: "PATCH", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) })).status, 404);
    }

    const reparsed = await fetch(`${base}/api/documents/${uploadedBody.document.id}/reparse`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parserType: "table", metadataFields: ["产品"] }) });
    assert.equal(reparsed.status, 200); assert.equal((await reparsed.json() as { document: { status: string } }).document.status, "ready");
  } finally {
    server.close(); await once(server, "close"); vectors.close(); store.close();
  }
});
