import assert from "node:assert/strict";
import test from "node:test";
import type { RequestContext } from "../core/types.js";
import { KnowledgeStore, KnowledgeStoreError } from "../knowledge/knowledge-store.js";
import { ModelStore, ModelStoreError } from "../llm/model-store.js";
import { ResourcePermissionStore } from "./resource-permission-store.js";

const owner: RequestContext = { tenantId: "tenant-a", accountSetId: "set-a", userId: "alice", role: "tenant_admin", sessionId: "a" };
const member: RequestContext = { ...owner, userId: "bob", role: "finance_viewer", sessionId: "b" };

test("private model and knowledge resources support explicit use/edit grants", () => {
  const permissions = new ResourcePermissionStore(":memory:");
  const models = new ModelStore(":memory:", Buffer.alloc(32, 4), permissions);
  const model = models.create(owner, { name: "Private LLM", provider: "openai-compatible", modelId: "private", baseUrl: "https://example.test/v1", apiKey: "sk-private", modelType: "llm", contextWindow: 1000, timeout: 1000, maxRetries: 0, temperature: 0, supportsTools: false, supportsStructuredOutput: false, supportsVision: false, enabled: true });
  assert.throws(() => models.get(member, model.id), (error: ModelStoreError) => error.status === 404);
  models.setPermission(owner, model.id, member.userId, "use");
  assert.equal(models.get(member, model.id).id, model.id);
  assert.throws(() => models.update(member, model.id, { name: "blocked" }), (error: ModelStoreError) => error.status === 403);
  models.setPermission(owner, model.id, member.userId, "edit");
  assert.equal(models.update(member, model.id, { name: "edited" }).name, "edited");

  const knowledge = new KnowledgeStore(":memory:", permissions);
  const base = knowledge.create(owner, { name: "Private KB" });
  assert.throws(() => knowledge.get(member, base.id), (error: KnowledgeStoreError) => error.status === 404);
  knowledge.setPermission(owner, base.id, member.userId, "use");
  assert.equal(knowledge.get(member, base.id).knowledgeBase.id, base.id);
  assert.throws(() => knowledge.update(member, base.id, { name: "blocked" }), (error: KnowledgeStoreError) => error.status === 403);
  knowledge.setPermission(owner, base.id, member.userId, "edit");
  assert.equal(knowledge.update(member, base.id, { name: "edited" }).name, "edited");
  knowledge.close();
});
