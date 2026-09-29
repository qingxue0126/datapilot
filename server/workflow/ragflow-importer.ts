import type { WorkflowDefinition, WorkflowEdge, WorkflowNode, WorkflowNodeType } from "./workflow-types.js";

type JsonObject = Record<string, unknown>;
type RagflowNode = JsonObject & {
  id?: unknown;
  type?: unknown;
  position?: unknown;
  data?: unknown;
};

export type RagflowImportReport = {
  importedNodes: number;
  importedEdges: number;
  unsupported: { nodeId: string; sourceType: string; replacement: WorkflowNodeType; reason: string }[];
  warnings: string[];
};

export function importRagflowWorkflow(value: unknown, options: { defaultModelId?: string } = {}): { definition: WorkflowDefinition; report: RagflowImportReport } {
  const root = object(value, "RAGFlow JSON 必须是对象");
  const graph = object(root.graph, "RAGFlow JSON 缺少 graph");
  const sourceNodes = array(graph.nodes, "RAGFlow JSON 缺少 graph.nodes") as RagflowNode[];
  const sourceEdges = array(graph.edges, "RAGFlow JSON 缺少 graph.edges");
  if (!sourceNodes.length) throw new Error("RAGFlow 工作流没有节点");

  const ids = new Set<string>();
  const sourceKinds = new Map<string, string>();
  const mappedTypes = new Map<string, WorkflowNodeType>();
  const unsupported: RagflowImportReport["unsupported"] = [];
  const warnings: string[] = [];

  for (const source of sourceNodes) {
    const id = requiredString(source.id, "RAGFlow 节点缺少 id");
    if (ids.has(id)) throw new Error(`RAGFlow 节点 ID 重复：${id}`);
    ids.add(id);
    const kind = sourceKind(source);
    sourceKinds.set(id, kind);
    mappedTypes.set(id, mappedType(kind));
  }

  let nodes = sourceNodes.map((source, index) => {
    const id = String(source.id);
    const kind = sourceKinds.get(id)!;
    const type = mappedTypes.get(id)!;
    const data = optionalObject(source.data);
    const form = optionalObject(data.form);
    const position = optionalObject(source.position);
    const label = String(data.name || data.label || id).trim() || id;
    const config = convertConfig(id, kind, type, form, mappedTypes, options.defaultModelId || "", unsupported);
    return {
      id,
      type,
      position: {
        x: finite(position.x, (index % 4) * 300),
        y: finite(position.y, Math.floor(index / 4) * 180),
      },
      data: { label, config },
    } satisfies WorkflowNode;
  });

  const startNodes = nodes.filter((node) => node.type === "start");
  if (!startNodes.length) {
    nodes = [{ id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "开始", config: {} } }, ...nodes];
    ids.add("start");
    warnings.push("原文件没有 Begin 节点，已自动补充开始节点。请检查连线。");
  } else if (startNodes.length > 1) {
    throw new Error("RAGFlow 工作流包含多个 Begin 节点，无法确定唯一入口");
  }
  const startNode = nodes.find((node) => node.type === "start");
  if (startNode) {
    const existing = Array.isArray(startNode.data.config.inputs) ? startNode.data.config.inputs : [];
    const supplemental = sourceNodes.filter((source) => sourceKind(source) === "userfillup").flatMap((source) => ragflowInputDefinitions(optionalObject(optionalObject(source.data).form), false));
    const seen = new Set(existing.map((item) => String(optionalObject(item).key || "")));
    startNode.data.config.inputs = [...existing, ...supplemental.filter((item) => !seen.has(String(item.key)))];
  }

  const edges: WorkflowEdge[] = [];
  for (const [index, raw] of sourceEdges.entries()) {
    const edge = optionalObject(raw);
    const source = String(edge.source || "");
    const target = String(edge.target || "");
    if (!ids.has(source) || !ids.has(target)) {
      warnings.push(`已忽略引用不存在节点的连线：${source || "?"} → ${target || "?"}`);
      continue;
    }
    const mappedSource = mappedTypes.get(source);
    edges.push({
      id: String(edge.id || `imported-edge-${index + 1}`),
      source,
      target,
      sourceHandle: mappedSource === "condition" ? conditionHandle(sourceNodes, source, target, edge) : null,
      targetHandle: null,
    });
  }

  if (!nodes.some((node) => node.type === "end")) {
    const endId = ids.has("end") ? "imported-end" : "end";
    const last = nodes.at(-1)!;
    nodes.push({ id: endId, type: "end", position: { x: last.position.x + 300, y: last.position.y }, data: { label: "结束", config: { output: `{{${last.id}.output}}` } } });
    edges.push({ id: `imported-edge-${edges.length + 1}`, source: last.id, target: endId });
    warnings.push("原文件没有 Message/结束节点，已自动补充结束节点。请检查返回值。");
  }

  if (!options.defaultModelId && nodes.some((node) => node.type === "llm")) warnings.push("未找到可用的 DataPilot LLM；请在导入后为 LLM 节点选择模型。");
  else if (nodes.some((node) => node.type === "llm")) warnings.push("RAGFlow 模型 ID 不跨系统复用，LLM 节点已绑定当前 DataPilot 默认模型。");

  return {
    definition: { nodes, edges, variables: optionalObject(root.variables) },
    report: { importedNodes: nodes.length, importedEdges: edges.length, unsupported, warnings },
  };
}

