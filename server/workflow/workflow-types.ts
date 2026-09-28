export const workflowNodeTypes = ["start", "llm", "sql", "http", "code", "condition", "assign", "end"] as const;
export type WorkflowNodeType = typeof workflowNodeTypes[number];
export type WorkflowStatus = "draft" | "published" | "disabled";
export type WorkflowRunStatus = "pending" | "running" | "success" | "failed";
export type WorkflowNodeRunStatus = "pending" | "running" | "success" | "failed" | "skipped";

export type WorkflowNode = {
  id: string;
  type: WorkflowNodeType;
  position: { x: number; y: number };
  data: { label: string; config: Record<string, unknown> };
};

export type WorkflowEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

export type WorkflowDefinition = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  variables: Record<string, unknown>;
};

export type AgentRecord = {
  id: string;
  name: string;
  description: string;
  status: WorkflowStatus;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowRecord = {
  id: string;
  agentId: string;
  definition: WorkflowDefinition;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowNodeRun = {
  id: string;
  runId: string;
  nodeId: string;
  nodeType: WorkflowNodeType;
  status: WorkflowNodeRunStatus;
  input: unknown;
  output: unknown;
  error: string | null;
  durationMs: number;
  startedAt: string | null;
  finishedAt: string | null;
};

export type WorkflowRun = {
  id: string;
  agentId: string;
  workflowVersion: number;
  status: WorkflowRunStatus;
  input: unknown;
  output: unknown;
  error: string | null;
  durationMs: number;
  startedAt: string;
  finishedAt: string | null;
  nodeRuns: WorkflowNodeRun[];
};

export const initialWorkflow = (): WorkflowDefinition => ({
  nodes: [
    { id: "start", type: "start", position: { x: 120, y: 240 }, data: { label: "开始", config: {} } },
    { id: "end", type: "end", position: { x: 520, y: 240 }, data: { label: "结束", config: { output: "{{start.output}}" } } },
  ],
  edges: [{ id: "start-end", source: "start", target: "end" }],
  variables: {},
});
