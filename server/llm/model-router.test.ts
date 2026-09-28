import assert from "node:assert/strict";
import test from "node:test";
import type { RequestContext } from "../core/types.js";
import { ModelRouter } from "./model-router.js";
import { ModelStore } from "./model-store.js";

const context: RequestContext = { tenantId: "t", accountSetId: "a", userId: "u", role: "tenant_admin", sessionId: "s" };
const config = (name: string) => ({ name, provider: "deepseek" as const, modelId: name.toLowerCase(), baseUrl: "https://api.example.test", apiKey: "secret",
  contextWindow: 8000, timeout: 5000, maxRetries: 0, temperature: 0, supportsTools: true, supportsStructuredOutput: true, supportsVision: false, enabled: true });

test("model router resolves task primary, fallback and an explicit preferred model", () => {
  const store = new ModelStore(":memory:", Buffer.alloc(32, 3));
  const primary = store.create(context, config("Primary")); const fallback = store.create(context, config("Fallback"));
  store.saveRoute(context, "text2sql", { primaryModelId: primary.id, fallbackModelId: fallback.id });
  const router = new ModelRouter(store);
  const resolved = router.getModel(context, "text2sql");
  assert.equal(resolved.primary.id, primary.id); assert.equal(resolved.fallback?.id, fallback.id);
  assert.equal(router.getModel(context, "text2sql", fallback.id).primary.id, fallback.id);
});

test("model router excludes embedding and rerank models and prefers a text LLM", () => {
  const store = new ModelStore(":memory:", Buffer.alloc(32, 13));
  store.create(context, { ...config("embedding"), modelType: "embedding" });
  store.create(context, { ...config("rerank"), modelType: "rerank" });
  store.create(context, { ...config("multimodal"), modelType: "multimodal_llm" });
  const llm = store.create(context, { ...config("llm"), modelType: "llm" });
  assert.equal(new ModelRouter(store).getModel(context, "text2sql").primary.id, llm.id);
});
