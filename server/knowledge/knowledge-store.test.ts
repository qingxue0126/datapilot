import assert from "node:assert/strict";
import test from "node:test";
import type { RequestContext } from "../core/types.js";
import { chunkText } from "./document-pipeline.js";
import { KnowledgeStore, KnowledgeStoreError } from "./knowledge-store.js";

const alice: RequestContext = { tenantId: "tenant-a", accountSetId: "books-a", userId: "alice", role: "tenant_admin", sessionId: "auth-a" };
const bob: RequestContext = { ...alice, userId: "bob" };

test("knowledge store scopes bases and documents to the full owner context", () => {
  const store = new KnowledgeStore(":memory:");
  try {
    const knowledgeBase = store.create(alice, { name: "制度库", config: { chunkSize: 500, topK: 8 } });
    const document = store.createDocument(alice, knowledgeBase.id, { filename: "rules.txt", fileType: "TXT", size: 20 });
    store.replaceChunks(alice, document.id, [{ id: "chunk-1", content: "测试内容" }]);
    store.setDocumentStatus(alice, document.id, "ready");
    assert.equal(store.get(alice, knowledgeBase.id).knowledgeBase.chunkCount, 1);
    assert.equal(store.get(alice, knowledgeBase.id).knowledgeBase.config.topK, 8);
    assert.equal(store.list(bob).length, 0);
    assert.throws(() => store.get(bob, knowledgeBase.id), (error: KnowledgeStoreError) => error.status === 404);
    assert.throws(() => store.document(bob, document.id), (error: KnowledgeStoreError) => error.status === 404);
  } finally { store.close(); }
});

test("chunking honors size and overlap", () => {
  const chunks = chunkText("一".repeat(1200), 500, 100);
  assert.deepEqual(chunks.map((item) => item.length), [500, 500, 400]);
  assert.equal(chunks[0].slice(-100), chunks[1].slice(0, 100));
});
