import assert from "node:assert/strict";
import test from "node:test";
import type { RequestContext } from "../core/types.js";
import { PermissionService } from "../auth/permission-service.js";
import type { ModelService } from "../llm/model-service.js";
import { WorkflowEngine, resolveValue, validateAndSort } from "./workflow-engine.js";
import { WorkflowStore } from "./workflow-store.js";
import type { WorkflowDefinition } from "./workflow-types.js";

const context: RequestContext = { tenantId: "t", accountSetId: "a", userId: "u", role: "tenant_admin", sessionId: "s" };

test("workflow engine executes a DAG, resolves variables, and skips an inactive condition branch", async () => {
  const store = new WorkflowStore(":memory:");
  const created = store.createAgent(context, { name: "条件工作流" });
  const definition: WorkflowDefinition = {
    variables: {},
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "开始", config: {} } },
      { id: "assign", type: "assign", position: { x: 100, y: 0 }, data: { label: "赋值", config: { assignments: { amount: "{{start.output.amount}}" } } } },
      { id: "condition", type: "condition", position: { x: 200, y: 0 }, data: { label: "判断", config: { left: "{{assign.output.amount}}", operator: ">=", right: 100 } } },
      { id: "success", type: "end", position: { x: 300, y: -80 }, data: { label: "成功", config: { output: "{{assign.output}}" } } },
      { id: "skipped", type: "end", position: { x: 300, y: 80 }, data: { label: "跳过", config: { output: "no" } } },
    ],
    edges: [
      { id: "e1", source: "start", target: "assign" },
      { id: "e2", source: "assign", target: "condition" },
      { id: "e3", source: "condition", target: "success", sourceHandle: "true" },
      { id: "e4", source: "condition", target: "skipped", sourceHandle: "false" },
    ],
  };
  store.saveWorkflow(context, created.agent.id, definition);
  const engine = new WorkflowEngine({ store, permissions: new PermissionService(), models: {} as ModelService, connection: () => { throw new Error("unused"); } });
  const run = await engine.run(context, created.agent.id, { amount: 120 });
  assert.equal(run.status, "success");
  assert.deepEqual(run.output, { amount: 120 });
  assert.equal(run.nodeRuns.find((item) => item.nodeId === "skipped")?.status, "skipped");
  assert.equal(run.nodeRuns.find((item) => item.nodeId === "success")?.status, "success");
});

test("workflow validation rejects cycles and variable resolution preserves full JSON values", () => {
  const cyclic: WorkflowDefinition = {
    variables: {},
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "开始", config: {} } },
      { id: "end", type: "end", position: { x: 1, y: 1 }, data: { label: "结束", config: {} } },
    ],
    edges: [{ id: "a", source: "start", target: "end" }, { id: "b", source: "end", target: "start" }],
  };
  assert.throws(() => validateAndSort(cyclic), /循环/);
  assert.deepEqual(resolveValue("{{node.output}}", { node: { output: { rows: [1, 2] } } }), { rows: [1, 2] });
});

test("code nodes cannot access host modules", async () => {
  const store = new WorkflowStore(":memory:");
  const created = store.createAgent(context, { name: "代码安全" });
  store.saveWorkflow(context, created.agent.id, {
    variables: {},
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "开始", config: {} } },
      { id: "code", type: "code", position: { x: 1, y: 0 }, data: { label: "代码", config: { input: {}, code: "return require('node:fs');" } } },
      { id: "end", type: "end", position: { x: 2, y: 0 }, data: { label: "结束", config: {} } },
    ],
    edges: [{ id: "a", source: "start", target: "code" }, { id: "b", source: "code", target: "end" }],
  });
  const engine = new WorkflowEngine({ store, permissions: new PermissionService(), models: {} as ModelService, connection: () => { throw new Error("unused"); } });
  const run = await engine.run(context, created.agent.id, {});
  assert.equal(run.status, "failed");
  assert.match(run.error || "", /禁止访问系统/);
  assert.equal(run.nodeRuns.find((item) => item.nodeId === "end")?.status, "skipped");
});
