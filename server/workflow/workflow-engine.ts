import vm from "node:vm";
import type { RequestContext } from "../core/types.js";
import type { DatabaseConfig } from "../database.js";
import { executeSql } from "../database.js";
import type { PermissionService } from "../auth/permission-service.js";
import { assertAgentSql } from "../security/sql-policy.js";
import type { ModelService } from "../llm/model-service.js";
import type { WorkflowStore } from "./workflow-store.js";
import { workflowNodeTypes, type WorkflowDefinition, type WorkflowEdge, type WorkflowNode, type WorkflowNodeRun, type WorkflowNodeRunStatus, type WorkflowRun } from "./workflow-types.js";

type Scope = Record<string, unknown>;
type EngineDependencies = {
  store: WorkflowStore;
  models: ModelService;
  permissions: PermissionService;
  connection: (context: RequestContext, id: string) => DatabaseConfig;
  fetch?: typeof fetch;
};

export class WorkflowEngine {
  constructor(private readonly dependencies: EngineDependencies) {}

  async run(context: RequestContext, agentId: string, input: Record<string, unknown> = {}): Promise<WorkflowRun> {
    const workflow = this.dependencies.store.getWorkflow(context, agentId);
    const ordered = validateAndSort(workflow.definition);
    const run = this.dependencies.store.createRun(context, agentId, workflow.version, input);
    return this.execute(context, workflow.definition, ordered, run, input);
  }

  start(context: RequestContext, agentId: string, input: Record<string, unknown> = {}): WorkflowRun {
    const workflow = this.dependencies.store.getWorkflow(context, agentId);
    const ordered = validateAndSort(workflow.definition);
    const run = this.dependencies.store.createRun(context, agentId, workflow.version, input);
    void this.execute(context, workflow.definition, ordered, run, input).catch((error) => {
      this.dependencies.store.finishRun(context, run.id, "failed", null, safeError(error), 0);
    });
    return run;
  }

  private async execute(context: RequestContext, definition: WorkflowDefinition, ordered: WorkflowNode[], run: WorkflowRun, input: Record<string, unknown>): Promise<WorkflowRun> {
    const started = Date.now();
    const scope: Scope = { input, variables: definition.variables };
    const activeEdges = new Set<string>();
    let failed = false;
    let finalOutput: unknown = null;
    let runError: string | null = null;

    for (const node of ordered) {
      const incoming = definition.edges.filter((edge) => edge.target === node.id);
      const active = node.type === "start" || incoming.some((edge) => activeEdges.has(edge.id));
      if (!active || failed) {
        this.recordNode(context, run.id, node, "skipped", null, null, null, 0, null, null);
        continue;
      }
      const nodeStartedAt = new Date().toISOString();
      const nodeStarted = Date.now();
      let resolvedInput: unknown = null;
      const runningNode = this.recordNode(context, run.id, node, "running", null, null, null, 0, nodeStartedAt, null);
      try {
        resolvedInput = resolveValue(node.data.config, scope);
        const output = await this.executeNode(context, node, resolvedInput as Record<string, unknown>, scope);
        scope[node.id] = { output };
        // Imported workflow formats commonly use `begin` (RAGFlow) or another
        // custom id for their start node. Keep `start.output.*` as the stable
        // cross-workflow alias while preserving the original node id.
        if (node.type === "start") scope.start = { output };
        finalOutput = node.type === "end" ? output : finalOutput;
        const selected = selectedEdges(node, output, definition.edges);
        for (const edge of selected) activeEdges.add(edge.id);
        this.dependencies.store.finishNodeRun(context, run.id, runningNode.id, { status: "success", input: resolvedInput, output, error: null, durationMs: Date.now() - nodeStarted, finishedAt: new Date().toISOString() });
      } catch (error) {
        failed = true;
        runError = safeError(error);
        this.dependencies.store.finishNodeRun(context, run.id, runningNode.id, { status: "failed", input: resolvedInput, output: null, error: runError, durationMs: Date.now() - nodeStarted, finishedAt: new Date().toISOString() });
      }
    }
    return this.dependencies.store.finishRun(context, run.id, failed ? "failed" : "success", finalOutput, runError, Date.now() - started);
  }

