import assert from "node:assert/strict";
import test from "node:test";
import type { RequestContext } from "../core/types.js";
import { PermissionService } from "../auth/permission-service.js";
import type { ModelService } from "../llm/model-service.js";
import type { KnowledgeRetrievalService } from "../knowledge/retrieval-service.js";
import { WorkflowEngine, resolveValue, validateAndSort } from "./workflow-engine.js";
import { WorkflowStore } from "./workflow-store.js";
import type { WorkflowDefinition } from "./workflow-types.js";

const context: RequestContext = { tenantId: "t", accountSetId: "a", userId: "u", role: "tenant_admin", sessionId: "s" };

test("multiple message inputs and outputs execute and survive workflow persistence", async () => {
  const store = new WorkflowStore(":memory:");
  const created = store.createAgent(context, { name: "多个消息入口" });
  const definition: WorkflowDefinition = {
    variables: {},
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "消息输入", config: {} } },
      { id: "input2", type: "start", position: { x: 0, y: 100 }, data: { label: "消息输入", config: {} } },
      { id: "end1", type: "end", position: { x: 200, y: 0 }, data: { label: "消息输出", config: { output: "{{start.output.query}}" } } },
      { id: "end2", type: "end", position: { x: 200, y: 100 }, data: { label: "消息输出", config: { output: "{{input2.output.query}}" } } },
    ],
    edges: [{ id: "a", source: "start", target: "end1" }, { id: "b", source: "input2", target: "end2" }],
  };
  store.saveWorkflow(context, created.agent.id, definition);
  assert.deepEqual(store.getWorkflow(context, created.agent.id).definition, definition);
  const engine = new WorkflowEngine({ store, permissions: new PermissionService(), models: {} as ModelService, connection: () => { throw new Error("unused"); } });
  const run = await engine.run(context, created.agent.id, { query: "测试消息" });
  assert.equal(run.status, "success");
  assert.equal(run.nodeRuns.length, 4);
  assert.ok(run.nodeRuns.every((node) => node.status === "success"));
  for (const node of run.nodeRuns.filter((item) => item.nodeType === "end")) assert.equal(node.output, "测试消息");
});

test("LLM nodes emit exact deltas while preserving the assembled node output", async () => {
  const store = new WorkflowStore(":memory:");
  const created = store.createAgent(context, { name: "流式 LLM" });
  store.saveWorkflow(context, created.agent.id, {
    variables: {},
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "消息输入", config: {} } },
      { id: "llm", type: "llm", position: { x: 1, y: 0 }, data: { label: "LLM", config: { modelId: "model-1", userPrompt: "{{start.output.query}}" } } },
      { id: "end", type: "end", position: { x: 2, y: 0 }, data: { label: "消息输出", config: { output: "{{llm.output.text}}" } } },
    ],
    edges: [{ id: "a", source: "start", target: "llm" }, { id: "b", source: "llm", target: "end" }],
  });
  const models = { chat: async (_context: RequestContext, _modelId: string, _messages: unknown, options: { onToken?: (value: string) => void }) => {
    options.onToken?.("你"); options.onToken?.("好");
    return { content: "你好", latencyMs: 1 };
  } } as unknown as ModelService;
  const deltas: { nodeId: string; delta: string; text: string }[] = [];
  const engine = new WorkflowEngine({ store, permissions: new PermissionService(), models, connection: () => { throw new Error("unused"); } });
  const run = await engine.run(context, created.agent.id, { query: "问候" }, { onDelta: (event) => deltas.push({ nodeId: event.nodeId, delta: event.delta, text: event.text }) });
  assert.equal(run.status, "success");
  assert.equal(run.output, "你好");
  assert.deepEqual(deltas, [{ nodeId: "llm", delta: "你", text: "你" }, { nodeId: "llm", delta: "好", text: "你好" }]);
  assert.deepEqual(run.nodeRuns.find((item) => item.nodeId === "llm")?.output, { text: "你好" });
});

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

