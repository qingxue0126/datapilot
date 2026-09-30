import assert from "node:assert/strict";
import test from "node:test";
import type { RequestContext } from "../core/types.js";
import { LocalVectorStore, metadataMatches, MilvusUnavailableError, MilvusVectorStore } from "./vector-store.js";

const alice: RequestContext = { tenantId: "tenant-a", accountSetId: "books-a", userId: "alice", role: "tenant_admin", sessionId: "auth-a" };

test("containsToken uses slash-delimited exact token matching and preserves equality filters", () => {
  for (const [token, value] of [
    ["T3", "T3"], ["T3", "T3/T6"], ["T3", "U8/T3/T6"], ["T6", "T3/T6"],
    ["U8", "U8/T3/T6"], ["T+", "T+"], ["好会计", "好会计/易代账"],
  ]) assert.equal(metadataMatches({ 适用产品: value }, { 适用产品: { $containsToken: token } }), true);
  assert.equal(metadataMatches({ 适用产品: "T30" }, { 适用产品: { $containsToken: "T3" } }), false);
  assert.equal(metadataMatches({ 适用产品: "T3/T6" }, { 适用产品: "T3" }), false);
  assert.equal(metadataMatches({ 适用产品: "T3" }, { 适用产品: "T3" }), true);
});

test("local vector adapter supports containsToken filters", async () => {
  const vectors = new LocalVectorStore(":memory:");
  try {
    vectors.upsert(alice, [
      { id: "t3", knowledgeBaseId: "kb", documentId: "doc", content: "T3", embedding: [1, 0], metadata: { 适用产品: "U8/T3/T6" }, enabled: true },
      { id: "t30", knowledgeBaseId: "kb", documentId: "doc", content: "T30", embedding: [1, 0], metadata: { 适用产品: "T30" }, enabled: true },
    ]);
    const result = await vectors.search(alice, "kb", [1, 0], { limit: 10, metadataFilter: { 适用产品: { $containsToken: "T3" } } });
    assert.deepEqual(result.map((item) => item.id), ["t3"]);
  } finally { vectors.close(); }
});

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
    dropCollection: async () => ({ status: {} }),
    loadCollection: async () => ({ status: {} }),
    upsert: async (input: Record<string, unknown>) => { calls.upsert = input; return { status: {} }; },
    delete: async () => ({ status: {} }),
    search: async (input: Record<string, unknown>) => { calls.search = input; return { results: [{ chunk_id: "chunk", knowledge_base_id: "kb", document_id: "doc", content: "内容", metadata: { 产品: "好会计", 模块: "凭证" }, enabled: true, score: 0.91 }] }; },
    closeConnection: async () => undefined,
  };
  const vectors = new MilvusVectorStore({ address: "http://milvus:19530", collection: "knowledge" }, client as never);
  const indexConfig = { indexType: "HNSW" as const, metricType: "COSINE" as const, hnswM: 24, hnswEfConstruction: 256 };
  await vectors.upsert(alice, [{ id: "chunk", knowledgeBaseId: "kb", documentId: "doc", content: "内容", embedding: [1, 0, 0], metadata: { 产品: "好会计" }, enabled: true }], indexConfig);
  const fields = calls.create?.fields as { name: string }[];
  assert.deepEqual(fields.map((field) => field.name), ["chunk_id", "tenant_id", "account_set_id", "user_id", "knowledge_base_id", "document_id", "content", "embedding", "metadata", "enabled"]);
  assert.equal(calls.create?.collection_name, "knowledge_kb");
  assert.deepEqual(calls.create?.index_params, { field_name: "embedding", index_name: "embedding_hnsw_cosine", index_type: "HNSW", metric_type: "COSINE", params: { M: 24, efConstruction: 256 } });
  assert.equal((calls.upsert?.data as unknown[]).length, 1);
  const result = await vectors.search(alice, "kb", [1, 0, 0], { limit: 5, metadataFilter: { 产品: "好会计", 模块: "凭证" }, indexConfig });
  const filter = String(calls.search?.filter);
  assert.match(filter, /tenant_id == "tenant-a"/); assert.match(filter, /account_set_id == "books-a"/); assert.match(filter, /user_id == "alice"/);
  assert.match(filter, /knowledge_base_id == "kb"/); assert.match(filter, /enabled == true/); assert.match(filter, /metadata\["产品"\] == "好会计"/); assert.match(filter, /metadata\["模块"\] == "凭证"/);
  assert.equal(result[0].score, 0.91);
});

test("Milvus keeps containsToken out of JSON expressions and applies exact post-filtering", async () => {
  let searchInput: Record<string, unknown> | undefined;
  const client = {
    hasCollection: async () => ({ value: true }), createCollection: async () => ({ status: {} }), dropCollection: async () => ({ status: {} }),
    loadCollection: async () => ({ status: {} }), upsert: async () => ({ status: {} }), delete: async () => ({ status: {} }),
    search: async (input: Record<string, unknown>) => { searchInput = input; return { results: [
      { chunk_id: "match", knowledge_base_id: "kb", document_id: "doc", content: "T3", metadata: { 适用产品: "U8/T3/T6", 模块: "采购" }, enabled: true, score: 0.9 },
      { chunk_id: "substring", knowledge_base_id: "kb", document_id: "doc", content: "T30", metadata: { 适用产品: "T30", 模块: "采购" }, enabled: true, score: 0.8 },
    ] }; }, closeConnection: async () => undefined,
  };
  const vectors = new MilvusVectorStore({ address: "http://milvus:19530", collection: "knowledge" }, client as never);
  const result = await vectors.search(alice, "kb", [1, 0], { limit: 10, metadataFilter: { 适用产品: { $containsToken: "T3" }, 模块: "采购" } });
  assert.deepEqual(result.map((item) => item.id), ["match"]);
  assert.doesNotMatch(String(searchInput?.filter), /contains|T3/);
  assert.match(String(searchInput?.filter), /metadata\["模块"\] == "采购"/);
});

