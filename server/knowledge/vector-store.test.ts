import assert from "node:assert/strict";
import test from "node:test";
import type { RequestContext } from "../core/types.js";
import { LocalVectorStore, MilvusUnavailableError, MilvusVectorStore } from "./vector-store.js";

const alice: RequestContext = { tenantId: "tenant-a", accountSetId: "books-a", userId: "alice", role: "tenant_admin", sessionId: "auth-a" };

test("local test vector adapter applies metadata AND filters, disabled filtering, and tenant isolation", async () => {
  const vectors = new LocalVectorStore(":memory:");
  try {
    vectors.upsert(alice, [
      { id: "one", knowledgeBaseId: "kb", documentId: "doc", content: "删除凭证", embedding: [1, 0], metadata: { 产品: "好会计", 模块: "凭证" }, enabled: true },
      { id: "two", knowledgeBaseId: "kb", documentId: "doc", content: "导出报表", embedding: [1, 0], metadata: { 产品: "好会计", 模块: "报表" }, enabled: true },
      { id: "three", knowledgeBaseId: "kb", documentId: "doc", content: "禁用内容", embedding: [1, 0], metadata: { 产品: "好会计", 模块: "凭证" }, enabled: false },
    ]);
    assert.deepEqual((await vectors.search(alice, "kb", [1, 0], { limit: 10, metadataFilter: { 产品: "好会计", 模块: "凭证" } })).map((item) => item.id), ["one"]);
    assert.equal((await vectors.search({ ...alice, tenantId: "tenant-b" }, "kb", [1, 0], { limit: 10 })).length, 0);
  } finally { vectors.close(); }
});

test("Milvus adapter creates the required schema and scopes every search before metadata filtering", async () => {
  const calls: { create?: Record<string, unknown>; upsert?: Record<string, unknown>; search?: Record<string, unknown> } = {};
  const client = {
    hasCollection: async () => ({ value: false }),
    createCollection: async (input: Record<string, unknown>) => { calls.create = input; return { status: {} }; },
    loadCollection: async () => ({ status: {} }),
    upsert: async (input: Record<string, unknown>) => { calls.upsert = input; return { status: {} }; },
    delete: async () => ({ status: {} }),
    search: async (input: Record<string, unknown>) => { calls.search = input; return { results: [{ chunk_id: "chunk", knowledge_base_id: "kb", document_id: "doc", content: "内容", metadata: { 产品: "好会计" }, enabled: true, score: 0.91 }] }; },
    closeConnection: async () => undefined,
  };
  const vectors = new MilvusVectorStore({ address: "http://milvus:19530", collection: "knowledge" }, client as never);
  await vectors.upsert(alice, [{ id: "chunk", knowledgeBaseId: "kb", documentId: "doc", content: "内容", embedding: [1, 0, 0], metadata: { 产品: "好会计" }, enabled: true }]);
  const fields = calls.create?.fields as { name: string }[];
  assert.deepEqual(fields.map((field) => field.name), ["chunk_id", "tenant_id", "account_set_id", "user_id", "knowledge_base_id", "document_id", "content", "embedding", "metadata", "enabled"]);
  assert.equal((calls.upsert?.data as unknown[]).length, 1);
  const result = await vectors.search(alice, "kb", [1, 0, 0], { limit: 5, metadataFilter: { 产品: "好会计", 模块: "凭证" } });
  const filter = String(calls.search?.filter);
  assert.match(filter, /tenant_id == "tenant-a"/); assert.match(filter, /account_set_id == "books-a"/); assert.match(filter, /user_id == "alice"/);
  assert.match(filter, /knowledge_base_id == "kb"/); assert.match(filter, /enabled == true/); assert.match(filter, /metadata\["产品"\] == "好会计"/); assert.match(filter, /metadata\["模块"\] == "凭证"/);
  assert.equal(result[0].score, 0.91);
});

test("Milvus client is lazy and retries with a new client after an unavailable request", async () => {
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

  assert.equal(factoryCalls, 0);
  assert.equal(vectors.availability, "unknown");
  await assert.rejects(() => vectors.search(alice, "kb", [1, 0], { limit: 5 }), MilvusUnavailableError);
  assert.equal(factoryCalls, 1);
  assert.equal(vectors.availability, "unavailable");
  assert.deepEqual(await vectors.search(alice, "kb", [1, 0], { limit: 5 }), []);
  assert.equal(factoryCalls, 2);
  assert.equal(vectors.availability, "available");
});