test("condition nodes support ordered multi-branches, nested groups, and nested condition nodes", async () => {
  const store = new WorkflowStore(":memory:");
  const created = store.createAgent(context, { name: "多分支嵌套" });
  store.saveWorkflow(context, created.agent.id, {
    variables: {},
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "开始", config: {} } },
      { id: "outer", type: "condition", position: { x: 1, y: 0 }, data: { label: "一级判断", config: { branches: [
        { id: "high", label: "高优先级", condition: { combinator: "and", items: [
          { left: "{{start.output.amount}}", operator: ">=", right: 100 },
          { combinator: "or", items: [{ left: "{{start.output.vip}}", operator: "==", right: true }, { left: "{{start.output.region}}", operator: "==", right: "east" }] },
        ] } },
        { id: "medium", label: "中优先级", condition: { combinator: "and", items: [{ left: "{{start.output.amount}}", operator: ">=", right: 50 }] } },
      ] } } },
      { id: "inner", type: "condition", position: { x: 2, y: 1 }, data: { label: "二级判断", config: { branches: [{ id: "urgent", label: "紧急", condition: { combinator: "and", items: [{ left: "{{start.output.priority}}", operator: "==", right: "urgent" }] } }] } } },
      { id: "high-end", type: "end", position: { x: 3, y: -1 }, data: { label: "高", config: { output: "high" } } },
      { id: "medium-end", type: "end", position: { x: 3, y: 0 }, data: { label: "中", config: { output: "medium" } } },
      { id: "urgent-end", type: "end", position: { x: 3, y: 1 }, data: { label: "紧急", config: { output: "urgent" } } },
      { id: "normal-end", type: "end", position: { x: 3, y: 2 }, data: { label: "普通", config: { output: "normal" } } },
    ],
    edges: [
      { id: "a", source: "start", target: "outer" },
      { id: "b", source: "outer", target: "high-end", sourceHandle: "high" },
      { id: "c", source: "outer", target: "medium-end", sourceHandle: "medium" },
      { id: "d", source: "outer", target: "inner", sourceHandle: "false" },
      { id: "e", source: "inner", target: "urgent-end", sourceHandle: "urgent" },
      { id: "f", source: "inner", target: "normal-end", sourceHandle: "false" },
    ],
  });
  const engine = new WorkflowEngine({ store, permissions: new PermissionService(), models: {} as ModelService, connection: () => { throw new Error("unused"); } });
  const nestedGroupRun = await engine.run(context, created.agent.id, { amount: 120, vip: false, region: "east" });
  assert.equal(nestedGroupRun.output, "high");
  const nestedNodeRun = await engine.run(context, created.agent.id, { amount: 10, vip: false, region: "west", priority: "urgent" });
  assert.equal(nestedNodeRun.output, "urgent", JSON.stringify(nestedNodeRun));
  assert.equal(nestedNodeRun.nodeRuns.find((item) => item.nodeId === "medium-end")?.status, "skipped");
});

test("references to an intentionally skipped branch resolve as empty values for downstream merge nodes", async () => {
  const store = new WorkflowStore(":memory:");
  const created = store.createAgent(context, { name: "分支合流" });
  store.saveWorkflow(context, created.agent.id, {
    variables: {},
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "开始", config: {} } },
      { id: "condition", type: "condition", position: { x: 1, y: 0 }, data: { label: "判断", config: { left: "known", operator: "==", right: "missing" } } },
      { id: "form", type: "assign", position: { x: 2, y: -1 }, data: { label: "表单", config: { assignments: { product: "{{start.output.product}}" } } } },
      { id: "merge", type: "assign", position: { x: 2, y: 1 }, data: { label: "合并", config: { assignments: { optionalProduct: "{{form.output.product}}" } } } },
      { id: "end", type: "end", position: { x: 3, y: 0 }, data: { label: "结束", config: { output: "{{merge.output}}" } } },
    ],
    edges: [
      { id: "a", source: "start", target: "condition" },
      { id: "b", source: "condition", target: "form", sourceHandle: "true" },
      { id: "c", source: "condition", target: "merge", sourceHandle: "false" },
      { id: "d", source: "form", target: "merge" },
      { id: "e", source: "merge", target: "end" },
    ],
  });
  const engine = new WorkflowEngine({ store, permissions: new PermissionService(), models: {} as ModelService, connection: () => { throw new Error("unused"); } });
  const run = await engine.run(context, created.agent.id, {});
  assert.equal(run.status, "success");
  assert.deepEqual(run.output, { optionalProduct: "" });
  assert.equal(run.nodeRuns.find((item) => item.nodeId === "form")?.status, "skipped");
});