function convertConfig(nodeId: string, source: string, target: WorkflowNodeType, form: JsonObject, mappedTypes: Map<string, WorkflowNodeType>, defaultModelId: string, unsupported: RagflowImportReport["unsupported"]): JsonObject {
  if (target === "start") return convertStartConfig(form);
  if (target === "llm") {
    const prompts = Array.isArray(form.prompts) ? form.prompts.map(optionalObject) : [];
    const userPrompt = prompts.filter((item) => String(item.role || "user") === "user").map((item) => String(item.content || "")).filter(Boolean).join("\n\n") || String(form.user_prompt || "") || "{sys.query}";
    return {
      modelId: defaultModelId,
      systemPrompt: convertReferences(String(form.sys_prompt || ""), mappedTypes),
      userPrompt: convertReferences(userPrompt, mappedTypes),
      temperature: finite(form.temperature, 0.1),
      importedModelId: String(form.llm_id || ""),
    };
  }
  if (target === "condition") {
    const condition = optionalObject((Array.isArray(form.conditions) ? form.conditions : [])[0]);
    const item = optionalObject((Array.isArray(condition.items) ? condition.items : [])[0]);
    return {
      left: convertBareReference(String(item.cpn_id || ""), mappedTypes),
      operator: conditionOperator(String(item.operator || "=")),
      right: item.value ?? "",
    };
  }
  if (source === "userfillup") {
    const fields = ragflowInputDefinitions(form, true);
    const assignments = Object.fromEntries(fields.map((field) => [String(field.key), `{{start.output.${String(field.key)}${field.required === false ? "?" : ""}}}`]));
    unsupported.push({ nodeId, sourceType: "UserFillUp", replacement: "assign", reason: "DataPilot V1 暂不支持运行中暂停收集表单，已改为从运行输入读取同名字段。" });
    return { assignments };
  }
  if (source === "retrieval") {
    unsupported.push({ nodeId, sourceType: "Retrieval", replacement: "code", reason: "RAGFlow 数据集 ID 无法直接映射到 DataPilot 知识库，请导入后替换为知识库检索配置。" });
    return {
      input: { query: convertReferences(String(form.query || "{sys.query}"), mappedTypes) },
      code: "return { formalized_content: \"\", json: [], query: input.query, requiresConfiguration: true };",
      importedConfig: form,
    };
  }
  if (target === "end") {
    const content = Array.isArray(form.content) ? form.content.map(String).join("\n") : String(form.content || "");
    return { output: convertReferences(content || "{{start.output}}", mappedTypes) };
  }
  unsupported.push({ nodeId, sourceType: source || "unknown", replacement: "code", reason: "DataPilot 暂无对应执行器，已保留节点和原始配置供手动适配。" });
  return { input: "{{start.output}}", code: `return { importedNode: ${JSON.stringify(source || "unknown")}, requiresConfiguration: true, input };`, importedConfig: form };
}

