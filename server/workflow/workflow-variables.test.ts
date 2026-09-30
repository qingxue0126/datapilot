import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkflowVariableGroups, insertVariableAt, variableExpression } from "../../components/datapilot/workflow-variables";

test("variable picker only exposes reachable upstream output fields", () => {
  const nodes = [
    { id: "message", type: "start", data: { label: "消息输入", config: { inputs: [{ key: "company_name", type: "string" }] } } },
    { id: "status", type: "code", data: { label: "客服状态判断", config: { code: "return { action: input.action, product: input.product };" } } },
    { id: "current", type: "condition", data: { label: "判断", config: {} } },
    { id: "sibling", type: "llm", data: { label: "不可访问", config: {} } },
    { id: "tool", type: "knowledge_retrieval", data: { label: "Agent 工具", config: {} } },
  ];
  const groups = buildWorkflowVariableGroups(nodes, [
    { source: "message", target: "status" },
    { source: "status", target: "current" },
    { source: "tool", target: "current", targetHandle: "tools" },
    { source: "message", target: "sibling" },
  ], "current");

  assert.deepEqual(groups.map((group) => group.nodeId), ["message", "status"]);
  assert.deepEqual(groups[0].fields.map((field) => [field.path, field.type]), [
    ["query", "string"],
    ["__conversationHistory", "array"],
    ["company_name", "string"],
  ]);
  assert.deepEqual(groups[1].fields.map((field) => field.path), ["action", "product"]);
});

test("variable expressions remain compatible with workflow templates", () => {
  const expression = variableExpression("customer-status", "company_name");
  assert.equal(expression, "{{customer-status.output.company_name}}");
  assert.equal(insertVariableAt("公司：", expression), "公司：{{customer-status.output.company_name}}");
});
