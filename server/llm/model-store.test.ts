import assert from "node:assert/strict";
import test from "node:test";
import type { RequestContext } from "../core/types.js";
import { ModelStore } from "./model-store.js";
import { modelTypes, type LegacyModelType, type ModelCapability, type ModelType } from "./model-types.js";

const owner: RequestContext = { tenantId: "tenant-a", accountSetId: "set-a", userId: "user-a", role: "tenant_admin", sessionId: "session-a" };
const otherUser: RequestContext = { ...owner, userId: "user-b", sessionId: "session-b" };
const otherTenant: RequestContext = { ...owner, tenantId: "tenant-b", sessionId: "session-c" };

function input(name = "Finance LLM", modelType?: LegacyModelType) {
  return { name, provider: "openai-compatible" as const, modelId: "finance-model", baseUrl: "https://llm.example.test/v1", apiKey: "sk-secret-abcd",
    modelType,
    contextWindow: 32_000, timeout: 30_000, maxRetries: 2, temperature: 0.1, supportsTools: true,
    supportsStructuredOutput: true, supportsVision: false, enabled: true };
}

test("model store masks secrets and preserves an omitted key on update", () => {
  const store = new ModelStore(":memory:", Buffer.alloc(32, 7));
  const created = store.create(owner, input());
  assert.equal(created.apiKeyMasked, "sk-****abcd");
  assert.equal("apiKey" in created, false);
  assert.equal(store.runtime(owner, created.id).apiKey, "sk-secret-abcd");
  const updated = store.update(owner, created.id, { name: "Updated" });
  assert.equal(updated.name, "Updated");
  assert.equal(store.runtime(owner, created.id).apiKey, "sk-secret-abcd");
});

test("legacy chat configurations normalize to llm", () => {
  const store = new ModelStore(":memory:", Buffer.alloc(32, 10));
  const created = store.create(owner, input("Legacy Chat", "chat"));
  assert.equal(created.modelType, "llm");
  assert.ok(created.capabilities.includes("chat"));
});

test("model store creates and updates all seven model types", () => {
  const store = new ModelStore(":memory:", Buffer.alloc(32, 11));
  for (const modelType of modelTypes) {
    const created = store.create(owner, { ...input(modelType, modelType), capabilities: capabilityFor(modelType), embeddingDimension: 1024, maxInputTokens: 8192, topN: 5 });
    assert.equal(created.modelType, modelType);
    assert.ok(created.capabilities.length > 0);
    assert.equal("apiKey" in created, false);
    assert.equal(store.update(owner, created.id, { name: `${modelType}-updated` }).name, `${modelType}-updated`);
  }
  assert.equal(store.list(owner).length, modelTypes.length);
});

test("ERP routes reject embedding and rerank models", () => {
  const store = new ModelStore(":memory:", Buffer.alloc(32, 12));
  const llm = store.create(owner, input("LLM", "llm"));
  const embedding = store.create(owner, input("Embedding", "embedding"));
  const rerank = store.create(owner, input("Rerank", "rerank"));
  assert.equal(store.saveRoute(owner, "agent", { primaryModelId: llm.id }).primaryModelId, llm.id);
  assert.throws(() => store.saveRoute(owner, "agent", { primaryModelId: embedding.id }), /只能选择 LLM/);
  assert.throws(() => store.saveRoute(owner, "agent", { primaryModelId: rerank.id }), /只能选择 LLM/);
});

function capabilityFor(modelType: ModelType): ModelCapability[] {
  if (modelType === "embedding") return ["text_embedding"];
  if (modelType === "rerank") return ["text_rerank"];
  if (modelType === "vision") return ["vision"];
  if (modelType === "multimodal_embedding") return ["multimodal_embedding"];
  if (modelType === "multimodal_rerank") return ["multimodal_rerank"];
  return ["chat"];
}

test("model store isolates user, tenant and account-set ownership", () => {
  const store = new ModelStore(":memory:", Buffer.alloc(32, 8));
  const created = store.create(owner, input());
  assert.throws(() => store.get(otherUser, created.id), /不存在或无权访问/);
  assert.throws(() => store.get(otherTenant, created.id), /不存在或无权访问/);
  assert.equal(store.list(otherUser).some((model) => model.id === created.id), false);
});

test("model routes validate ownership and clear references when a model is deleted", () => {
  const store = new ModelStore(":memory:", Buffer.alloc(32, 9));
  const primary = store.create(owner, input("Primary"));
  const fallback = store.create(owner, input("Fallback"));
  const route = store.saveRoute(owner, "text2sql", { primaryModelId: primary.id, fallbackModelId: fallback.id, temperature: 0.2, timeout: 15_000, maxRetries: 1 });
  assert.equal(route.primaryModelId, primary.id);
  assert.throws(() => store.saveRoute(otherUser, "text2sql", { primaryModelId: primary.id }), /不存在或无权访问/);
  store.delete(owner, fallback.id);
  assert.equal(store.listRoutes(owner).find((item) => item.task === "text2sql")?.fallbackModelId, null);
});
