import vm from "node:vm";
import type { RequestContext } from "../core/types.js";
import type { DatabaseConfig } from "../database.js";
import { executeSql } from "../database.js";
import type { PermissionService } from "../auth/permission-service.js";
import { assertAgentSql } from "../security/sql-policy.js";
import type { ModelService } from "../llm/model-service.js";
import { validateMetadata, type KnowledgeRetrievalService } from "../knowledge/retrieval-service.js";
import type { WorkflowStore } from "./workflow-store.js";
import { workflowNodeTypes, type WorkflowDefinition, type WorkflowEdge, type WorkflowNode, type WorkflowNodeRun, type WorkflowNodeRunStatus, type WorkflowRun } from "./workflow-types.js";

type Scope = Record<string, unknown>;
export type WorkflowStreamListener = {
  signal?: AbortSignal;
  onStart?: (run: WorkflowRun) => void;
  onDelta?: (event: { runId: string; nodeId: string; delta: string; text: string }) => void;
};
type AgentTraceEntry = { type: "llm" | "tool"; name: string; input: unknown; output?: unknown; error?: string; durationMs: number; iteration: number };
type AgentToolConfig = Record<string, unknown> & { id: string; name: string; type: string };
class AgentExecutionError extends Error {
  constructor(message: string, readonly trace: AgentTraceEntry[]) { super(message); }
}
type EngineDependencies = {
  store: WorkflowStore;
  models: ModelService;
  knowledgeRetrieval?: KnowledgeRetrievalService;
  permissions: PermissionService;
  connection: (context: RequestContext, id: string) => DatabaseConfig;
  fetch?: typeof fetch;
};

export class WorkflowEngine {
  constructor(private readonly dependencies: EngineDependencies) {}