test("start.output resolves runtime input when an imported start node keeps the RAGFlow begin id", async () => {
  const store = new WorkflowStore(":memory:");
  const created = store.createAgent(context, { name: "RAGFlow 开始节点兼容" });
  store.saveWorkflow(context, created.agent.id, {
    variables: {},
    nodes: [
      { id: "begin", type: "start", position: { x: 0, y: 0 }, data: { label: "开始", config: {} } },
      { id: "assign", type: "assign", position: { x: 100, y: 0 }, data: { label: "读取输入", config: { assignments: { query: "{{start.output.query}}" } } } },
      { id: "end", type: "end", position: { x: 200, y: 0 }, data: { label: "结束", config: { output: "{{assign.output}}" } } },
    ],
    edges: [{ id: "a", source: "begin", target: "assign" }, { id: "b", source: "assign", target: "end" }],
  });
  const engine = new WorkflowEngine({ store, permissions: new PermissionService(), models: {} as ModelService, connection: () => { throw new Error("unused"); } });
  const run = await engine.run(context, created.agent.id, { query: "凭证问题" });
  assert.equal(run.status, "success");
  assert.deepEqual(run.output, { query: "凭证问题" });
});

test("start node validates configured required input fields and their types", async () => {
  const store = new WorkflowStore(":memory:");
  const created = store.createAgent(context, { name: "开始输入校验" });
  store.saveWorkflow(context, created.agent.id, {
    variables: {},
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "开始", config: { mode: "task", inputs: [{ key: "query", name: "问题", type: "string", required: true }, { key: "limit", name: "数量", type: "number", required: false }] } } },
      { id: "end", type: "end", position: { x: 1, y: 0 }, data: { label: "结束", config: { output: "{{start.output}}" } } },
    ],
    edges: [{ id: "a", source: "start", target: "end" }],
  });
  const engine = new WorkflowEngine({ store, permissions: new PermissionService(), models: {} as ModelService, connection: () => { throw new Error("unused"); } });
  const missing = await engine.run(context, created.agent.id, {});
  assert.equal(missing.status, "failed");
  assert.match(missing.error || "", /运行输入缺少字段：query/);
  const invalid = await engine.run(context, created.agent.id, { query: "问题", limit: "10" });
  assert.equal(invalid.status, "failed");
  assert.match(invalid.error || "", /limit 类型错误，应为 number/);
  const success = await engine.run(context, created.agent.id, { query: "问题", limit: 10 });
  assert.equal(success.status, "success");
  assert.deepEqual(success.output, { query: "问题", limit: 10 });
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
  assert.throws(
    () => resolveValue("{{start.output.query}}", { start: { output: {} } }),
    /运行输入缺少字段：query/,
  );
  assert.equal(resolveValue("{{start.output.company_name?}}", { start: { output: {} } }), "");
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

test("knowledge retrieval nodes resolve dynamic filters and expose complete retrieval output", async () => {
  const store = new WorkflowStore(":memory:");
  const created = store.createAgent(context, { name: "客服检索" });
  store.saveWorkflow(context, created.agent.id, {
    variables: {},
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "开始", config: {} } },
      { id: "retrieve", type: "knowledge_retrieval", position: { x: 1, y: 0 }, data: { label: "知识库检索", config: { knowledgeBaseId: "kb-1", query: "{{start.output.query}}", filters: { Porduct: { $containsToken: "{{start.output.product}}" } }, retrievalMode: "hybrid", topK: 5, scoreThreshold: 0.2, rerank: false } } },
      { id: "end", type: "end", position: { x: 2, y: 0 }, data: { label: "结束", config: { output: "{{retrieve.output}}" } } },
    ],
    edges: [{ id: "a", source: "start", target: "retrieve" }, { id: "b", source: "retrieve", target: "end" }],
  });
  let request: Record<string, unknown> | undefined;
  const retrieval = { retrieve: async (_context: RequestContext, value: Record<string, unknown>) => {
    request = value;
    return { items: [{ rank: 1, chunkId: "c1", documentId: "d1", filename: "qa.xlsx", fileType: "XLSX", chunkIndex: 0, content: "Question：如何增加外币科目？\nAnswer：进入设置。", score: 0.91, metadata: { Porduct: "好会计" } }] };
  } } as unknown as KnowledgeRetrievalService;
  const engine = new WorkflowEngine({ store, permissions: new PermissionService(), models: {} as ModelService, knowledgeRetrieval: retrieval, connection: () => { throw new Error("unused"); } });
  const run = await engine.run(context, created.agent.id, { query: "怎么增加外币科目？", product: "好会计" });
  assert.equal(run.status, "success");
  assert.deepEqual(request?.filters, { Porduct: { $containsToken: "好会计" } });
  assert.equal((run.output as { hitCount: number }).hitCount, 1);
  assert.equal((run.output as { topScore: number }).topScore, 0.91);
  assert.match((run.output as { items: { content: string }[] }).items[0].content, /Question/);
});