test("local vector adapter filters configured Excel metadata before scoring candidates", async () => {
  const vectors = new LocalVectorStore(":memory:");
  try {
    await vectors.upsert(alice, [
      { id: "match", knowledgeBaseId: "kb", documentId: "doc", content: "问题：如何增加外币科目？\n答案：进入设置。", embedding: [1, 0],
        metadata: { Porduct: "好会计", Module: "基础档案", Question_TyPe: "会计科目" }, enabled: true },
      { id: "other", knowledgeBaseId: "kb", documentId: "doc", content: "其他问题", embedding: [1, 0],
        metadata: { Porduct: "好会计", Module: "总账", Question_TyPe: "月末处理" }, enabled: true },
    ]);
    const result = await vectors.search(alice, "kb", [1, 0], {
      limit: 5,
      metadataFilter: { Porduct: "好会计", Module: "基础档案", Question_TyPe: "会计科目" },
    });
    assert.deepEqual(result.map((item) => item.id), ["match"]);
    assert.equal(result[0].content, "问题：如何增加外币科目？\n答案：进入设置。");
  } finally { vectors.close(); }
});

test("Milvus client is lazy and retries with a new client after an unavailable request", async () => {
  let factoryCalls = 0;
  const unavailable = {
    hasCollection: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:19530"); },
    createCollection: async () => ({ status: {} }), loadCollection: async () => ({ status: {} }), upsert: async () => ({ status: {} }),
    dropCollection: async () => ({ status: {} }), delete: async () => ({ status: {} }), search: async () => ({ results: [] }), closeConnection: async () => undefined,
  };
  const recovered = {
    hasCollection: async () => ({ value: true }), createCollection: async () => ({ status: {} }), loadCollection: async () => ({ status: {} }),
    dropCollection: async () => ({ status: {} }), upsert: async () => ({ status: {} }), delete: async () => ({ status: {} }), search: async () => ({ results: [] }), closeConnection: async () => undefined,
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

test("Milvus constructor connection rejection is observed and does not escape the adapter", async () => {
  let unhandled: unknown;
  const onUnhandled = (error: unknown) => { unhandled = error; };
  process.on("unhandledRejection", onUnhandled);
  const connectionError = new Error("connect ECONNREFUSED 127.0.0.1:19530");
  const client = {
    connectPromise: Promise.reject(connectionError),
    hasCollection: async () => { throw connectionError; },
    createCollection: async () => ({ status: {} }), loadCollection: async () => ({ status: {} }), upsert: async () => ({ status: {} }),
    dropCollection: async () => ({ status: {} }), delete: async () => ({ status: {} }), search: async () => ({ results: [] }), closeConnection: async () => undefined,
  };
  const vectors = new MilvusVectorStore({ address: "http://milvus:19530", collection: "knowledge" }, () => client as never);
  try {
    await assert.rejects(() => vectors.search(alice, "kb", [1, 0], { limit: 5 }), MilvusUnavailableError);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled, undefined);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("Milvus reindex drops and recreates only the knowledge-base collection with new index settings", async () => {
  const calls: { dropped?: string; created?: Record<string, unknown> } = {};
  let collectionExists = true;
  const client = {
    hasCollection: async () => ({ value: collectionExists }),
    dropCollection: async (input: { collection_name: string }) => { calls.dropped = input.collection_name; collectionExists = false; return { status: {} }; },
    createCollection: async (input: Record<string, unknown>) => { calls.created = input; collectionExists = true; return { status: {} }; },
    loadCollection: async () => ({ status: {} }), upsert: async () => ({ status: {} }), delete: async () => ({ status: {} }),
    search: async () => ({ results: [] }), closeConnection: async () => undefined,
  };
  const vectors = new MilvusVectorStore({ address: "http://milvus:19530", collection: "knowledge" }, client as never);
  await vectors.deleteKnowledgeBase(alice, "kb-one");
  await vectors.upsert(alice, [{ id: "chunk", knowledgeBaseId: "kb-one", documentId: "doc", content: "内容", embedding: [1, 0], metadata: {}, enabled: true }],
    { indexType: "HNSW", metricType: "L2", hnswM: 32, hnswEfConstruction: 300 });
  assert.equal(calls.dropped, "knowledge_kb_one");
  assert.equal(calls.created?.collection_name, "knowledge_kb_one");
  assert.deepEqual(calls.created?.index_params, { field_name: "embedding", index_name: "embedding_hnsw_l2", index_type: "HNSW", metric_type: "L2", params: { M: 32, efConstruction: 300 } });
});
