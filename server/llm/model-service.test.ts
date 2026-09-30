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

test("streaming model service never retries after emitting a token", async () => {
  const store = new ModelStore(":memory:", Buffer.alloc(32, 20));
  const primary = store.create(context, config("primary-stream"));
  const fallback = store.create(context, config("fallback-stream"));
  store.saveRoute(context, "answer", { primaryModelId: primary.id, fallbackModelId: fallback.id, maxRetries: 2 });
  const calls: string[] = [];
  const provider: ModelProvider = {
    async chat(model, request) {
      calls.push(model.modelId);
      request.onToken?.("部分回答");
      throw new Error("upstream disconnected");
    },
    async testConnection() { return { content: "OK", latencyMs: 1 }; },
  };
  const service = new ModelService(store, new ModelRouter(store), { get: () => provider } as unknown as ModelProviderRegistry);
  const tokens: string[] = [];
  await assert.rejects(service.text([{ role: "user", content: "test" }], { context, task: "answer", onToken: (token) => tokens.push(token) }), /upstream disconnected/);
  assert.deepEqual(tokens, ["部分回答"]);
  assert.deepEqual(calls, ["primary-stream"]);
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

test("Qwen embeddings are split into batches of at most 25 while preserving order", async () => {
  const store = new ModelStore(":memory:", Buffer.alloc(32, 17));
  const embedding = store.create(context, {
    ...config("qwen-embedding"),
    modelType: "embedding",
    provider: "qwen",
    modelId: "text-embedding-v2",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  });
  const batchSizes: number[] = [];
  const provider: ModelProvider = {
    async chat() { throw new Error("unused"); },
    async testConnection() { return { content: "OK", latencyMs: 1 }; },
    async embed(_model, texts) {
      batchSizes.push(texts.length);
      return texts.map((text) => [Number(text)]);
    },
  };
  const service = new ModelService(store, new ModelRouter(store), { get: () => provider } as unknown as ModelProviderRegistry);
  const texts = Array.from({ length: 53 }, (_, index) => String(index));

  const vectors = await service.embedBatch(context, embedding.id, texts);

  assert.deepEqual(batchSizes, [25, 25, 3]);
  assert.deepEqual(vectors, texts.map((text) => [Number(text)]));
});

test("embedding batches shrink automatically when a provider reports a smaller limit", async () => {
  const store = new ModelStore(":memory:", Buffer.alloc(32, 18));
  const embedding = store.create(context, { ...config("limited-embedding"), modelType: "embedding" });
  const successfulBatches: number[] = [];
  const provider: ModelProvider = {
    async chat() { throw new Error("unused"); },
    async testConnection() { return { content: "OK", latencyMs: 1 }; },
    async embed(_model, texts) {
      if (texts.length > 8) throw new Error("batch size is invalid, maximum input limit is 8");
      successfulBatches.push(texts.length);
      return texts.map((text) => [Number(text)]);
    },
  };
  const service = new ModelService(store, new ModelRouter(store), { get: () => provider } as unknown as ModelProviderRegistry);
  const texts = Array.from({ length: 20 }, (_, index) => String(index));

  const vectors = await service.embedBatch(context, embedding.id, texts);

  assert.deepEqual(successfulBatches, [5, 5, 5, 5]);
  assert.deepEqual(vectors, texts.map((text) => [Number(text)]));
});

test("connection testing uses the embeddings endpoint for embedding models", async () => {
  const store = new ModelStore(":memory:", Buffer.alloc(32, 14));
  const embedding = store.create(context, { ...config("embedding-connect"), modelType: "embedding" });
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const service = new ModelService(store, new ModelRouter(store));
    assert.equal((await service.testConnection(context, embedding.id)).success, true);
    assert.equal(requestedUrl, "https://api.example.test/v1/embeddings");
  } finally { globalThis.fetch = originalFetch; }
});

test("DeepSeek LLM connection test disables thinking and accepts a reasoning response", async () => {
  const store = new ModelStore(":memory:", Buffer.alloc(32, 16));
  const model = store.create(context, {
    ...config("deepseek-connect"),
    provider: "deepseek",
    modelId: "deepseek-v4-flash",
  });
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { reasoning_content: "OK" } }] }), { status: 200 });
  };
  try {
    const service = new ModelService(store, new ModelRouter(store));
    assert.equal((await service.testConnection(context, model.id)).success, true);
    assert.deepEqual(requestBody.thinking, { type: "disabled" });
    assert.equal(requestBody.max_tokens, 32);
  } finally { globalThis.fetch = originalFetch; }
});

test("unsupported rerank connection testing returns an explicit protocol error", async () => {
  const store = new ModelStore(":memory:", Buffer.alloc(32, 15));
  const rerank = store.create(context, { ...config("rerank-connect"), modelType: "rerank" });
  const service = new ModelService(store, new ModelRouter(store));
  const result = await service.testConnection(context, rerank.id);
  assert.equal(result.success, false);
  assert.match(result.error || "", /未实现 Rerank 协议/);
});

test("Qwen rerank uses the DashScope protocol and preserves returned scores", async () => {
  const store = new ModelStore(":memory:", Buffer.alloc(32, 19));
  const rerank = store.create(context, { ...config("qwen3-rerank"), modelType: "rerank", provider: "qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" });
  const originalFetch = globalThis.fetch; let requestedUrl = ""; let requestBody: Record<string, unknown> = {};
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input); requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ results: [{ index: 1, relevance_score: 0.91 }, { index: 0, relevance_score: 0.42 }] }), { status: 200 });
  };
  try {
    const service = new ModelService(store, new ModelRouter(store));
    const result = await service.rerank(context, rerank.id, "凭证", ["报表", "凭证处理"], 2);
    assert.equal(requestedUrl, "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank");
    assert.equal(requestBody.top_n, 2); assert.deepEqual(result.results, [{ index: 1, score: 0.91 }, { index: 0, score: 0.42 }]);
  } finally { globalThis.fetch = originalFetch; }
});