function convertStartConfig(form: JsonObject): JsonObject {
  const sourceMode = String(form.mode || "conversational").toLowerCase();
  const mode = sourceMode === "task" ? "task" : sourceMode === "webhook" ? "webhook" : "conversation";
  const inputs = ragflowInputDefinitions(form, true);
  return {
    mode,
    enablePrologue: form.enablePrologue !== false,
    prologue: String(form.prologue || ""),
    inputs,
    webhookMethod: String(form.method || "GET").toUpperCase(),
    webhookSecurity: "none",
    webhookRequestMode: "json",
    webhookResponseMode: "workflow",
  };
}

function ragflowInputDefinitions(form: JsonObject, preserveRequired: boolean) {
  const rawInputs = optionalObject(form.inputs ?? form.outputs);
  return Object.entries(rawInputs).map(([key, raw]) => {
    const input = optionalObject(raw);
    const sourceType = String(input.type || "string").toLowerCase();
    const type = sourceType === "number" ? "number" : sourceType === "boolean" ? "boolean" : sourceType === "object" ? "object" : "string";
    return { key, name: String(input.name || input.label || key), type, required: preserveRequired ? input.optional !== true && input.required !== false : false, options: Array.isArray(input.options) ? input.options.map(String) : undefined };
  });
}

function convertReferences(value: string, mappedTypes: Map<string, WorkflowNodeType>) {
  return value
    .replace(/\{sys\.([\w.-]+)\}/g, (_match, path: string) => `{{start.output.${path}}}`)
    .replace(/\{([^{}@]+)@([^{}]+)\}/g, (_match, nodeId: string, output: string) => `{{${nodeId}.output.${outputName(nodeId, output, mappedTypes)}}}`);
}

function convertBareReference(value: string, mappedTypes: Map<string, WorkflowNodeType>) {
  if (value.startsWith("sys.")) return `{{start.output.${value.slice(4)}}}`;
  const separator = value.lastIndexOf("@");
  if (separator > 0) {
    const nodeId = value.slice(0, separator);
    const output = value.slice(separator + 1);
    return `{{${nodeId}.output.${outputName(nodeId, output, mappedTypes)}}}`;
  }
  return convertReferences(value, mappedTypes);
}

function outputName(nodeId: string, output: string, mappedTypes: Map<string, WorkflowNodeType>) {
  return mappedTypes.get(nodeId) === "llm" && output === "content" ? "text" : output;
}

function sourceKind(node: RagflowNode) {
  const data = optionalObject(node.data);
  const label = String(data.label || "").replace(/Node$/i, "").toLowerCase();
  if (["begin", "agent", "switch", "message", "retrieval", "userfillup"].includes(label)) return label;
  return String(node.type || "unknown").replace(/Node$/i, "").toLowerCase();
}

function mappedType(source: string): WorkflowNodeType {
  if (source === "begin") return "start";
  if (source === "agent") return "llm";
  if (source === "switch") return "condition";
  if (source === "message") return "end";
  if (source === "userfillup") return "assign";
  return "code";
}

function conditionHandle(nodes: RagflowNode[], sourceId: string, targetId: string, edge: JsonObject) {
  const source = nodes.find((node) => String(node.id) === sourceId);
  const form = optionalObject(optionalObject(source?.data).form);
  const conditions = Array.isArray(form.conditions) ? form.conditions.map(optionalObject) : [];
  const conditionalTarget = conditions.some((condition) => (Array.isArray(condition.to) ? condition.to : []).map(String).includes(targetId));
  if (conditionalTarget || /^case\s*1$/i.test(String(edge.sourceHandle || ""))) return "true";
  return "false";
}

function conditionOperator(value: string) {
  const operators: Record<string, string> = { "=": "==", "==": "==", "!=": "!=", "≠": "!=", ">": ">", ">=": ">=", "<": "<", "<=": "<=", contains: "contains" };
  return operators[value] || "==";
}

function object(value: unknown, message: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as JsonObject;
}
function optionalObject(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
function array(value: unknown, message: string): unknown[] { if (!Array.isArray(value)) throw new Error(message); return value; }
function requiredString(value: unknown, message: string) { const result = String(value || "").trim(); if (!result) throw new Error(message); return result; }
function finite(value: unknown, fallback: number) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
