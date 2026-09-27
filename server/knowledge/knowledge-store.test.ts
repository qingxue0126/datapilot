import assert from "node:assert/strict";
import test from "node:test";
import type { RequestContext } from "../core/types.js";
import { chunkText } from "./document-pipeline.js";
import { KnowledgeStore, KnowledgeStoreError } from "./knowledge-store.js";

const alice: RequestContext = { tenantId: "tenant-a", accountSetId: "books-a", userId: "alice", role: "tenant_admin", sessionId: "auth-a" };
const bob: RequestContext = { ...alice, userId: "bob" };

test("knowledge store scopes bases, documents, and chunks to the full owner context", () => {
  const store = new KnowledgeStore(":memory:");
  try {
    const knowledgeBase = store.create(alice, { name: "制度库", config: { chunkSize: 500, topK: 8 } });
    const document = store.createDocument(alice, knowledgeBase.id, { filename: "rules.txt", fileType: "TXT", size: 20, parserType: "general", source: Buffer.from("测试内容") });
    store.replaceChunks(alice, document.id, [{ id: "chunk-1", content: "测试内容", metadata: { 产品: "好会计" } }]);
    store.setDocumentStatus(alice, document.id, "ready");
    assert.equal(store.get(alice, knowledgeBase.id).knowledgeBase.chunkCount, 1);
    assert.equal(store.get(alice, knowledgeBase.id).knowledgeBase.config.topK, 8);
    assert.equal(store.list(bob).length, 0);
    assert.throws(() => store.get(bob, knowledgeBase.id), (error: KnowledgeStoreError) => error.status === 404);
    assert.throws(() => store.document(bob, document.id), (error: KnowledgeStoreError) => error.status === 404);
    assert.throws(() => store.listChunks(bob, document.id), (error: KnowledgeStoreError) => error.status === 404);
    assert.throws(() => store.updateChunk(bob, "chunk-1", { enabled: false }), (error: KnowledgeStoreError) => error.status === 404);
  } finally { store.close(); }
});

test("chunk CRUD persists content, metadata, enabled, and updated timestamp", () => {
  const store = new KnowledgeStore(":memory:");
  try {
    const base = store.create(alice, { name: "FAQ" });
    const document = store.createDocument(alice, base.id, { filename: "faq.csv", fileType: "CSV", size: 10, parserType: "table", source: Buffer.from("a,b") });
    store.replaceChunks(alice, document.id, [{ id: "chunk-1", content: "问题：旧问题", metadata: { 产品: "好会计" } }]);
    const changed = store.updateChunk(alice, "chunk-1", { content: "问题：新问题", metadata: { 模块: "凭证" }, enabled: false });
    assert.equal(changed.content, "问题：新问题"); assert.deepEqual(changed.metadata, { 模块: "凭证" }); assert.equal(changed.enabled, false);
    assert.equal(store.listChunks(alice, document.id)[0].characterCount, 6);
  } finally { store.close(); }
});

test("changing the embedding model marks vectors stale until reindexed", () => {
  const store = new KnowledgeStore(":memory:");
  try {
    const base = store.create(alice, { name: "FAQ" });
    assert.equal(base.requiresReindex, false);
    assert.equal(store.update(alice, base.id, { config: { embeddingModel: "embedding-model-id" } }).requiresReindex, true);
    store.markReindexed(alice, base.id);
    assert.equal(store.get(alice, base.id).knowledgeBase.requiresReindex, false);
  } finally { store.close(); }
});

test("chunking honors size and overlap", () => {
  const chunks = chunkText("一".repeat(1200), 500, 100);
  assert.deepEqual(chunks.map((item) => item.length), [500, 500, 400]);
  assert.equal(chunks[0].slice(-100), chunks[1].slice(0, 100));
});