  async run(context: RequestContext, agentId: string, input: Record<string, unknown> = {}, stream?: WorkflowStreamListener): Promise<WorkflowRun> {
    const workflow = this.dependencies.store.getWorkflow(context, agentId);
    const ordered = validateAndSort(workflow.definition);
    const run = this.dependencies.store.createRun(context, agentId, workflow.version, input);
    stream?.onStart?.(run);
    return this.execute(context, workflow.definition, ordered, run, input, stream);
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

  private async execute(context: RequestContext, definition: WorkflowDefinition, ordered: WorkflowNode[], run: WorkflowRun, input: Record<string, unknown>, stream?: WorkflowStreamListener): Promise<WorkflowRun> {
    const started = Date.now();
    const scope: Scope = { input, variables: definition.variables };
    const activeEdges = new Set<string>();
    let failed = false;
    let finalOutput: unknown = null;
    let runError: string | null = null;

    for (const node of ordered) {
      if (stream?.signal?.aborted) throw abortError();
      const incoming = definition.edges.filter((edge) => edge.target === node.id && !isAgentToolEdge(edge, definition));
      const active = node.type === "start" || incoming.some((edge) => activeEdges.has(edge.id));
      if (!active || failed) {
        this.recordNode(context, run.id, node, "skipped", null, null, null, 0, null, null);
        if (!failed) scope[node.id] = { output: {}, skipped: true };
        continue;
      }
      const nodeStartedAt = new Date().toISOString();
      const nodeStarted = Date.now();
      let resolvedInput: unknown = null;
      let nodeExecutionFinished = false;
      const runningNode = this.recordNode(context, run.id, node, "running", null, null, null, 0, nodeStartedAt, null);
      try {
        if (node.type === "agent") {
          const agentInput = resolveValue(node.data.config.input ?? "{{start.output.query}}", scope);
          resolvedInput = resolveValue(node.data.config, { ...scope, agent: { input: agentInput } });
        } else resolvedInput = resolveValue(node.data.config, scope);
        if (node.type === "agent") {
          const connectedTools = resolveValue(connectedAgentTools(node.id, definition), scope) as AgentToolConfig[];
          resolvedInput = { ...object(resolvedInput), tools: [...asArray(object(resolvedInput).tools), ...connectedTools] };
        }
        const output = await this.executeNode(context, node, object(resolvedInput), scope, (partial) => {
          if (nodeExecutionFinished) return;
          this.dependencies.store.finishNodeRun(context, run.id, runningNode.id, { status: "running", input: resolvedInput, output: partial, error: null, durationMs: Date.now() - nodeStarted, finishedAt: new Date().toISOString() });
          const progress = object(partial);
          if (typeof progress.delta === "string") stream?.onDelta?.({ runId: run.id, nodeId: node.id, delta: progress.delta, text: String(progress.text || "") });
        }, stream?.signal);
        nodeExecutionFinished = true;
        scope[node.id] = { output };
        // Imported workflow formats commonly use `begin` (RAGFlow) or another
        // custom id for their start node. Keep `start.output.*` as the stable
        // cross-workflow alias while preserving the original node id.
        if (node.type === "start" && (node.id === "start" || !scope.start)) scope.start = { output };
        finalOutput = node.type === "end" ? output : finalOutput;
        const selected = selectedEdges(node, output, definition.edges.filter((edge) => !isAgentToolEdge(edge, definition)));
        for (const edge of selected) activeEdges.add(edge.id);
        this.dependencies.store.finishNodeRun(context, run.id, runningNode.id, { status: "success", input: resolvedInput, output, error: null, durationMs: Date.now() - nodeStarted, finishedAt: new Date().toISOString() });
      } catch (error) {
        nodeExecutionFinished = true;
        failed = true;
        runError = safeError(error);
        const output = error instanceof AgentExecutionError ? { trace: error.trace } : null;
        this.dependencies.store.finishNodeRun(context, run.id, runningNode.id, { status: "failed", input: resolvedInput, output, error: runError, durationMs: Date.now() - nodeStarted, finishedAt: new Date().toISOString() });
      }
    }
    return this.dependencies.store.finishRun(context, run.id, failed ? "failed" : "success", finalOutput, runError, Date.now() - started);
  }

  private async executeNode(context: RequestContext, node: WorkflowNode, config: Record<string, unknown>, scope: Scope, onProgress?: (output: unknown) => void, signal?: AbortSignal): Promise<unknown> {
    switch (node.type) {
      case "start": return validateStartInput(config, object(scope.input));
      case "end": return config.output ?? lastOutput(scope);
      case "assign": return object(config.assignments ?? config.value ?? {});
      case "condition": return evaluateCondition(config);
      case "llm": {
        const modelId = required(config.modelId, "请选择 LLM 模型");
        const messages = [] as { role: "system" | "user"; content: string }[];
        if (String(config.systemPrompt || "").trim()) messages.push({ role: "system", content: String(config.systemPrompt) });
        messages.push({ role: "user", content: required(config.userPrompt, "请输入 User Prompt") });
        let text = "";
        const response = await this.dependencies.models.chat(context, modelId, messages, { signal, onToken: onProgress ? (delta) => {
          text += delta;
          onProgress({ text, delta, streaming: true });
        } : undefined });
        return { text: response.content };
      }
      case "agent": return this.executeAgent(context, config, onProgress, object(scope.input).__conversationHistory, signal);
      case "knowledge_retrieval": {
        if (!this.dependencies.knowledgeRetrieval) throw new Error("知识库检索服务未配置");
        const result = await this.dependencies.knowledgeRetrieval.retrieve(context, {
          knowledgeBaseId: required(config.knowledgeBaseId, "请选择知识库"),
          query: required(config.query, "请输入检索问题"),
          filters: validateMetadata(config.filters),
          retrievalMode: config.retrievalMode === "hybrid" ? "hybrid" : "vector",
          topK: optionalNumber(config.topK),
          scoreThreshold: optionalNumber(config.scoreThreshold),
          rerank: config.rerank === true,
          rerankModel: String(config.rerankModel || "").trim() || undefined,
          rerankTopK: optionalNumber(config.rerankTopK),
          vectorWeight: optionalNumber(config.vectorWeight),
          candidateCount: optionalNumber(config.candidateCount),
        });
        return {
          items: result.items,
          topScore: result.items[0]?.score ?? 0,
          hitCount: result.items.length,
        };
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

  private async executeAgent(context: RequestContext, config: Record<string, unknown>, onProgress?: (output: unknown) => void, conversationHistory?: unknown, signal?: AbortSignal) {
    const trace: AgentTraceEntry[] = [];
    const modelId = required(config.modelId, "请选择 Agent LLM 模型");
    const maxIterations = boundedInteger(config.maxIterations, 5, 1, 20, "最大迭代次数");
    const timeoutMs = boundedInteger(config.timeoutMs, 30_000, 1_000, 600_000, "响应超时");
    const tools = normalizeAgentTools(config.tools);
    const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
    const toolGuidance = tools.length ? `\n\n可用工具（仅在确有必要时调用）：\n${tools.map((tool) => `- ${tool.name}: ${String(tool.description || tool.name)}。参数 JSON：{"query":"检索问题"${tool.dynamicFilters === false ? "" : ",\"filters\":{}"}}${tool.dynamicFilters === false ? "（不要传 filters）" : ""}`).join("\n")}\n\n需要调用工具时，只输出 JSON：{"action":"tool_call","tool_name":"工具名","arguments":{"query":"...","filters":{}}}。工具结果会返回给你。无需工具或完成检索后，直接输出面向用户的最终回复，不要输出 JSON。` : "\n\n当前没有可用工具，请直接根据已知信息回复。";
    const systemPrompt = `${String(config.systemPrompt || "你是一个严谨、通用的 AI Agent。")}${toolGuidance}`;
    const userPrompt = String(config.userPrompt ?? config.input ?? "").trim();
    if (!userPrompt) throw new Error("请输入 Agent 用户提示词");
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [{ role: "system", content: systemPrompt }];
    if (config.memory !== false) {
      const history = normalizeConversationHistory(conversationHistory);
      messages.push(...history);
    }
    messages.push({ role: "user", content: userPrompt });
    const deadline = Date.now() + timeoutMs;
    let toolCalls = 0;
    let toolsDisabledAfterLimit = false;
    let timedOut = false;
    let liveText = "";
    let timer: ReturnType<typeof setTimeout> | undefined;

    const executeLoop = async () => {
      while (true) {
        if (timedOut) throw new Error(`Agent 响应超时（${timeoutMs}ms）`);
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`Agent 响应超时（${timeoutMs}ms）`);
        const iteration = toolCalls + 1;
        const callStarted = Date.now();
        let responseContent = "";
        try {
          const response = await this.dependencies.models.chat(context, modelId, messages, {
            temperature: optionalNumber(config.temperature),
            timeout: Math.max(1, remaining),
            signal,
            onToken: onProgress ? (token) => {
              if (timedOut) return;
              responseContent += token;
              const trimmed = responseContent.trimStart();
              if (trimmed && !trimmed.startsWith("{")) {
                liveText += token;
                onProgress({ text: liveText, delta: token, streaming: true, trace: [...trace] });
              }
            } : undefined,
          });
          if (timedOut) throw new Error(`Agent 响应超时（${timeoutMs}ms）`);
          responseContent = response.content;
          trace.push({ type: "llm", name: modelId, input: messages.map((message) => ({ ...message })), output: response.content, durationMs: response.latencyMs ?? Date.now() - callStarted, iteration });
        } catch (error) {
          trace.push({ type: "llm", name: modelId, input: messages.map((message) => ({ ...message })), error: safeError(error), durationMs: Date.now() - callStarted, iteration });
          throw error;
        }

        const decision = parseAgentDecision(responseContent);
        if (!decision.toolName) {
          const text = decision.finalText || responseContent.trim();
          return { text, iterations: toolCalls, trace };
        }
        if (toolsDisabledAfterLimit || toolCalls >= maxIterations) {
          const error = `Agent 达到最大迭代次数（${maxIterations}）后仍请求调用工具`;
          trace.push({ type: "tool", name: decision.toolName, input: decision.arguments, error, durationMs: 0, iteration });
          throw new Error(error);
        }
        const tool = toolByName.get(decision.toolName);
        if (!tool) {
          const error = `Agent 请求了未配置的工具：${decision.toolName}`;
          trace.push({ type: "tool", name: decision.toolName, input: decision.arguments, error, durationMs: 0, iteration });
          throw new Error(error);
        }
        const toolStarted = Date.now();
        const args = object(decision.arguments);
        try {
          const result = await this.executeAgentTool(context, tool, args);
          if (timedOut) throw new Error(`Agent 响应超时（${timeoutMs}ms）`);
          trace.push({ type: "tool", name: tool.name, input: args, output: result, durationMs: Date.now() - toolStarted, iteration });
          toolCalls += 1;
          messages.push({ role: "assistant", content: responseContent });
          messages.push({ role: "user", content: `工具 ${tool.name} 执行结果：\n${JSON.stringify(result)}\n请基于结果继续推理；如需更多信息可调用工具，否则给出最终回复。` });
        } catch (error) {
          trace.push({ type: "tool", name: tool.name, input: args, error: safeError(error), durationMs: Date.now() - toolStarted, iteration });
          throw error;
        }
        liveText = "";
        if (toolCalls >= maxIterations && !toolsDisabledAfterLimit) {
          toolsDisabledAfterLimit = true;
          messages.push({ role: "user", content: `已达到最大工具调用次数 ${maxIterations}。不要再调用任何工具，请直接根据现有信息给出最终回复。` });
        }
      }
    };

    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { timedOut = true; reject(new Error(`Agent 响应超时（${timeoutMs}ms）`)); }, timeoutMs);
      });
      return await Promise.race([executeLoop(), timeout]);
    } catch (error) {
      throw new AgentExecutionError(safeError(error), [...trace]);
    } finally {
      if (timer) clearTimeout(timer);
      if (timedOut) liveText = "";
    }
  }

  private async executeAgentTool(context: RequestContext, tool: AgentToolConfig, args: Record<string, unknown>) {
    if (tool.type !== "knowledge_retrieval") throw new Error(`不支持的 Agent Tool 类型：${tool.type}`);
    if (!this.dependencies.knowledgeRetrieval) throw new Error("知识库检索服务未配置");
    const query = required(args.query, `工具 ${tool.name} 缺少 query 参数`);
    const dynamicFilters = tool.dynamicFilters === false ? {} : validateMetadata(args.filters, "Agent 动态 filters");
    const filters = { ...validateMetadata(tool.filters), ...dynamicFilters };
    const result = await this.dependencies.knowledgeRetrieval.retrieve(context, {
      knowledgeBaseId: required(tool.knowledgeBaseId, `工具 ${tool.name} 未配置知识库`),
      query,
      filters,
      retrievalMode: tool.retrievalMode === "hybrid" ? "hybrid" : "vector",
      topK: optionalNumber(tool.topK),
      scoreThreshold: optionalNumber(tool.scoreThreshold),
      rerank: tool.rerank === true,
      rerankModel: String(tool.rerankModel || "").trim() || undefined,
      rerankTopK: optionalNumber(tool.rerankTopK),
      vectorWeight: optionalNumber(tool.vectorWeight),
      candidateCount: optionalNumber(tool.candidateCount),
    });
    return { items: result.items, topScore: result.items[0]?.score ?? 0, hitCount: result.items.length };
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

function validateStartInput(config: Record<string, unknown>, input: Record<string, unknown>) {
  if (!Array.isArray(config.inputs)) return input;
  for (const raw of config.inputs) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const definition = raw as Record<string, unknown>;
    const key = String(definition.key || "").trim();
    if (!key) continue;
    const value = getObjectPath(input, key);
    if (definition.required !== false && (value === undefined || value === null || value === "")) throw new Error(`运行输入缺少字段：${key}。请在顶部“运行输入”中传入该字段。`);
    if (value === undefined || value === null) continue;
    const type = String(definition.type || "string");
    const valid = type === "object" ? typeof value === "object" && !Array.isArray(value) : type === "number" ? typeof value === "number" && Number.isFinite(value) : type === "boolean" ? typeof value === "boolean" : type === "string" ? typeof value === "string" : true;
    if (!valid) throw new Error(`运行输入字段 ${key} 类型错误，应为 ${type}`);
  }
  return input;
}