  private async executeNode(context: RequestContext, node: WorkflowNode, config: Record<string, unknown>, scope: Scope): Promise<unknown> {
    switch (node.type) {
      case "start": return scope.input;
      case "end": return config.output ?? lastOutput(scope);
      case "assign": return object(config.assignments ?? config.value ?? {});
      case "condition": return evaluateCondition(config);
      case "llm": {
        const modelId = required(config.modelId, "请选择 LLM 模型");
        const messages = [] as { role: "system" | "user"; content: string }[];
        if (String(config.systemPrompt || "").trim()) messages.push({ role: "system", content: String(config.systemPrompt) });
        messages.push({ role: "user", content: required(config.userPrompt, "请输入 User Prompt") });
        const response = await this.dependencies.models.chat(context, modelId, messages);
        return { text: response.content };
      }
      case "sql": {
        const datasourceId = required(config.datasourceId, "请选择数据源");
        this.dependencies.permissions.require(context, "database:read");
        const sql = assertAgentSql(required(config.sql, "请输入 SQL 模板"), this.dependencies.permissions.policy(context));
        const result = await executeSql(this.dependencies.connection(context, datasourceId), sql, false);
        return { rows: result.rows, columns: result.columns, rowCount: result.rowCount };
      }
      case "http": return this.executeHttp(config);
      case "code": return executeCode(required(config.code, "请输入 JavaScript 代码"), object(config.input ?? scope.input));
      default: throw new Error(`不支持的节点类型：${node.type}`);
    }
  }

  private async executeHttp(config: Record<string, unknown>) {
    const method = String(config.method || "GET").toUpperCase();
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) throw new Error("HTTP 方法仅支持 GET/POST/PUT/DELETE");
    const url = new URL(required(config.url, "请输入请求 URL"));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error("HTTP 节点只允许 http/https URL");
    if (isPrivateHost(url.hostname)) throw new Error("HTTP 节点禁止访问本机或私有网络地址");
    const query = object(config.query);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const headers = Object.fromEntries(Object.entries(object(config.headers)).map(([key, value]) => [key, String(value)]));
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await (this.dependencies.fetch || fetch)(url, {
        method,
        headers,
        signal: controller.signal,
        ...(method === "GET" || method === "DELETE" ? {} : { body: typeof config.body === "string" ? config.body : JSON.stringify(config.body ?? {}) }),
      });
      const text = await response.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* plain text response */ }
      return { status: response.status, body, headers: Object.fromEntries(response.headers.entries()) };
    } finally { clearTimeout(timer); }
  }

  private recordNode(context: RequestContext, runId: string, node: WorkflowNode, status: WorkflowNodeRunStatus, input: unknown, output: unknown, error: string | null, durationMs: number, startedAt: string | null, finishedAt: string | null): WorkflowNodeRun {
    return this.dependencies.store.addNodeRun(context, runId, { nodeId: node.id, nodeType: node.type, status, input, output, error, durationMs, startedAt, finishedAt });
  }
}

