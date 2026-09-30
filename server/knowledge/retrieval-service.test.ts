import assert from "node:assert/strict";
import test from "node:test";
import type { RequestContext } from "../core/types.js";
import { TestEmbeddingProvider } from "./embedding.js";
import { KnowledgeRetrievalService, validateMetadata } from "./retrieval-service.js";
import { KnowledgeStore } from "./knowledge-store.js";
import { LocalVectorStore, MilvusVectorStore, type VectorRecord } from "./vector-store.js";

const context: RequestContext = { tenantId: "tenant-a", accountSetId: "books-a", userId: "alice", role: "tenant_admin", sessionId: "session" };

function fixture() {
  const store = new KnowledgeStore(":memory:");
  const knowledgeBase = store.create(context, { name: "ERP products" });
  const document = store.createDocument(context, knowledgeBase.id, { filename: "products.csv", fileType: "CSV", size: 10 });
  const chunks = [
    { id: "t3", content: "T3 product help", metadata: { 适用产品: "U8/T3/T6" }, enabled: true },
    { id: "t30", content: "T30 product help", metadata: { 适用产品: "T30" }, enabled: true },
  ];
  store.replaceChunks(context, document.id, chunks);
  const records: VectorRecord[] = chunks.map((chunk) => ({ ...chunk, knowledgeBaseId: knowledgeBase.id, documentId: document.id, embedding: [1, 0] }));
  return { store, knowledgeBase, records };
}

test("filter validation accepts containsToken and rejects unknown operators or invalid values", () => {
  assert.deepEqual(validateMetadata({ 适用产品: { $containsToken: " T3 " } }), { 适用产品: { $containsToken: "T3" } });
  assert.deepEqual(validateMetadata({ 适用产品: "T3" }), { 适用产品: "T3" });
  assert.throws(() => validateMetadata({ 适用产品: { $contains: "T3" } }), /仅支持 \$containsToken/);
  assert.throws(() => validateMetadata({ 适用产品: { $containsToken: 3 } }), /必须是非空字符串/);
});

test("vector and hybrid retrieval apply identical containsToken semantics", async () => {
  const { store, knowledgeBase, records } = fixture();
  const vectors = new LocalVectorStore(":memory:");
  try {
    vectors.upsert(context, records);
    const service = new KnowledgeRetrievalService(store, vectors, new TestEmbeddingProvider());
    const baseRequest = { knowledgeBaseId: knowledgeBase.id, query: "product help", filters: { 适用产品: { $containsToken: "T3" } }, topK: 10, scoreThreshold: -1 } as const;
    const vector = await service.retrieve(context, { ...baseRequest, retrievalMode: "vector" });
    const hybrid = await service.retrieve(context, { ...baseRequest, retrievalMode: "hybrid", vectorWeight: 1 });
    assert.deepEqual(vector.items.map((item) => item.chunkId), ["t3"]);
    assert.deepEqual(hybrid.items.map((item) => item.chunkId), ["t3"]);
  } finally { vectors.close(); store.close(); }
});

test("Milvus retrieval expands candidates and service-level filtering removes substring matches", async () => {
  const { store, knowledgeBase, records } = fixture();
  let searchInput: Record<string, unknown> | undefined;
  const client = {
    hasCollection: async () => ({ value: true }), createCollection: async () => ({ status: {} }), dropCollection: async () => ({ status: {} }),
    loadCollection: async () => ({ status: {} }), upsert: async () => ({ status: {} }), delete: async () => ({ status: {} }),
    search: async (input: Record<string, unknown>) => { searchInput = input; return { results: records.map((record, index) => ({
      chunk_id: record.id, knowledge_base_id: record.knowledgeBaseId, document_id: record.documentId, content: record.content,
      metadata: record.metadata, enabled: true, score: 0.9 - index * 0.1,
    })) }; }, closeConnection: async () => undefined,
  };
  const vectors = new MilvusVectorStore({ address: "http://milvus:19530", collection: "knowledge" }, client as never);
  try {
    const service = new KnowledgeRetrievalService(store, vectors, new TestEmbeddingProvider());
    const result = await service.retrieve(context, { knowledgeBaseId: knowledgeBase.id, query: "product", filters: { 适用产品: { $containsToken: "T3" } }, topK: 1, candidateCount: 1, scoreThreshold: -1 });
    assert.deepEqual(result.items.map((item) => item.chunkId), ["t3"]);
    assert.ok(Number(searchInput?.limit) >= 10);
    assert.doesNotMatch(String(searchInput?.filter), /contains|T3/);
  } finally { vectors.close(); store.close(); }
});