function getObjectPath(value: Record<string, unknown>, path: string) {
  let current: unknown = value;
  for (const part of path.split(".")) current = current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>)[part] : undefined;
  return current;
}

export function validateAndSort(definition: WorkflowDefinition): WorkflowNode[] {
  if (!definition || !Array.isArray(definition.nodes) || !Array.isArray(definition.edges)) throw new Error("工作流定义无效");
  const ids = new Set<string>();
  for (const node of definition.nodes) {
    if (!node.id || ids.has(node.id)) throw new Error("节点 ID 必须唯一且不能为空");
    if (!workflowNodeTypes.includes(node.type)) throw new Error(`未知节点类型：${node.type}`);
    ids.add(node.id);
  }
  if (!definition.nodes.some((node) => node.type === "start")) throw new Error("工作流至少需要一个消息输入节点");
  if (!definition.nodes.some((node) => node.type === "end")) throw new Error("工作流至少需要一个消息输出节点");
  const indegree = new Map(definition.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(definition.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of definition.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) throw new Error("连线引用了不存在的节点");
    if (isAgentToolEdge(edge, definition)) {
      const source = definition.nodes.find((node) => node.id === edge.source);
      if (source?.type !== "knowledge_retrieval") throw new Error("Agent 工具列表目前仅支持知识库检索节点");
      continue;
    }
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
  const rawPath = path.trim();
  const optional = rawPath.endsWith("?");
  const normalizedPath = optional ? rawPath.slice(0, -1) : rawPath;
  const root = normalizedPath.split(".")[0];
  let current: unknown = scope;
  for (const part of normalizedPath.split(".")) current = current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined;
  if (current === undefined) {
    if (optional) return "";
    const skippedNode = scope[root];
    if (skippedNode && typeof skippedNode === "object" && (skippedNode as Record<string, unknown>).skipped === true) return "";
    const inputField = normalizedPath.match(/^(?:start\.output|input)\.(.+)$/)?.[1];
    if (inputField) throw new Error(`运行输入缺少字段：${inputField}。请在顶部“运行输入”中传入该字段。`);
    throw new Error(`变量不存在：${path}`);
  }
  return current;
}
function isAgentToolEdge(edge: WorkflowEdge, definition: WorkflowDefinition) {
  if (edge.targetHandle !== "tools") return false;
  return definition.nodes.find((node) => node.id === edge.target)?.type === "agent";
}
function connectedAgentTools(agentId: string, definition: WorkflowDefinition): AgentToolConfig[] {
  return definition.edges
    .filter((edge) => edge.target === agentId && isAgentToolEdge(edge, definition))
    .flatMap((edge, index) => {
      const node = definition.nodes.find((item) => item.id === edge.source);
      if (!node || node.type !== "knowledge_retrieval") return [];
      const config = node.data.config;
      const toolConfig = Object.fromEntries(Object.entries(config).filter(([key]) => key !== "query"));
      return [{
        ...toolConfig,
        id: node.id,
        type: "knowledge_retrieval",
        name: String(config.toolName || `knowledge_search_${index + 1}`),
        description: String(config.toolDescription || `使用${node.data.label}检索相关知识`),
        dynamicFilters: config.dynamicFilters !== false,
      }];
    });
}
function selectedEdges(node: WorkflowNode, output: unknown, edges: WorkflowEdge[]) {
  const outgoing = edges.filter((edge) => edge.source === node.id);
  if (node.type !== "condition") return outgoing;
  const branchId = String((output as { branchId?: unknown })?.branchId || "");
  if (branchId) return outgoing.filter((edge) => String(edge.sourceHandle || "false") === branchId);
  const result = Boolean((output as { result?: unknown })?.result);
  return outgoing.filter((edge) => String(edge.sourceHandle || "true") === String(result));
}
function evaluateCondition(config: Record<string, unknown>) {
  const branches = Array.isArray(config.branches) ? config.branches : [];
  if (branches.length) {
    for (const rawBranch of branches) {
      const branch = object(rawBranch);
      const branchId = required(branch.id, "条件分支缺少标识");
      const matched = evaluateConditionGroup(branch.condition ?? branch.group, 0);
      if (matched) return { result: true, branchId, matchedBranchId: branchId };
    }
    return { result: false, branchId: "false", matchedBranchId: null };
  }
  const left = config.left; const right = config.right; const operator = String(config.operator || "==");
  const result = compareCondition(left, operator, right);
  return { result, left, right, operator };
}
function evaluateConditionGroup(value: unknown, depth: number): boolean {
  if (depth > 10) throw new Error("条件嵌套最多支持 10 层");
  const group = object(value);
  const items = asArray(group.items);
  if (!items.length) return false;
  const results = items.map((rawItem) => {
    const item = object(rawItem);
    return Array.isArray(item.items)
      ? evaluateConditionGroup(item, depth + 1)
      : compareCondition(item.left, String(item.operator || "=="), item.right);
  });
  return String(group.combinator || "and").toLowerCase() === "or" ? results.some(Boolean) : results.every(Boolean);
}
function compareCondition(left: unknown, operator: string, right: unknown) {
  if (operator === "==") return left === right || String(left) === String(right);
  if (operator === "!=") return !(left === right || String(left) === String(right));
  if (operator === ">") return Number(left) > Number(right);
  if (operator === ">=") return Number(left) >= Number(right);
  if (operator === "<") return Number(left) < Number(right);
  if (operator === "<=") return Number(left) <= Number(right);
  if (operator === "contains") return Array.isArray(left) ? left.includes(right) : String(left ?? "").includes(String(right ?? ""));
  if (operator === "not_contains") return Array.isArray(left) ? !left.includes(right) : !String(left ?? "").includes(String(right ?? ""));
  if (operator === "is_empty") return left === null || left === undefined || left === "" || (Array.isArray(left) && left.length === 0);
  if (operator === "is_not_empty") return !(left === null || left === undefined || left === "" || (Array.isArray(left) && left.length === 0));
  throw new Error(`不支持的条件运算符：${operator}`);
}
function executeCode(code: string, input: Record<string, unknown>) {
  if (/\b(require|process|global|globalThis|import|eval|Function|WebAssembly)\b/.test(code)) throw new Error("代码节点禁止访问系统、模块加载或动态执行能力");
  const context = vm.createContext({ input: structuredClone(input), JSON, Math, Date });
  const script = new vm.Script(`"use strict"; (function (input) { ${code}\n})(input)`);
  const result = script.runInContext(context, { timeout: 500 });
  return JSON.parse(JSON.stringify(result ?? null));
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function required(value: unknown, message: string) { const text = String(value ?? "").trim(); if (!text) throw new Error(message); return text; }
function optionalNumber(value: unknown) { if (value === undefined || value === null || value === "") return undefined; const number = Number(value); if (!Number.isFinite(number)) throw new Error("检索参数必须是有效数字"); return number; }
function boundedInteger(value: unknown, fallback: number, min: number, max: number, label: string) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label}必须是 ${min} 到 ${max} 之间的整数`);
  return number;
}
function normalizeAgentTools(value: unknown): AgentToolConfig[] {
  if (!Array.isArray(value)) return [];
  const names = new Set<string>();
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const raw = item as Record<string, unknown>;
    const id = String(raw.id || `tool_${index + 1}`);
    const baseName = String(raw.name || id).trim().replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || `tool_${index + 1}`;
    let name = baseName;
    let suffix = 2;
    while (names.has(name)) name = `${baseName}_${suffix++}`;
    names.add(name);
    return [{ ...raw, id, name, type: String(raw.type || "knowledge_retrieval") }];
  });
}
function normalizeConversationHistory(value: unknown): { role: "user" | "assistant"; content: string }[] {
  if (!Array.isArray(value)) return [] as { role: "user" | "assistant"; content: string }[];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const message = item as Record<string, unknown>;
    if (message.role !== "user" && message.role !== "assistant") return [];
    const content = String(message.content || "").trim();
    return content ? [{ role: message.role as "user" | "assistant", content }] : [];
  }).slice(-40);
}
function parseAgentDecision(content: string): { toolName?: string; arguments?: unknown; finalText?: string } {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: Record<string, unknown>;
  try { parsed = object(JSON.parse(cleaned)); } catch { return {}; }
  const call = Array.isArray(parsed.tool_calls) ? object(parsed.tool_calls[0]) : {};
  const fn = object(call.function);
  const toolName = String(parsed.tool_name || parsed.toolName || parsed.name || fn.name || "").trim();
  if (toolName && (parsed.action === "tool_call" || parsed.action === "tool" || call.function || parsed.tool_name || parsed.toolName)) {
    let args = parsed.arguments ?? parsed.parameters ?? fn.arguments ?? {};
    if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
    return { toolName, arguments: args };
  }
  const finalText = parsed.action === "final" ? parsed.final_answer ?? parsed.answer ?? parsed.text : undefined;
  return { finalText: typeof finalText === "string" ? finalText.trim() : undefined };
}
function stringify(value: unknown) { return typeof value === "string" ? value : JSON.stringify(value); }
function abortError() { const error = new Error("运行已中断"); error.name = "AbortError"; return error; }
function safeError(error: unknown) { return (error instanceof Error ? error.message : "未知错误").slice(0, 1000); }
function lastOutput(scope: Scope) { const entries = Object.entries(scope).filter(([key]) => !['input', 'variables'].includes(key)); return (entries.at(-1)?.[1] as { output?: unknown } | undefined)?.output ?? null; }
function isPrivateHost(hostname: string) { const host = hostname.toLowerCase(); return host === "localhost" || host === "::1" || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host); }
