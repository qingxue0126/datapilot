import assert from "node:assert/strict";
import test from "node:test";
import type { RequestContext } from "../core/types.js";
import { WorkflowStore } from "./workflow-store.js";

const owner: RequestContext = { tenantId: "tenant-a", accountSetId: "account-a", userId: "user-a", role: "tenant_admin", sessionId: "session-a" };
const outsider: RequestContext = { ...owner, tenantId: "tenant-b", userId: "user-b" };

test("workflow store persists agent CRUD, copies definitions, and isolates tenants", () => {
  const store = new WorkflowStore(":memory:");
  const created = store.createAgent(owner, { name: "财务助手", description: "自动分析" });
  assert.equal(created.agent.status, "draft");
  assert.equal(created.workflow.definition.nodes.length, 2);
  assert.throws(() => store.getAgent(outsider, created.agent.id), /无权访问/);

  const saved = store.saveWorkflow(owner, created.agent.id, {
    ...created.workflow.definition,
    variables: { region: "华东" },
  });
  assert.equal(saved.version, 2);
  assert.deepEqual(saved.definition.variables, { region: "华东" });
  assert.equal(store.publish(owner, created.agent.id).status, "published");

  const copied = store.copyAgent(owner, created.agent.id);
  assert.match(copied.agent.name, /副本/);
  assert.deepEqual(copied.workflow.definition.variables, { region: "华东" });
  assert.equal(store.listAgents(owner).length, 2);

  store.deleteAgent(owner, copied.agent.id);
  assert.equal(store.listAgents(owner).length, 1);
});
