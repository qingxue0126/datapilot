import assert from "node:assert/strict";
import test from "node:test";
import type { RequestContext } from "../core/types.js";
import type { ModelProvider, ModelProviderRegistry } from "./model-provider.js";
import { ModelRouter } from "./model-router.js";
import { ModelService } from "./model-service.js";
import { ModelStore } from "./model-store.js";

const context: RequestContext = { tenantId: "t", accountSetId: "a", userId: "u", role: "tenant_admin", sessionId: "s" };
const config = (name: string) => ({ name, provider: "openai-compatible" as const, modelId: name, baseUrl: "https://api.example.test/v1", apiKey: "sk-test",
  contextWindow: 8000, timeout: 5000, maxRetries: 0, temperature: 0, supportsTools: true, supportsStructuredOutput: true, supportsVision: false, enabled: true });

test("model service retries primary then uses task fallback", async () => {
  const store = new ModelStore(":memory:", Buffer.alloc(32, 4));
  const primary = store.create(context, config("primary")); const fallback = store.create(context, config("fallback"));
  store.saveRoute(context, "answer", { primaryModelId: primary.id, fallbackModelId: fallback.id, maxRetries: 1 });
  const calls: string[] = [];
  const provider: ModelProvider = {
    async chat(model) { calls.push(model.modelId); if (model.id === primary.id) throw new Error("primary unavailable"); return { content: '{"summary":"ok"}', latencyMs: 4 }; },
    async testConnection() { return { content: "OK", latencyMs: 3 }; },
  };
  const registry = { get: () => provider } as unknown as ModelProviderRegistry;
  const service = new ModelService(store, new ModelRouter(store), registry);
  const result = await service.structured<{ summary: string }>([{ role: "user", content: "test" }], { context, task: "answer" });
  assert.equal(result.summary, "ok");
  assert.deepEqual(calls, ["primary", "primary", "fallback"]);
});

test("connection testing stores only public status information", async () => {
  const store = new ModelStore(":memory:", Buffer.alloc(32, 5)); const model = store.create(context, config("test"));
  const provider: ModelProvider = { async chat() { throw new Error("unused"); }, async testConnection() { return { content: "OK", latencyMs: 12 }; } };
  const service = new ModelService(store, new ModelRouter(store), { get: () => provider } as unknown as ModelProviderRegistry);
  assert.deepEqual(await service.testConnection(context, model.id), { success: true, latencyMs: 12 });
  const publicModel = store.get(context, model.id);
  assert.equal(publicModel.lastTestStatus, "success"); assert.equal(publicModel.lastTestLatencyMs, 12); assert.equal("apiKey" in publicModel, false);
});

test("embedding calls use only enabled embedding model configurations", async () => {
  const store = new ModelStore(":memory:", Buffer.alloc(32, 6));
  const embedding = store.create(context, { ...config("embedding"), modelType: "embedding" });
  const chat = store.create(context, config("chat"));
  const provider: ModelProvider = {
    async chat() { throw new Error("unused"); },
    async testConnection() { return { content: "OK", latencyMs: 1 }; },
    async embed(_model, texts) { return texts.map((_text, index) => [1, index]); },
  };
  const service = new ModelService(store, new ModelRouter(store), { get: () => provider } as unknown as ModelProviderRegistry);
  assert.deepEqual(await service.embedBatch(context, embedding.id, ["a", "b"]), [[1, 0], [1, 1]]);
  await assert.rejects(() => service.embed(context, chat.id, "a"), /Embedding 模型/);
});
