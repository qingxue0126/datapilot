import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express, { type Request } from "express";
import { AccountStore } from "../auth/account-store.js";
import { installAuthRoutes } from "../auth/auth-routes.js";
import type { RequestContext } from "../core/types.js";
import { TestEmbeddingProvider } from "./embedding.js";
import { installKnowledgeRoutes } from "./knowledge-routes.js";
import { KnowledgeStore } from "./knowledge-store.js";
import { LocalVectorStore, MilvusVectorStore } from "./vector-store.js";

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
    const form = new FormData(); form.append("file", new Blob([csv], { type: "text/csv" }), "高频问题.csv"); form.append("parserType", "qa");
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

    const previewResponse = await fetch(`${base}/api/documents/${uploadedBody.document.id}/preview`);
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json() as { preview: { kind: string; sheets: { rows: Record<string, unknown>[] }[] } };
    assert.equal(preview.preview.kind, "table");
    assert.equal(preview.preview.sheets[0].rows.length, 2);

    const retrieve = (body: object) => fetch(`${base}/api/knowledge-bases/${created.knowledgeBase.id}/retrieve`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const retrieved = await retrieve({ query: "好会计怎么删除凭证", topK: 5, scoreThreshold: -1, metadataFilter: { 产品: "好会计" } });
    assert.equal(retrieved.status, 200);
    const result = await retrieved.json() as { items: { rank: number; filename: string; metadata: Record<string, unknown> }[] };
    assert.equal(result.items.length, 1); assert.equal(result.items[0].rank, 1); assert.equal(result.items[0].filename, "高频问题.csv");

    const v1Retrieve = (body: object, headers: Record<string, string> = {}) => fetch(`${base}/api/v1/knowledge/retrieve`, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    const v1Response = await v1Retrieve({ knowledge_base_id: created.knowledgeBase.id, query: "好会计怎么删除凭证", filters: { 产品: "好会计", 模块: "凭证" }, top_k: 3, score_threshold: -1, rerank: true });
    assert.equal(v1Response.status, 200);
    const v1Result = await v1Response.json() as { items: { chunk_id: string; content: string; metadata: Record<string, unknown>; source: { filename: string } }[] };
    assert.equal(v1Result.items.length, 1);
    assert.match(v1Result.items[0].content, /答案：打开凭证列表后选择删除/);
    assert.equal(v1Result.items[0].metadata["产品"], "好会计");
    assert.equal(v1Result.items[0].source.filename, "高频问题.csv");
    assert.equal((await v1Retrieve({ knowledge_base_id: created.knowledgeBase.id, query: "报表", filters: {}, top_k: 5, score_threshold: -1 }).then((response) => response.json()) as { items: unknown[] }).items.length, 2);
    const invalidField = await v1Retrieve({ knowledge_base_id: created.knowledgeBase.id, query: "凭证", filters: { 不存在字段: "值" } });
    assert.equal(invalidField.status, 400);
    assert.match((await invalidField.json() as { error: string }).error, /过滤字段不存在/);
    const invalidValue = await v1Retrieve({ knowledge_base_id: created.knowledgeBase.id, query: "凭证", filters: { 产品: ["好会计"] } });
    assert.equal(invalidValue.status, 400);
    assert.match((await invalidValue.json() as { error: string }).error, /仅支持字符串、有限数字或布尔值/);
    assert.equal((await v1Retrieve({ knowledge_base_id: created.knowledgeBase.id, query: "凭证" }, { "x-test-user": "bob" })).status, 404);

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
      assert.equal((await fetch(`${base}/api/documents/${uploadedBody.document.id}/preview`, { headers })).status, 404);
      assert.equal((await fetch(`${base}/api/chunks/${chunkId}`, { method: "PATCH", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) })).status, 404);
    }

    const reparsed = await fetch(`${base}/api/documents/${uploadedBody.document.id}/reparse`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parserType: "table", metadataFields: ["产品"] }) });
    assert.equal(reparsed.status, 200); assert.equal((await reparsed.json() as { document: { status: string } }).document.status, "ready");

    const preservedParser = await fetch(`${base}/api/documents/${uploadedBody.document.id}/reparse`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parserType: "general", questionColumn: "问题", answerColumn: "答案", metadataFields: ["产品", "模块"] }),
    });
    assert.equal(preservedParser.status, 200);
    const preservedDocument = await preservedParser.json() as { document: { parserType: string; status: string } };
    assert.equal(preservedDocument.document.parserType, "table");
    assert.equal(preservedDocument.document.status, "ready");
    const preservedChunks = await fetch(`${base}/api/documents/${uploadedBody.document.id}/chunks`).then((response) => response.json()) as {
      items: { metadata: Record<string, unknown> }[];
    };
    assert.equal(preservedChunks.items[0].metadata["产品"], "好会计");
    assert.equal(preservedChunks.items[0].metadata["模块"], "凭证");
  } finally {
    server.close(); await once(server, "close"); vectors.close(); store.close();
  }
});

test("API and auth stay available while Milvus returns 503, then retrieval recovers without restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "datapilot-milvus-"));
  const store = new KnowledgeStore(":memory:");
  let factoryCalls = 0;
  const unavailable = {
    hasCollection: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:19530"); },
    createCollection: async () => ({ status: {} }), loadCollection: async () => ({ status: {} }), upsert: async () => ({ status: {} }),
    delete: async () => ({ status: {} }), search: async () => ({ results: [] }), closeConnection: async () => undefined,
  };
  const recovered = {
    hasCollection: async () => ({ value: true }), createCollection: async () => ({ status: {} }), loadCollection: async () => ({ status: {} }),
    upsert: async () => ({ status: {} }), delete: async () => ({ status: {} }), search: async () => ({ results: [] }), closeConnection: async () => undefined,
  };
  const vectors = new MilvusVectorStore({ address: "http://milvus:19530", collection: "knowledge" }, () => {
    factoryCalls += 1;
    return (factoryCalls === 1 ? unavailable : recovered) as never;
  });
  const app = express(); app.use(express.json());
  installAuthRoutes(app, new AccountStore(join(directory, "accounts.json")));
  installKnowledgeRoutes(app, store, vectors, new TestEmbeddingProvider(), () => aliceContext);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Test API did not start");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal(factoryCalls, 0, "starting the API must not initialize Milvus");
    const registered = await fetch(`${base}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "milvus-test", password: "Secure123", confirmPassword: "Secure123" }),
    });
    assert.equal(registered.status, 201);
    assert.equal(factoryCalls, 0, "auth must not initialize Milvus");

    const created = await fetch(`${base}/api/knowledge-bases`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Recovery test" }),
    }).then((response) => response.json()) as { knowledgeBase: { id: string } };
    const retrieve = () => fetch(`${base}/api/knowledge-bases/${created.knowledgeBase.id}/retrieve`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "test" }),
    });
    const unavailableResponse = await retrieve();
    assert.equal(unavailableResponse.status, 503);
    assert.deepEqual(await unavailableResponse.json(), { error: "Milvus unavailable" });

    const recoveredResponse = await retrieve();
    assert.equal(recoveredResponse.status, 200);
    assert.deepEqual((await recoveredResponse.json() as { items: unknown[] }).items, []);
    assert.equal(factoryCalls, 2);
  } finally {
    server.close(); await once(server, "close"); vectors.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});

const aliceContext: RequestContext = {
  tenantId: "tenant-a", accountSetId: "books-a", userId: "alice", role: "tenant_admin", sessionId: "auth-session",
};
