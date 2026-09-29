import assert from "node:assert/strict";
import test from "node:test";
import type { RequestContext } from "../core/types.js";
import { WorkflowStore } from "./workflow-store.js";

const owner: RequestContext = { tenantId: "tenant-a", accountSetId: "account-a", userId: "user-a", role: "tenant_admin", sessionId: "session-a" };
const outsider: RequestContext = { ...owner, tenantId: "tenant-b", userId: "user-b" };
const teammate: RequestContext = { ...owner, userId: "user-c" };

test("workflow store persists agent CRUD, copies definitions, and isolates tenants", () => {
  const store = new WorkflowStore(":memory:");
  const created = store.createAgent(owner, { name: "财务助手", description: "自动分析" });
  assert.equal(created.agent.status, "draft");
  assert.equal(created.agent.currentVersion, 0);
  assert.equal(created.agent.permission, "private");
  assert.equal(created.workflow.definition.nodes.length, 2);
  assert.throws(() => store.getAgent(outsider, created.agent.id), /无权访问/);

  const saved = store.saveWorkflow(owner, created.agent.id, {
    ...created.workflow.definition,
    variables: { region: "华东" },
  });
  assert.equal(saved.version, 0);
  assert.deepEqual(saved.definition.variables, { region: "华东" });
  assert.equal(store.listVersions(owner, created.agent.id).length, 0);
  const firstPublish = store.publish(owner, created.agent.id, true, "tenant");
  assert.equal(firstPublish.agent.status, "published");
  assert.equal(firstPublish.version?.version, 1);
  assert.equal(store.getAgent(teammate, created.agent.id).permission, "tenant");

  store.saveWorkflow(owner, created.agent.id, { ...saved.definition, variables: { region: "华南" } });
  assert.equal(store.listVersions(owner, created.agent.id).length, 1);
  const secondPublish = store.publish(owner, created.agent.id, true, "tenant");
  assert.equal(secondPublish.version?.version, 2);
  assert.equal(store.listVersions(owner, created.agent.id).length, 2);
  const restored = store.restoreVersion(owner, created.agent.id, 1);
  assert.deepEqual(restored.definition.variables, { region: "华东" });
  assert.equal(store.getAgent(owner, created.agent.id).status, "draft");
  assert.throws(() => store.getAgent(teammate, created.agent.id), /无权访问/);

  const copied = store.copyAgent(owner, created.agent.id);
  assert.match(copied.agent.name, /副本/);
  assert.deepEqual(copied.workflow.definition.variables, { region: "华东" });
  assert.equal(store.listAgents(owner).length, 2);

  store.deleteAgent(owner, copied.agent.id);
  assert.equal(store.listAgents(owner).length, 1);
});