export function validateAndSort(definition: WorkflowDefinition): WorkflowNode[] {
  if (!definition || !Array.isArray(definition.nodes) || !Array.isArray(definition.edges)) throw new Error("工作流定义无效");
  const ids = new Set<string>();
  for (const node of definition.nodes) {
    if (!node.id || ids.has(node.id)) throw new Error("节点 ID 必须唯一且不能为空");
    if (!workflowNodeTypes.includes(node.type)) throw new Error(`未知节点类型：${node.type}`);
    ids.add(node.id);
  }
  if (definition.nodes.filter((node) => node.type === "start").length !== 1) throw new Error("工作流必须且只能包含一个开始节点");
  if (!definition.nodes.some((node) => node.type === "end")) throw new Error("工作流至少需要一个结束节点");
  const indegree = new Map(definition.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(definition.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of definition.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) throw new Error("连线引用了不存在的节点");
    indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
    outgoing.get(edge.source)!.push(edge.target);
  }
  const queue = definition.nodes.filter((node) => indegree.get(node.id) === 0);
  const ordered: WorkflowNode[] = [];
  while (queue.length) {
    const node = queue.shift()!; ordered.push(node);
    for (const target of outgoing.get(node.id) || []) {
      const degree = (indegree.get(target) || 0) - 1; indegree.set(target, degree);
      if (degree === 0) queue.push(definition.nodes.find((item) => item.id === target)!);
    }
  }
  if (ordered.length !== definition.nodes.length) throw new Error("工作流不能包含循环连线");
  return ordered;
}

export function resolveValue(value: unknown, scope: Scope): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
    if (exact) return getPath(scope, exact[1]);
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path: string) => stringify(getPath(scope, path)));
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, scope));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, scope)]));
  return value;
}

function getPath(scope: Scope, path: string) {
  const normalizedPath = path.trim();
  let current: unknown = scope;
  for (const part of normalizedPath.split(".")) current = current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined;
  if (current === undefined) {
    const inputField = normalizedPath.match(/^(?:start\.output|input)\.(.+)$/)?.[1];
    if (inputField) throw new Error(`运行输入缺少字段：${inputField}。请在顶部“运行输入”中传入该字段。`);
    throw new Error(`变量不存在：${path}`);
  }
  return current;
}
function selectedEdges(node: WorkflowNode, output: unknown, edges: WorkflowEdge[]) {
  const outgoing = edges.filter((edge) => edge.source === node.id);
  if (node.type !== "condition") return outgoing;
  const result = Boolean((output as { result?: unknown })?.result);
  return outgoing.filter((edge) => String(edge.sourceHandle || "true") === String(result));
}
function evaluateCondition(config: Record<string, unknown>) {
  const left = config.left; const right = config.right; const operator = String(config.operator || "==");
  let result = false;
  if (operator === "==") result = left === right || String(left) === String(right);
  else if (operator === "!=") result = !(left === right || String(left) === String(right));
  else if (operator === ">") result = Number(left) > Number(right);
  else if (operator === ">=") result = Number(left) >= Number(right);
  else if (operator === "<") result = Number(left) < Number(right);
  else if (operator === "<=") result = Number(left) <= Number(right);
  else if (operator === "contains") result = Array.isArray(left) ? left.includes(right) : String(left ?? "").includes(String(right ?? ""));
  else throw new Error(`不支持的条件运算符：${operator}`);
  return { result, left, right, operator };
}
function executeCode(code: string, input: Record<string, unknown>) {
  if (/\b(require|process|global|globalThis|import|eval|Function|WebAssembly)\b/.test(code)) throw new Error("代码节点禁止访问系统、模块加载或动态执行能力");
  const context = vm.createContext({ input: structuredClone(input), JSON, Math, Date });
  const script = new vm.Script(`"use strict"; (function (input) { ${code}\n})(input)`);
  const result = script.runInContext(context, { timeout: 500 });
  return JSON.parse(JSON.stringify(result ?? null));
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function required(value: unknown, message: string) { const text = String(value ?? "").trim(); if (!text) throw new Error(message); return text; }
function stringify(value: unknown) { return typeof value === "string" ? value : JSON.stringify(value); }
function safeError(error: unknown) { return (error instanceof Error ? error.message : "未知错误").slice(0, 1000); }
function lastOutput(scope: Scope) { const entries = Object.entries(scope).filter(([key]) => !['input', 'variables'].includes(key)); return (entries.at(-1)?.[1] as { output?: unknown } | undefined)?.output ?? null; }
function isPrivateHost(hostname: string) { const host = hostname.toLowerCase(); return host === "localhost" || host === "::1" || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host); }
