export type WorkflowVariableType = "string" | "number" | "boolean" | "object" | "array" | "unknown";

export type WorkflowVariableField = {
  path: string;
  label: string;
  type: WorkflowVariableType;
};

export type WorkflowVariableGroup = {
  nodeId: string;
  nodeLabel: string;
  nodeType: string;
  fields: WorkflowVariableField[];
};

type VariableNode = {
  id: string;
  type?: string;
  data: { label: string; nodeType?: string; config: Record<string, unknown> };
};

type VariableEdge = { source: string; target: string; targetHandle?: string | null };

export function variableExpression(nodeId: string, path: string) {
  return `{{${nodeId}.output${path ? `.${path}` : ""}}}`;
}

export function insertVariableAt(value: string, expression: string, start = value.length, end = start) {
  return `${value.slice(0, start)}${expression}${value.slice(end)}`;
}

export function buildWorkflowVariableGroups(nodes: VariableNode[], edges: VariableEdge[], currentNodeId: string): WorkflowVariableGroup[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.targetHandle === "tools") continue;
    incoming.set(edge.target, [...(incoming.get(edge.target) || []), edge.source]);
  }
  const distance = new Map<string, number>();
  const visit = (id: string, depth: number) => {
    for (const source of incoming.get(id) || []) {
      if (source === currentNodeId || (distance.get(source) ?? -1) >= depth) continue;
      distance.set(source, depth);
      visit(source, depth + 1);
    }
  };
  visit(currentNodeId, 0);
  return [...distance.entries()]
    .sort((a, b) => b[1] - a[1] || nodes.findIndex((node) => node.id === a[0]) - nodes.findIndex((node) => node.id === b[0]))
    .flatMap(([id]) => {
      const node = nodeById.get(id);
      if (!node) return [];
      const nodeType = node.data.nodeType || node.type || "";
      return [{ nodeId: id, nodeLabel: node.data.label || id, nodeType, fields: outputFields(nodeType, node.data.config) }];
    });
}

function outputFields(type: string, config: Record<string, unknown>): WorkflowVariableField[] {
  if (type === "start") {
    const fields: WorkflowVariableField[] = [{ path: "query", label: "query", type: "string" }, { path: "__conversationHistory", label: "__conversationHistory", type: "array" }];
    if (Array.isArray(config.inputs)) for (const raw of config.inputs) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const input = raw as Record<string, unknown>;
      const path = String(input.key || "").trim();
      if (path && !fields.some((field) => field.path === path)) fields.push({ path, label: path, type: normalizeType(input.type) });
    }
    return fields;
  }
  if (type === "llm") return [{ path: "text", label: "text", type: "string" }];
  if (type === "agent") return [{ path: "text", label: "text", type: "string" }, { path: "iterations", label: "iterations", type: "number" }, { path: "trace", label: "trace", type: "array" }];
  if (type === "knowledge_retrieval") return [{ path: "items", label: "items", type: "array" }, { path: "topScore", label: "topScore", type: "number" }, { path: "hitCount", label: "hitCount", type: "number" }];
  if (type === "sql") return [{ path: "rows", label: "rows", type: "array" }, { path: "columns", label: "columns", type: "array" }, { path: "rowCount", label: "rowCount", type: "number" }];
  if (type === "http") return [{ path: "status", label: "status", type: "number" }, { path: "body", label: "body", type: "unknown" }, { path: "headers", label: "headers", type: "object" }];
  if (type === "condition") return [{ path: "result", label: "result", type: "boolean" }, { path: "branchId", label: "branchId", type: "string" }, { path: "matchedBranchId", label: "matchedBranchId", type: "string" }];
  if (type === "assign") return objectFields(config.assignments);
  if (type === "code") {
    const fromSchema = objectFields(config.outputSchema);
    if (fromSchema.length) return fromSchema;
    const code = String(config.code || "");
    const body = code.match(/return\s*\{([\s\S]*?)\}/)?.[1] || "";
    const keys = [...body.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?::|,|$)/g)].map((match) => match[1]);
    return keys.length ? [...new Set(keys)].map((path) => ({ path, label: path, type: "unknown" as const })) : [{ path: "result", label: "result", type: "unknown" }];
  }
  return [{ path: "", label: "output", type: "unknown" }];
}

function objectFields(value: unknown): WorkflowVariableField[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).map(([path, item]) => ({ path, label: path, type: inferType(item) }));
}

function inferType(value: unknown): WorkflowVariableType {
  if (Array.isArray(value)) return "array";
  if (value === null || value === undefined || (typeof value === "string" && value.includes("{{"))) return "unknown";
  return normalizeType(typeof value);
}

function normalizeType(value: unknown): WorkflowVariableType {
  const type = String(value);
  return ["string", "number", "boolean", "object"].includes(type) ? type as WorkflowVariableType : "unknown";
}