test("Agent autonomously calls a configured knowledge tool, carries memory, and records trace details", async () => {
  const store = new WorkflowStore(":memory:");
  const created = store.createAgent(context, { name: "通用 Agent 工具循环" });
  store.saveWorkflow(context, created.agent.id, {
    variables: {},
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "开始", config: {} } },
      { id: "agent", type: "agent", position: { x: 1, y: 0 }, data: { label: "Agent", config: {
        input: "{{start.output.query}}", modelId: "model-1", systemPrompt: "通用助理", userPrompt: "问题：{{agent.input}}",
        maxIterations: 2, timeoutMs: 30000, streaming: false, memory: true,
        tools: [],
      } } },
      { id: "kb-tool", type: "knowledge_retrieval", position: { x: 1, y: 2 }, data: { label: "Knowledge Search", config: { toolName: "kb_search", toolDescription: "Search knowledge", knowledgeBaseId: "kb-1", query: "{{missing.output.query}}", filters: { tenant: "acme" }, dynamicFilters: true, retrievalMode: "hybrid", topK: 3, scoreThreshold: 0.1, rerank: true, rerankModel: "ranker", rerankTopK: 2, vectorWeight: 0.6 } } },
      { id: "end", type: "end", position: { x: 2, y: 0 }, data: { label: "结束", config: { output: "{{agent.output.text}}" } } },
    ],
    edges: [{ id: "a", source: "start", target: "agent", targetHandle: "input" }, { id: "tool", source: "kb-tool", target: "agent", targetHandle: "tools" }, { id: "b", source: "agent", target: "end", sourceHandle: "output" }],
  });
  const calls: { messages: { role: string; content: string }[]; options?: Record<string, unknown> }[] = [];
  const models = { chat: async (_context: RequestContext, _modelId: string, messages: { role: string; content: string }[], options?: Record<string, unknown>) => {
    calls.push({ messages, options });
    return { content: calls.length === 1
      ? '{"action":"tool_call","tool_name":"kb_search","arguments":{"query":"查找退款策略","filters":{"product":"Pro"}}}'
      : "请按现行退款策略提交申请。", latencyMs: 12 };
  } } as unknown as ModelService;
  let retrievalRequest: Record<string, unknown> | undefined;
  const knowledgeRetrieval = { retrieve: async (_context: RequestContext, request: Record<string, unknown>) => {
    retrievalRequest = request;
    return { items: [{ rank: 1, chunkId: "c1", documentId: "d1", filename: "policy.md", fileType: "MD", chunkIndex: 0, content: "可在订单页申请退款。", score: 0.94, metadata: { product: "Pro" } }] };
  } } as unknown as KnowledgeRetrievalService;
  const engine = new WorkflowEngine({ store, permissions: new PermissionService(), models, knowledgeRetrieval, connection: () => { throw new Error("unused"); } });
  const run = await engine.run(context, created.agent.id, { query: "如何退款？", __conversationHistory: [{ role: "user", content: "上一轮问过订单状态" }, { role: "assistant", content: "请提供订单号" }] });

  assert.equal(run.status, "success");
  assert.equal(run.output, "请按现行退款策略提交申请。");
  assert.deepEqual(retrievalRequest?.filters, { tenant: "acme", product: "Pro" });
  assert.equal(retrievalRequest?.query, "查找退款策略");
  assert.equal(retrievalRequest?.retrievalMode, "hybrid");
  assert.match(calls[0].messages.map((message) => message.content).join("\n"), /上一轮问过订单状态/);
  assert.match(calls[1].messages.map((message) => message.content).join("\n"), /可在订单页申请退款/);
  const agentRun = run.nodeRuns.find((item) => item.nodeId === "agent");
  assert.equal(run.nodeRuns.find((item) => item.nodeId === "kb-tool")?.status, "skipped");
  const trace = (agentRun?.output as { trace: { type: string; durationMs: number }[] }).trace;
  assert.deepEqual(trace.map((item) => item.type), ["llm", "tool", "llm"]);
  assert.ok(trace.every((item) => item.durationMs >= 0));
});
