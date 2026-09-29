import assert from "node:assert/strict";
import test from "node:test";
import { validateAndSort } from "./workflow-engine.js";
import { importRagflowWorkflow } from "./ragflow-importer.js";

test("RAGFlow JSON imports nodes, edges, coordinates, prompts, and compatibility warnings", () => {
  const imported = importRagflowWorkflow({
    variables: { locale: "zh-CN" },
    graph: {
      nodes: [
        { id: "begin", type: "beginNode", position: { x: 10, y: 20 }, data: { name: "开始", form: { mode: "conversational", enablePrologue: true, prologue: "您好", inputs: { query: { name: "问题", type: "string", optional: false } } } } },
        { id: "Agent:Classify", type: "agentNode", position: { x: 300, y: 20 }, data: { name: "问题分类", form: { llm_id: "ragflow-model", sys_prompt: "分类", prompts: [{ role: "user", content: "问题：{sys.query}" }] } } },
        { id: "Retrieval:Cases", type: "retrievalNode", position: { x: 600, y: 20 }, data: { name: "检索", form: { query: "{Agent:Classify@content}" } } },
        { id: "Message:Reply", type: "messageNode", position: { x: 900, y: 20 }, data: { name: "回复", form: { content: ["{Retrieval:Cases@formalized_content}"] } } },
      ],
      edges: [
        { id: "e1", source: "begin", target: "Agent:Classify" },
        { id: "e2", source: "Agent:Classify", target: "Retrieval:Cases" },
        { id: "e3", source: "Retrieval:Cases", target: "Message:Reply" },
      ],
    },
  }, { defaultModelId: "datapilot-model" });

  validateAndSort(imported.definition);
  assert.equal(imported.definition.nodes.length, 4);
  assert.equal(imported.definition.edges.length, 3);
  assert.deepEqual(imported.definition.nodes[0].position, { x: 10, y: 20 });
  assert.deepEqual(imported.definition.nodes[0].data.config, {
    mode: "conversation", enablePrologue: true, prologue: "您好",
    inputs: [{ key: "query", name: "问题", type: "string", required: true, options: undefined }],
    webhookMethod: "GET", webhookSecurity: "none", webhookRequestMode: "json", webhookResponseMode: "workflow",
  });
  const llm = imported.definition.nodes.find((node) => node.id === "Agent:Classify")!;
  assert.equal(llm.type, "llm");
  assert.equal(llm.data.config.modelId, "datapilot-model");
  assert.equal(llm.data.config.userPrompt, "问题：{{start.output.query}}");
  const retrieval = imported.definition.nodes.find((node) => node.id === "Retrieval:Cases")!;
  assert.equal(retrieval.type, "code");
  assert.deepEqual(retrieval.data.config.input, { query: "{{Agent:Classify.output.text}}" });
  assert.equal(imported.report.unsupported[0].sourceType, "Retrieval");
  assert.deepEqual(imported.definition.variables, { locale: "zh-CN" });
});

test("RAGFlow UserFillUp and Switch map to runtime input and true/false branches", () => {
  const imported = importRagflowWorkflow({
    graph: {
      nodes: [
        { id: "begin", type: "beginNode", data: { form: {} } },
        { id: "Switch:One", type: "switchNode", data: { form: { conditions: [{ items: [{ cpn_id: "sys.query", operator: "=", value: "help" }], to: ["UserFillUp:One"] }] } } },
        { id: "UserFillUp:One", type: "ragNode", data: { label: "UserFillUp", form: { inputs: { product: { type: "options", options: ["好会计"], optional: false }, company: { type: "line", optional: true } }, outputs: { product: {}, company: {} } } } },
        { id: "Message:Done", type: "messageNode", data: { form: { content: ["{UserFillUp:One@product}"] } } },
      ],
      edges: [
        { source: "begin", target: "Switch:One" },
        { source: "Switch:One", target: "UserFillUp:One", sourceHandle: "Case 1" },
        { source: "UserFillUp:One", target: "Message:Done" },
      ],
    },
  });
  validateAndSort(imported.definition);
  const condition = imported.definition.nodes.find((node) => node.id === "Switch:One");
  assert.equal(condition?.type, "condition");
  assert.deepEqual(condition?.data.config.branches, [{ id: "true", label: "Case 1", condition: { id: "group-1", combinator: "and", items: [{ id: "rule-1-1", left: "{{start.output.query}}", operator: "==", right: "help" }] } }]);
  assert.equal(imported.definition.edges.find((edge) => edge.target === "UserFillUp:One")?.sourceHandle, "true");
  assert.deepEqual(imported.definition.nodes.find((node) => node.id === "UserFillUp:One")?.data.config.assignments, {
    product: "{{start.output.product}}",
    company: "{{start.output.company?}}",
  });
  assert.deepEqual(imported.definition.nodes.find((node) => node.type === "start")?.data.config.inputs, [
    { key: "product", name: "product", type: "string", required: false, options: ["好会计"] },
    { key: "company", name: "company", type: "string", required: false, options: undefined },
  ]);
});
