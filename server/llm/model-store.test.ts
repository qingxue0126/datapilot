import assert from "node:assert/strict";
import test from "node:test";
import type { RequestContext } from "../core/types.js";
import { ModelStore } from "./model-store.js";

const owner: RequestContext = { tenantId: "tenant-a", accountSetId: "set-a", userId: "user-a", role: "tenant_admin", sessionId: "session-a" };
const otherUser: RequestContext = { ...owner, userId: "user-b", sessionId: "session-b" };
const otherTenant: RequestContext = { ...owner, tenantId: "tenant-b", sessionId: "session-c" };

function input(name = "Finance LLM") {
  return { name, provider: "openai-compatible" as const, modelId: "finance-model", baseUrl: "https://llm.example.test/v1", apiKey: "sk-secret-abcd",
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
