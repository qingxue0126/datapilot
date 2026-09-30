"use client";

import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Background,
  ConnectionMode,
  Controls,
  Handle,
  MiniMap,
  MarkerType,
  Position,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
  useUpdateNodeInternals,
} from "@xyflow/react";
import type { ModelOption } from "./model-management";
import { customerFacingRunError, extractConversationInput, hasRunInputValue, missingConversationPrompt } from "./conversation-input";
import { AgentWorkflowIcon } from "./icons";
import { buildWorkflowVariableGroups, insertVariableAt, variableExpression, type WorkflowVariableGroup } from "./workflow-variables";
import { apiUrl, resolveApiBase } from "./api-base";

const api = (path: string, init: RequestInit = {}) => fetch(apiUrl(path), { ...init, credentials: "include" });

async function readJson(response: Response) {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error(`智能体服务未返回 JSON；请确认 API 已运行在 ${resolveApiBase()}。`);
  }
  return response.json();
}

type NodeKind = "start" | "llm" | "agent" | "knowledge_retrieval" | "sql" | "http" | "code" | "condition" | "assign" | "end";
type NodeState = "pending" | "running" | "success" | "failed" | "skipped";
type AgentPermission = "private" | "tenant";
type AgentItem = { id: string; name: string; description: string; status: "draft" | "published" | "disabled"; permission: AgentPermission; currentVersion: number; createdAt: string; updatedAt: string };
type NodeData = { label: string; nodeType: NodeKind; config: Record<string, unknown>; runStatus?: NodeState; modelName?: string; connectedTools?: string[] };
type FlowNode = Node<NodeData>;
type WorkflowDefinition = { nodes: { id: string; type: NodeKind; position: { x: number; y: number }; data: { label: string; config: Record<string, unknown> } }[]; edges: Edge[]; variables: Record<string, unknown> };
type NodeRun = { nodeId: string; nodeType?: NodeKind; status: NodeState; input: unknown; output: unknown; error: string | null; durationMs: number };
type WorkflowRun = { id: string; workflowVersion?: number; status: "pending" | "running" | "success" | "failed"; input?: unknown; output: unknown; error: string | null; durationMs: number; startedAt?: string; finishedAt?: string | null; nodeRuns: NodeRun[] };
type WorkflowVersion = { id: string; agentId: string; version: number; definition: WorkflowDefinition; status: "published"; createdAt: string };
type ManagePanel = "versions" | "logs" | "settings";
type DataSourceOption = { connectionId: string; name: string };
type KnowledgeBaseOption = { id: string; name: string; documentCount?: number; chunkCount?: number };
type ChatMessage = { id: string; role: "assistant" | "user"; content: string };
type StartMode = "conversation" | "task" | "webhook";
type StartInputType = "string" | "number" | "boolean" | "object";
type StartInput = { key: string; name: string; type: StartInputType; required: boolean; options?: string[] };
type ConditionRule = { id: string; left: unknown; operator: string; right: unknown };
type ConditionGroup = { id: string; combinator: "and" | "or"; items: (ConditionRule | ConditionGroup)[] };
type ConditionBranch = { id: string; label: string; condition: ConditionGroup };

function MessageNodeIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 3h13a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-2l-3 3-4-4H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z" fill="currentColor"/><path d="M6 8h11M6 12h7" stroke="white" strokeWidth="2" strokeLinecap="round"/></svg>;
}

function LlmBrainIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M10.5 3.5A4 4 0 0 0 6.7 7a3.5 3.5 0 0 0-1.2 6.5A4 4 0 0 0 8 19.8V21a2 2 0 0 0 2 2h.5c1.4 0 2.5-1.1 2.5-2.5V6a2.5 2.5 0 0 0-2.5-2.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M7 8.5c.8 0 1.5.3 2 .9M6.4 14.5c1-.1 1.9.2 2.5.9M10 19.8c.8-.2 1.5-.7 2-1.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M13 7h4l1.5-1.5M13 12h6M13 17h4l1.5 1.5" stroke="#12bfae" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="20" cy="4" r="1.5" fill="#12bfae" /><circle cx="21" cy="12" r="1.5" fill="#12bfae" /><circle cx="20" cy="20" r="1.5" fill="#12bfae" />
  </svg>;
}

function ConditionBranchIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 21V10.5M12 10.5 5 3.5M5 3.5v5M5 3.5h5M12 10.5l7-7M19 3.5v5M19 3.5h-5" />
  </svg>;
}

function KnowledgeCylinderIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" />
  </svg>;
}

function PaletteChevronIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 8 7 7 7-7" /></svg>;
}

function CodeTerminalIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2.5" y="4" width="19" height="16" rx="2" />
    <path d="m7 9 3 3-3 3M13 16h4" />
  </svg>;
}

const nodeCatalog: { type: NodeKind; label: string; description: string; icon: ReactNode }[] = [
  { type: "start", label: "消息输入", description: "接收用户消息", icon: <MessageNodeIcon /> },
  { type: "llm", label: "LLM", description: "调用已启用模型", icon: <LlmBrainIcon /> },
  { type: "agent", label: "Agent", description: "自主推理并调用工具", icon: <AgentWorkflowIcon /> },
  { type: "knowledge_retrieval", label: "知识库检索", description: "向量或混合检索知识块", icon: <KnowledgeCylinderIcon /> },
  { type: "sql", label: "SQL 查询", description: "执行只读安全查询", icon: "▦" },
  { type: "http", label: "HTTP 请求", description: "调用外部 API", icon: "↗" },
  { type: "code", label: "代码", description: "安全执行 JavaScript", icon: <CodeTerminalIcon /> },
  { type: "condition", label: "条件分支", description: "IF / ELSEIF / ELSE 多分支", icon: <ConditionBranchIcon /> },
  { type: "assign", label: "变量赋值", description: "生成结构化变量", icon: "=" },
  { type: "end", label: "消息输出", description: "返回回复消息", icon: <MessageNodeIcon /> },
];
const inputOutputNodes = nodeCatalog.filter((item) => item.type === "start" || item.type === "end");
const aiNodes = nodeCatalog.filter((item) => ["llm", "agent", "knowledge_retrieval"].includes(item.type));
const toolNodes = nodeCatalog.filter((item) => ["sql", "http", "code", "assign"].includes(item.type));
const logicNodes = nodeCatalog.filter((item) => item.type === "condition");

const flowNodeTypes = Object.fromEntries(nodeCatalog.map((item) => [item.type, WorkflowNodeCard]));

export function AgentStudio({ models }: { models: ModelOption[] }) {
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [active, setActive] = useState<AgentItem | null>(null);
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [variables, setVariables] = useState<Record<string, unknown>>({});
  const [selectedId, setSelectedId] = useState("");
  const [sources, setSources] = useState<DataSourceOption[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseOption[]>([]);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [runnerOpen, setRunnerOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [dialog, setDialog] = useState<{ mode: "create" | "edit" | "delete"; agent?: AgentItem } | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [managePanel, setManagePanel] = useState<ManagePanel | null>(null);
  const [versions, setVersions] = useState<WorkflowVersion[]>([]);
  const [historyRuns, setHistoryRuns] = useState<WorkflowRun[]>([]);
  const [historyRun, setHistoryRun] = useState<WorkflowRun | null>(null);
  const [instance, setInstance] = useState<ReactFlowInstance<FlowNode, Edge> | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { void loadAgents(); }, []);

  async function loadAgents() {
    setLoading(true);
    try {
      const response = await api("/api/agents"); const data = await readJson(response);
      if (!response.ok) throw new Error(data.error || "无法读取智能体");
      setAgents(data.items || []);
    } catch (error) { setNotice(message(error)); }
    finally { setLoading(false); }
  }

  async function openAgent(agent: AgentItem) {
    setNotice(""); setRun(null); setSelectedId(""); setRunnerOpen(false);
    const [detailResponse, sourcesResponse, knowledgeResponse] = await Promise.all([api(`/api/agents/${agent.id}`), api("/api/connections"), api("/api/knowledge-bases")]);
    const detail = await readJson(detailResponse); const sourceData = await readJson(sourcesResponse); const knowledgeData = await readJson(knowledgeResponse);
    if (!detailResponse.ok) throw new Error(detail.error || "无法加载工作流");
    const definition = detail.workflow.definition as WorkflowDefinition;
    const flowNodes = definition.nodes.map((node) => ({ ...node, data: { ...node.data, label: node.type === "start" && node.data.label === "开始" ? "消息输入" : node.type === "end" && node.data.label === "结束" ? "消息输出" : node.data.label, nodeType: node.type } })) as FlowNode[];
    setActive(detail.agent); setVariables(definition.variables || {});
    setNodes(flowNodes);
    setEdges((definition.edges || []).map((edge) => ({ ...edge, animated: false, markerEnd: { type: MarkerType.ArrowClosed, color: "#43866a" } }))); setSources(sourceData.items || []); setKnowledgeBases(knowledgeData.items || []);
  }

  function currentDefinition(): WorkflowDefinition {
    return {
      nodes: nodes.map((node) => ({ id: node.id, type: node.data.nodeType, position: node.position, data: { label: node.data.label, config: node.data.config } })),
      edges: edges.map(({ id, source, target, sourceHandle, targetHandle }) => ({ id, source, target, sourceHandle, targetHandle })),
      variables,
    };
  }

  async function save(quiet = false) {
    if (!active) return false;
    setSaving(true); setNotice("");
    try {
      const definition = currentDefinition();
      const response = await api(`/api/agents/${active.id}/workflow`, { method: "PUT", headers: jsonHeaders, body: JSON.stringify({ definition }) });
      const data = await readJson(response); if (!response.ok) throw new Error(data.error || "保存失败");
      const next = { ...active, status: "draft" as const, updatedAt: data.workflow.updatedAt };
      setActive(next); setAgents((items) => items.map((item) => item.id === next.id ? next : item)); if (!quiet) setNotice("工作流草稿已保存");
      return true;
    } catch (error) { setNotice(message(error)); return false; }
    finally { setSaving(false); }
  }

  async function publish(permission: AgentPermission) {
    if (!active || !(await save(true))) return;
    try {
      const response = await api(`/api/agents/${active.id}/publish`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ enabled: true, permission }) });
      const data = await readJson(response); if (!response.ok) throw new Error(data.error || "发布失败");
      setActive(data.agent); setAgents((items) => items.map((item) => item.id === data.agent.id ? data.agent : item)); setPublishOpen(false);
      setNotice(`已发布版本 v${data.version.version}`);
    } catch (error) { setNotice(message(error)); }
  }

  async function openManage(panel: ManagePanel) {
    if (!active) return;
    setManageOpen(false); setManagePanel(panel); setHistoryRun(null);
    try {
      if (panel === "versions") {
        const response = await api(`/api/agents/${active.id}/versions`); const data = await readJson(response);
        if (!response.ok) throw new Error(data.error || "无法读取历史版本"); setVersions(data.items || []);
      } else if (panel === "logs") {
        const response = await api(`/api/agents/${active.id}/runs`); const data = await readJson(response);
        if (!response.ok) throw new Error(data.error || "无法读取运行日志"); setHistoryRuns(data.items || []);
      }
    } catch (error) { setNotice(message(error)); }
  }

  async function restoreVersion(version: number) {
    if (!active) return;
    try {
      const response = await api(`/api/agents/${active.id}/versions/${version}/restore`, { method: "POST" }); const data = await readJson(response);
      if (!response.ok) throw new Error(data.error || "版本回退失败");
      const definition = data.workflow.definition as WorkflowDefinition;
      setNodes(definition.nodes.map((node) => ({ ...node, data: { ...node.data, nodeType: node.type } })) as FlowNode[]); setEdges(definition.edges || []); setVariables(definition.variables || {}); setActive(data.agent);
      setManagePanel(null); setNotice(`已将 v${version} 恢复为当前草稿，请确认后重新发布`);
    } catch (error) { setNotice(message(error)); }
  }

  async function showRunDetail(id: string) {
    try { const response = await api(`/api/workflow-runs/${id}`); const data = await readJson(response); if (!response.ok) throw new Error(data.error || "无法读取日志详情"); setHistoryRun(data.run); }
    catch (error) { setNotice(message(error)); }
  }

  async function exportAgent() {
    if (!active) return;
    try {
      const response = await api(`/api/agents/${active.id}/export`); if (!response.ok) { const data = await readJson(response); throw new Error(data.error || "导出失败"); }
      const url = URL.createObjectURL(await response.blob()); const link = document.createElement("a"); link.href = url; link.download = `${safeFileName(active.name)}.json`; link.click(); URL.revokeObjectURL(url); setManageOpen(false); setNotice("智能体 JSON 已导出");
    } catch (error) { setNotice(message(error)); }
  }

  async function runWorkflow(input: Record<string, unknown>): Promise<WorkflowRun | null> {
    if (!active) return null;
    const missingFields = requiredRunInputFields(nodes).filter((path) => {
      const value = inputPath(input, path);
      return value === undefined || value === null || (typeof value === "string" && !value.trim());
    });
    if (missingFields.length) {
      setNotice(`请在右侧运行面板补充字段：${missingFields.join("、")}`);
      return null;
    }
    setRunning(true); setNotice(""); setRun(null);
    setNodes((items) => items.map((node) => ({ ...node, data: { ...node.data, runStatus: "pending" } })));
    try {
      const response = await api(`/api/agents/${active.id}/run`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ input }) });
      const data = await readJson(response); if (!response.ok) throw new Error(data.error || "运行失败");
      let completed = data.run as WorkflowRun;
      for (let attempt = 0; attempt < 400 && completed.status === "running"; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 300));
        const poll = await api(`/api/workflow-runs/${completed.id}`); const pollData = await readJson(poll);
        if (!poll.ok) throw new Error(pollData.error || "无法读取运行状态");
        completed = pollData.run as WorkflowRun; setRun(completed);
        const liveStates = new Map(completed.nodeRuns.map((item) => [item.nodeId, item.status]));
        setNodes((items) => items.map((node) => ({ ...node, data: { ...node.data, runStatus: liveStates.get(node.id) || "pending" } })));
      }
      if (completed.status === "running") throw new Error("工作流运行超时");
      setRun(completed);
      const states = new Map(completed.nodeRuns.map((item) => [item.nodeId, item.status]));
      setNodes((items) => items.map((node) => ({ ...node, data: { ...node.data, runStatus: states.get(node.id) } })));
      setNotice(completed.status === "success" ? `运行成功 · ${completed.durationMs} ms` : "运行未成功，请查看执行日志");
      return completed;
    } catch (error) { setNotice(message(error)); }
    finally { setRunning(false); }
    return null;
  }

  async function mutateAgent(path: string, init: RequestInit) {
    const response = await api(path, init); const data = response.status === 204 ? {} : await readJson(response);
    if (!response.ok) throw new Error(data.error || "操作失败");
    await loadAgents(); return data;
  }

  async function importRagflow(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setNotice("JSON 文件不能超过 2 MB"); return; }
    setImporting(true); setNotice("");
    try {
      const definition = JSON.parse(await file.text());
      const defaultModelId = models.find((item) => item.enabled && ["llm", "multimodal_llm"].includes(item.modelType))?.id || "";
      const response = await api("/api/agents/import", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          name: file.name.replace(/\.json$/i, "") || "RAGFlow 智能体",
          description: `从 RAGFlow 文件 ${file.name} 导入`,
          definition,
          defaultModelId,
        }),
      });
      const data = await readJson(response);
      if (!response.ok) throw new Error(data.error || "导入失败");
      await loadAgents();
      await openAgent(data.agent as AgentItem);
      const unsupported = Number(data.report?.unsupported?.length || 0);
      const warnings = Number(data.report?.warnings?.length || 0);
      setNotice(`导入完成：${data.report?.importedNodes || 0} 个节点、${data.report?.importedEdges || 0} 条连线${unsupported ? `；${unsupported} 个兼容节点需要重新配置` : ""}${warnings ? `；${warnings} 条提示` : ""}`);
    } catch (error) {
      setNotice(error instanceof SyntaxError ? "JSON 文件格式无效，请选择 RAGFlow 导出的完整 JSON 文件" : message(error));
    } finally { setImporting(false); }
  }

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => setNodes((items) => applyNodeChanges(changes, items)), []);
  const onEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => setEdges((items) => applyEdgeChanges(changes, items)), []);
  const onConnect = useCallback((connection: Connection) => {
    if (connection.targetHandle === "tools") {
      const source = nodes.find((node) => node.id === connection.source);
      const target = nodes.find((node) => node.id === connection.target);
      if (source?.data.nodeType !== "knowledge_retrieval" || target?.data.nodeType !== "agent") {
        setNotice("Agent 工具列表目前仅支持连接知识库检索节点");
        return;
      }
    }
    setEdges((items) => items.some((edge) => edge.source === connection.source && edge.target === connection.target && edge.targetHandle === connection.targetHandle)
      ? items
      : addEdge({ ...connection, id: crypto.randomUUID(), animated: false, markerEnd: { type: MarkerType.ArrowClosed, color: "#43866a" } }, items));
  }, [nodes]);
  const selected = nodes.find((node) => node.id === selectedId);
  const selectedRun = run?.nodeRuns.find((item) => item.nodeId === selectedId);
  const canvasNodes = nodes.map((node) => node.data.nodeType !== "agent" ? node : {
    ...node,
    data: {
      ...node.data,
      modelName: models.find((model) => model.id === String(node.data.config.modelId || ""))?.name || "未选择模型",
      connectedTools: edges
        .filter((edge) => edge.target === node.id && edge.targetHandle === "tools")
        .map((edge) => nodes.find((item) => item.id === edge.source)?.data.label || edge.source),
    },
  });
  const canvasEdges = edges.map((edge) => ({
    ...edge,
    animated: false,
    markerEnd: { type: MarkerType.ArrowClosed, color: "#43866a" },
  }));

  function updateNode(patch: Partial<NodeData>) {
    setNodes((items) => items.map((node) => node.id === selectedId ? { ...node, data: { ...node.data, ...patch } } : node));
  }
  function updateConfig(key: string, value: unknown) {
    if (!selected) return;
    if (key === "branches" && Array.isArray(value)) {
      const validHandles = new Set(["false", ...value.map((branch) => String((branch as { id?: unknown })?.id || ""))]);
      setEdges((items) => items.filter((edge) => edge.source !== selected.id || !edge.sourceHandle || validHandles.has(edge.sourceHandle)));
    }
    updateNode({ config: { ...selected.data.config, [key]: value } });
  }
  function drop(event: DragEvent) {
    event.preventDefault(); if (!instance) return;
    const kind = event.dataTransfer.getData("application/datapilot-node") as NodeKind;
    const catalog = nodeCatalog.find((item) => item.type === kind); if (!catalog) return;
    const position = instance.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const id = `${kind}-${crypto.randomUUID().slice(0, 8)}`;
    const node = { id, type: kind, position, data: { label: catalog.label, nodeType: kind, config: defaultConfig(kind, models, sources) } } as FlowNode;
    const next = [...nodes, node];
    setNodes(next);
    setSelectedId(id);
  }

  if (active) return <div className="agent-editor-page">
    <header className="agent-editor-header">
      <div><button onClick={() => { setActive(null); setRun(null); void loadAgents(); }}>← 智能体列表</button><h2>{active.name}</h2><span className={`agent-status ${active.status}`}>{statusLabel(active.status)}</span><small>v{active.currentVersion}</small></div>
      <div className="agent-editor-actions"><button onClick={() => setRunnerOpen(true)} disabled={running}>{running ? "运行中…" : "▶ 运行"}</button><span className="agent-manage-wrap"><button className="agent-manage-trigger" onClick={() => setManageOpen((open) => !open)}><PaletteChevronIcon />管理</button>{manageOpen && <menu className="agent-manage-menu"><button onClick={() => void openManage("versions")}>历史版本</button><button onClick={() => void openManage("logs")}>日志</button><button onClick={() => void exportAgent()}>导出</button><button onClick={() => void openManage("settings")}>设置</button></menu>}</span><button className="save-action" onClick={() => void save()} disabled={saving || running}>{saving ? "保存中…" : "保存"}</button><button className="primary-action" onClick={() => setPublishOpen(true)}>发布</button></div>
    </header>
    {notice && <div className={`agent-notice ${run?.status === "failed" ? "error" : ""}`}>{notice}</div>}
    <div className="agent-builder">
      <aside className="agent-node-palette"><h3>节点</h3><p>拖入画布构建流程</p><details className="agent-palette-group" open><summary><span>输入/输出</span><i><PaletteChevronIcon /></i></summary><div>{inputOutputNodes.map((item) => <PaletteNode key={item.type} item={item} />)}</div></details><details className="agent-palette-group" open><summary><span>AI</span><i><PaletteChevronIcon /></i></summary><div>{aiNodes.map((item) => <PaletteNode key={item.type} item={item} />)}</div></details><details className="agent-palette-group" open><summary><span>工具</span><i><PaletteChevronIcon /></i></summary><div>{toolNodes.map((item) => <PaletteNode key={item.type} item={item} />)}</div></details><details className="agent-palette-group" open><summary><span>逻辑</span><i><PaletteChevronIcon /></i></summary><div>{logicNodes.map((item) => <PaletteNode key={item.type} item={item} />)}</div></details></aside>
      <section className="agent-canvas" ref={canvasRef} onDrop={drop} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}>
        <ReactFlow<FlowNode, Edge> nodes={canvasNodes} edges={canvasEdges} nodeTypes={flowNodeTypes} connectionMode={ConnectionMode.Loose} defaultEdgeOptions={{ animated: false, markerEnd: { type: MarkerType.ArrowClosed, color: "#43866a" } }} onInit={setInstance} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeDoubleClick={(_event, node) => setSelectedId(node.id)} onPaneClick={() => setSelectedId("")} connectionRadius={36} fitView deleteKeyCode={["Backspace", "Delete"]}>
          <Background color="#aeb3bc" gap={32} size={1.4} /><MiniMap nodeColor="#2d8163" maskColor="rgba(247,248,249,.76)" /><Controls />
        </ReactFlow>
      </section>
      <aside className="agent-config-panel">
        {selected ? <NodeConfiguration agentId={active.id} node={selected} nodes={nodes} edges={edges} models={models} sources={sources} knowledgeBases={knowledgeBases} updateLabel={(value) => updateNode({ label: value })} updateConfig={updateConfig} close={() => setSelectedId("")} run={selectedRun} /> : <><h3>工作流配置</h3><p>双击画布节点查看配置、输入输出与错误。</p><label>全局变量（JSON）<textarea value={pretty(variables)} onChange={(event) => { const parsed = tryJson(event.target.value); if (parsed) setVariables(parsed); }} rows={8} /></label>{run && <RunSummary run={run} />}</>}
      </aside>
    </div>
    {runnerOpen && <WorkflowRunner nodes={nodes} run={run} running={running} close={() => setRunnerOpen(false)} execute={runWorkflow} />}
    {publishOpen && <PublishDialog agent={active} close={() => setPublishOpen(false)} submit={publish} />}
    {managePanel === "versions" && <VersionPanel versions={versions} close={() => setManagePanel(null)} restore={restoreVersion} />}
    {managePanel === "logs" && <RunHistoryPanel runs={historyRuns} selected={historyRun} close={() => setManagePanel(null)} select={showRunDetail} />}
    {managePanel === "settings" && <AgentSettingsDialog agent={active} close={() => setManagePanel(null)} submit={async (values) => { try { const response = await api(`/api/agents/${active.id}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(values) }); const data = await readJson(response); if (!response.ok) throw new Error(data.error || "设置保存失败"); setActive(data.agent); setAgents((items) => items.map((item) => item.id === data.agent.id ? data.agent : item)); setManagePanel(null); setNotice("智能体设置已保存"); } catch (error) { setNotice(message(error)); } }} />}
  </div>;

  return <div className="module-content agent-list-page">
    <div className="module-heading"><div><span className="eyebrow">AGENT WORKFLOW</span><h2>智能体</h2><p>用可视化工作流连接模型、数据和业务动作。</p></div><div className="module-heading-actions"><button onClick={() => importInputRef.current?.click()} disabled={importing}>{importing ? "导入中…" : "导入 JSON 文件"}</button><button className="primary-action" onClick={() => setDialog({ mode: "create" })}>＋ 新建智能体</button></div></div>
    <input ref={importInputRef} type="file" accept=".json,application/json" hidden onChange={(event) => void importRagflow(event)} />
    {notice && <div className="agent-notice">{notice}</div>}
    {loading ? <div className="empty-state"><p>正在加载智能体…</p></div> : agents.length === 0 ? <div className="empty-state agent-empty"><span>◇</span><h3>创建第一个智能体</h3><p>从消息输入节点出发，拖入 LLM、SQL、HTTP 或代码节点。</p><button onClick={() => setDialog({ mode: "create" })}>新建智能体</button></div> : <div className="agent-grid">{agents.map((agent) => <article className="agent-card" key={agent.id} onClick={() => void openAgent(agent).catch((error) => setNotice(message(error)))}><div className="agent-card-icon">◇</div><div><div className="agent-card-title"><h3>{agent.name}</h3><span className={`agent-status ${agent.status}`}>{statusLabel(agent.status)}</span></div><p>{agent.description || "暂无描述"}</p><small>v{agent.currentVersion} · 更新于 {formatDate(agent.updatedAt)}</small></div><footer><button onClick={(event) => { event.stopPropagation(); setDialog({ mode: "edit", agent }); }}>编辑</button><button onClick={(event) => { event.stopPropagation(); void mutateAgent(`/api/agents/${agent.id}/copy`, { method: "POST" }).catch((error) => setNotice(message(error))); }}>复制</button><button onClick={(event) => { event.stopPropagation(); void mutateAgent(`/api/agents/${agent.id}/publish`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ enabled: agent.status !== "published" }) }).catch((error) => setNotice(message(error))); }}>{agent.status === "published" ? "停用" : "发布"}</button><button className="danger" onClick={(event) => { event.stopPropagation(); setDialog({ mode: "delete", agent }); }}>删除</button></footer></article>)}</div>}
    {dialog && <AgentDialog dialog={dialog} close={() => setDialog(null)} submit={async (values) => { try { if (dialog.mode === "create") await mutateAgent("/api/agents", { method: "POST", headers: jsonHeaders, body: JSON.stringify(values) }); else if (dialog.mode === "edit" && dialog.agent) await mutateAgent(`/api/agents/${dialog.agent.id}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(values) }); else if (dialog.agent) await mutateAgent(`/api/agents/${dialog.agent.id}`, { method: "DELETE" }); setDialog(null); } catch (error) { setNotice(message(error)); } }} />}
  </div>;
}

function PaletteNode({ item }: { item: (typeof nodeCatalog)[number] }) {
  return <div className="agent-palette-item" draggable onDragStart={(event) => { event.dataTransfer.setData("application/datapilot-node", item.type); event.dataTransfer.effectAllowed = "move"; }}><span>{item.icon}</span><div><strong>{item.label}</strong><small>{item.description}</small></div></div>;
}

function WorkflowNodeCard({ id, data, selected }: NodeProps<FlowNode>) {
  const condition = data.nodeType === "condition";
  const conditionBranches = condition ? normalizeConditionBranches(data.config) : [];
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { if (condition) updateNodeInternals(id); }, [condition, conditionBranches.map((branch) => branch.id).join("|"), id, updateNodeInternals]);
  const subtitle = data.nodeType === "start" ? startModeLabel(normalizeStartMode(data.config.mode)) : nodeCatalog.find((item) => item.type === data.nodeType)?.label || data.nodeType;
  if (data.nodeType === "agent") return <div className={`workflow-node workflow-agent-node ${selected ? "selected" : ""} ${data.runStatus || ""}`}>
    <header><span className="workflow-node-icon"><AgentWorkflowIcon /></span><div><strong>{data.label}</strong><small>Agent</small></div>{data.runStatus && <i title={data.runStatus} />}</header>
    <div className="workflow-agent-field"><span>推理模型</span><b>{data.modelName || "未选择模型"}</b></div>
    <div className="workflow-agent-field"><span>系统提示词</span><p>{String(data.config.systemPrompt || "未配置系统提示词")}</p></div>
    <div className="workflow-agent-tools">
      <Handle id="tools" type="target" position={Position.Left} isConnectableStart={false} isConnectableEnd />
      <span>工具列表</span>
      {data.connectedTools?.length ? <ul>{data.connectedTools.map((tool, index) => <li key={`${tool}-${index}`}>{tool}</li>)}</ul> : <small>从知识库检索节点连接到这里</small>}
    </div>
    <div className="workflow-agent-field workflow-agent-input"><Handle id="input" type="target" position={Position.Left} isConnectableStart={false} isConnectableEnd /><span>用户输入</span><p>{String(data.config.input || "{{start.output.query}}")}</p></div>
    <div className="workflow-agent-meta"><span>最大迭代 {Number(data.config.maxIterations ?? 5)}</span><span>流式输出 {data.config.streaming === false ? "关闭" : "开启"}</span></div>
    <footer className="workflow-agent-output"><span>消息输出</span><Handle id="output" type="source" position={Position.Right} isConnectableStart isConnectableEnd={false} /></footer>
  </div>;
  return <div className={`workflow-node ${data.nodeType} ${selected ? "selected" : ""} ${data.runStatus || ""}`}>
    {data.nodeType !== "start" && <Handle type="target" position={Position.Left} />}
    <span className="workflow-node-icon">{nodeCatalog.find((item) => item.type === data.nodeType)?.icon}</span><div><strong>{data.label}</strong><small>{subtitle}</small></div>{data.runStatus && <i title={data.runStatus} />}
    {data.nodeType !== "end" && !condition && <Handle type="source" position={Position.Right} />}
    {condition && (conditionBranches.length ? <div className="condition-handles">{[...conditionBranches.map((branch) => ({ id: branch.id, label: branch.label })), { id: "false", label: "ELSE" }].map((branch, index, all) => <span key={branch.id} style={{ top: `${((index + 1) / (all.length + 1)) * 100}%` }}><em>{branch.label}</em><Handle id={branch.id} type="source" position={Position.Right} /></span>)}</div> : <><Handle id="true" type="source" position={Position.Right} style={{ top: "34%" }} /><Handle id="false" type="source" position={Position.Right} style={{ top: "72%" }} /><em className="condition-true">T</em><em className="condition-false">F</em></>)}
  </div>;
}

function NodeConfiguration({ agentId, node, nodes, edges, models, sources, knowledgeBases, updateLabel, updateConfig, close, run }: { agentId: string; node: FlowNode; nodes: FlowNode[]; edges: Edge[]; models: ModelOption[]; sources: DataSourceOption[]; knowledgeBases: KnowledgeBaseOption[]; updateLabel: (value: string) => void; updateConfig: (key: string, value: unknown) => void; close: () => void; run?: NodeRun }) {
  const config = node.data.config;
  const variableGroups = buildWorkflowVariableGroups(nodes, edges, node.id);
  return <><div className="agent-config-title"><div><small>{node.data.nodeType}</small><h3>{node.data.label}</h3></div><button type="button" className="agent-config-close" aria-label="关闭设置" title="关闭设置" onClick={close}>×</button></div><label>节点名称<input value={node.data.label} onChange={(event) => updateLabel(event.target.value)} /></label>
    {node.data.nodeType === "start" && <StartConfiguration agentId={agentId} config={config} updateConfig={updateConfig} />}
    {node.data.nodeType === "llm" && <><label>模型<select value={String(config.modelId || "")} onChange={(event) => updateConfig("modelId", event.target.value)}><option value="">选择模型</option>{models.filter((item) => item.enabled && ['llm', 'multimodal_llm'].includes(item.modelType)).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><VariableTextField label="System Prompt" rows={5} value={String(config.systemPrompt || "")} update={(value) => updateConfig("systemPrompt", value)} groups={variableGroups} /><VariableTextField label="User Prompt" rows={7} value={String(config.userPrompt || "")} update={(value) => updateConfig("userPrompt", value)} groups={variableGroups} /></>}
    {node.data.nodeType === "agent" && <AgentConfiguration config={config} models={models} knowledgeBases={knowledgeBases} updateConfig={updateConfig} variableGroups={variableGroups} />}
    {node.data.nodeType === "knowledge_retrieval" && <KnowledgeRetrievalConfiguration nodeId={node.id} config={config} models={models} updateConfig={updateConfig} variableGroups={variableGroups} />}
    {node.data.nodeType === "sql" && <><label>数据源<select value={String(config.datasourceId || "")} onChange={(event) => updateConfig("datasourceId", event.target.value)}><option value="">选择数据源</option>{sources.map((item) => <option value={item.connectionId} key={item.connectionId}>{item.name}</option>)}</select></label><VariableTextField label="SQL 模板" rows={8} value={String(config.sql || "")} update={(value) => updateConfig("sql", value)} groups={variableGroups} placeholder="SELECT ... WHERE id = {{start.output.id}}" /></>}
    {node.data.nodeType === "http" && <><label>方法<select value={String(config.method || "GET")} onChange={(event) => updateConfig("method", event.target.value)}>{['GET','POST','PUT','DELETE'].map((item) => <option key={item}>{item}</option>)}</select></label><VariableTextField label="URL" value={String(config.url || "")} update={(value) => updateConfig("url", value)} groups={variableGroups} /><JsonField key={`${node.id}-headers`} label="Headers" value={config.headers} update={(value) => updateConfig("headers", value)} groups={variableGroups} /><JsonField key={`${node.id}-query`} label="Query" value={config.query} update={(value) => updateConfig("query", value)} groups={variableGroups} /><JsonField key={`${node.id}-body`} label="Body" value={config.body} update={(value) => updateConfig("body", value)} groups={variableGroups} /></>}
    {node.data.nodeType === "code" && <CodeInputConfiguration value={config.input} update={(value) => updateConfig("input", value)} groups={variableGroups} />}
    {node.data.nodeType === "code" && <><label>JavaScript<textarea className="code-input" rows={10} value={String(config.code || "")} onChange={(event) => updateConfig("code", event.target.value)} /></label><p className="field-help">使用 input.参数名 读取表单输入，必须 return JSON；不可访问文件、命令或模块。</p></>}
    {node.data.nodeType === "condition" && <ConditionConfiguration config={config} updateConfig={updateConfig} variableGroups={variableGroups} />}
    {node.data.nodeType === "assign" && <JsonField key={`${node.id}-assignments`} label="赋值对象（高级模式）" value={config.assignments} update={(value) => updateConfig("assignments", value)} groups={variableGroups} />}
    {node.data.nodeType === "end" && <VariableTextField label="返回值" value={String(config.output || "")} update={(value) => updateConfig("output", value)} groups={variableGroups} placeholder="{{nodeId.output}}" />}
    {run && <section className={`node-run-detail ${run.status}`}><h4>执行结果</h4><div><span>状态</span><strong>{run.status}</strong><span>Duration</span><strong>{run.durationMs} ms</strong></div><details open><summary>Input</summary><pre>{pretty(run.input)}</pre></details><details open><summary>Output</summary><pre>{pretty(run.output)}</pre></details>{run.error && <details open><summary>Error</summary><pre>{run.error}</pre></details>}</section>}
  </>;
}

const conditionOperators = ["==", "!=", ">", ">=", "<", "<=", "contains", "not_contains", "is_empty", "is_not_empty"];

function ConditionConfiguration({ config, updateConfig, variableGroups }: { config: Record<string, unknown>; updateConfig: (key: string, value: unknown) => void; variableGroups: WorkflowVariableGroup[] }) {
  const branches = editableConditionBranches(config);
  const save = (next: ConditionBranch[]) => updateConfig("branches", next);
  const updateBranch = (index: number, next: ConditionBranch) => save(branches.map((branch, itemIndex) => itemIndex === index ? next : branch));
  return <div className="condition-settings">
    <p className="field-help">按 IF / ELSEIF 顺序匹配，命中第一个分支后停止；ELSE 处理未命中的情况。条件组可嵌套。</p>
    {branches.map((branch, index) => <section className="condition-branch-card" key={branch.id}>
      <header><div><strong>{index === 0 ? "IF" : "ELSEIF"}</strong><input aria-label="分支名称" value={branch.label} onChange={(event) => updateBranch(index, { ...branch, label: event.target.value })} /></div>{index > 0 && <button type="button" onClick={() => save(branches.filter((_item, itemIndex) => itemIndex !== index))}>移除</button>}</header>
      <ConditionGroupEditor group={branch.condition} depth={0} onChange={(condition) => updateBranch(index, { ...branch, condition })} variableGroups={variableGroups} />
    </section>)}
    <button className="condition-add-branch" type="button" onClick={() => save([...branches, newConditionBranch(branches.length)])}>＋ 添加 ELSEIF</button>
    <section className="condition-else-card"><strong>ELSE</strong><span>其他所有情况</span></section>
    <p className="field-help">每个分支在节点右侧都有独立连接点；可继续连接另一个条件节点形成流程嵌套。</p>
  </div>;
}

function ConditionGroupEditor({ group, depth, onChange, variableGroups, removable, remove }: { group: ConditionGroup; depth: number; onChange: (group: ConditionGroup) => void; variableGroups: WorkflowVariableGroup[]; removable?: boolean; remove?: () => void }) {
  const updateItem = (index: number, item: ConditionRule | ConditionGroup) => onChange({ ...group, items: group.items.map((current, itemIndex) => itemIndex === index ? item : current) });
  const removeItem = (index: number) => onChange({ ...group, items: group.items.filter((_item, itemIndex) => itemIndex !== index) });
  return <div className={`condition-group depth-${Math.min(depth, 3)}`}>
    <header><select aria-label="条件关系" value={group.combinator} onChange={(event) => onChange({ ...group, combinator: event.target.value === "or" ? "or" : "and" })}><option value="and">满足全部 AND</option><option value="or">满足任一 OR</option></select>{removable && <button type="button" onClick={remove}>删除组</button>}</header>
    <div className="condition-group-items">{group.items.map((item, index) => isConditionGroup(item)
      ? <ConditionGroupEditor key={item.id} group={item} depth={depth + 1} onChange={(next) => updateItem(index, next)} variableGroups={variableGroups} removable remove={() => removeItem(index)} />
      : <div className="condition-rule" key={item.id}><VariableTextControl ariaLabel="左值" value={String(item.left ?? "")} update={(value) => updateItem(index, { ...item, left: value })} groups={variableGroups} placeholder="选择变量" /><select aria-label="运算符" value={item.operator} onChange={(event) => updateItem(index, { ...item, operator: event.target.value })}>{conditionOperators.map((operator) => <option value={operator} key={operator}>{conditionOperatorLabel(operator)}</option>)}</select>{!["is_empty", "is_not_empty"].includes(item.operator) && <VariableTextControl ariaLabel="右值" value={String(item.right ?? "")} update={(value) => updateItem(index, { ...item, right: value })} groups={variableGroups} placeholder="比较值或变量" />}<button type="button" aria-label="删除条件" onClick={() => removeItem(index)}>×</button></div>)}</div>
    <footer><button type="button" onClick={() => onChange({ ...group, items: [...group.items, newConditionRule()] })}>＋ 条件</button>{depth < 4 && <button type="button" onClick={() => onChange({ ...group, items: [...group.items, newConditionGroup()] })}>＋ 嵌套组</button>}</footer>
  </div>;
}

function normalizeConditionBranches(config: Record<string, unknown>): ConditionBranch[] {
  if (!Array.isArray(config.branches)) return [];
  return config.branches.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const branch = raw as Record<string, unknown>;
    return [{ id: String(branch.id || `case-${index + 1}`), label: String(branch.label || `Case ${index + 1}`), condition: normalizeConditionGroup(branch.condition, `group-${index + 1}`) }];
  });
}
function editableConditionBranches(config: Record<string, unknown>) {
  const branches = normalizeConditionBranches(config);
  if (branches.length) return branches;
  return [{ id: "true", label: "Case 1", condition: { id: "legacy-group", combinator: "and", items: [{ id: "legacy-rule", left: config.left ?? "", operator: String(config.operator || "=="), right: config.right ?? "" }] } } satisfies ConditionBranch];
}
function normalizeConditionGroup(raw: unknown, fallbackId: string): ConditionGroup {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const items = Array.isArray(value.items) ? value.items.flatMap((item, index): (ConditionRule | ConditionGroup)[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as Record<string, unknown>;
    if (Array.isArray(candidate.items)) return [normalizeConditionGroup(candidate, `${fallbackId}-group-${index}`)];
    return [{ id: String(candidate.id || `${fallbackId}-rule-${index}`), left: candidate.left ?? "", operator: String(candidate.operator || "=="), right: candidate.right ?? "" }];
  }) : [];
  return { id: String(value.id || fallbackId), combinator: value.combinator === "or" ? "or" : "and", items };
}
function newConditionBranch(index: number): ConditionBranch { return { id: conditionId("case"), label: `Case ${index + 1}`, condition: newConditionGroup() }; }
function newConditionGroup(): ConditionGroup { return { id: conditionId("group"), combinator: "and", items: [newConditionRule()] }; }
function newConditionRule(): ConditionRule { return { id: conditionId("rule"), left: "", operator: "==", right: "" }; }
function conditionId(prefix: string) { return `${prefix}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`; }
function isConditionGroup(item: ConditionRule | ConditionGroup): item is ConditionGroup { return "items" in item; }
function conditionOperatorLabel(operator: string) { return ({ contains: "包含", not_contains: "不包含", is_empty: "为空", is_not_empty: "不为空" } as Record<string, string>)[operator] || operator; }

type AgentToolConfig = { id: string; type: "knowledge_retrieval"; name: string; description: string; knowledgeBaseId: string; filters: Record<string, unknown>; dynamicFilters: boolean; retrievalMode: "vector" | "hybrid"; topK: number; scoreThreshold: number; rerank: boolean; rerankModel: string; rerankTopK: number; vectorWeight: number; candidateCount: number };

function AgentConfiguration({ config, models, knowledgeBases, updateConfig, variableGroups }: { config: Record<string, unknown>; models: ModelOption[]; knowledgeBases: KnowledgeBaseOption[]; updateConfig: (key: string, value: unknown) => void; variableGroups: WorkflowVariableGroup[] }) {
  const llms = models.filter((item) => item.enabled && ["llm", "multimodal_llm"].includes(item.modelType));
  const selectedModel = llms.find((item) => item.id === String(config.modelId || ""));
  const tools = normalizeAgentToolConfigs(config.tools);
  const updateTool = (index: number, patch: Partial<AgentToolConfig>) => updateConfig("tools", tools.map((tool, itemIndex) => itemIndex === index ? { ...tool, ...patch } : tool));
  const addTool = () => updateConfig("tools", [...tools, { id: crypto.randomUUID(), type: "knowledge_retrieval", name: `knowledge_search_${tools.length + 1}`, description: "检索与当前问题相关的知识", knowledgeBaseId: knowledgeBases[0]?.id || "", filters: {}, dynamicFilters: true, retrievalMode: "vector", topK: 5, scoreThreshold: 0.2, rerank: false, rerankModel: "", rerankTopK: 5, vectorWeight: 0.7, candidateCount: 15 } satisfies AgentToolConfig]);
  return <div className="agent-node-settings">
    <section className="agent-settings-section"><h4>输入</h4><VariableTextField label="用户输入（支持变量引用）" rows={3} value={String(config.input ?? "{{start.output.query}}")} update={(value) => updateConfig("input", value)} groups={variableGroups} placeholder="选择消息输入的 query" /><p className="field-help">默认读取消息输入节点的对话输入，可引用任意上游变量。</p></section>
    <section className="agent-settings-section"><h4>模型</h4><label>LLM<select value={String(config.modelId || "")} onChange={(event) => updateConfig("modelId", event.target.value)}><option value="">选择已配置的 LLM</option>{llms.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label></section>
    <section className="agent-settings-section"><h4>提示词</h4><VariableTextField label="系统提示词" rows={6} value={String(config.systemPrompt ?? "你是一个严谨、通用的 AI Agent。请遵守用户要求和工具使用边界。")} update={(value) => updateConfig("systemPrompt", value)} groups={variableGroups} placeholder="定义 Agent 角色、规则与行为边界" /><VariableTextField label="用户提示词" rows={5} value={String(config.userPrompt ?? "{{agent.input}}")} update={(value) => updateConfig("userPrompt", value)} groups={variableGroups} placeholder="选择上游变量" /><p className="field-help">用户提示词不是开场白；开场白由消息输入节点的对话模式配置。</p></section>
    <section className="agent-settings-section"><header><h4>Tools</h4><button type="button" onClick={addTool}>＋ 添加工具</button></header><p className="field-help">Agent 会根据对话自主决定是否调用工具及其 query、metadata filters 参数。</p>
      {tools.length === 0 ? <div className="start-input-empty">暂无工具。可添加知识库检索工具。</div> : <div className="agent-tool-list">{tools.map((tool, index) => <article className="agent-tool-card" key={tool.id}>
        <header><strong>{tool.name || `工具 ${index + 1}`}</strong><button type="button" onClick={() => updateConfig("tools", tools.filter((_item, itemIndex) => itemIndex !== index))}>删除</button></header>
        <label>工具名称<input value={tool.name} onChange={(event) => updateTool(index, { name: event.target.value })} placeholder="knowledge_search" /></label>
        <label>工具说明 / Query 指引<textarea rows={2} value={tool.description} onChange={(event) => updateTool(index, { description: event.target.value })} placeholder="说明何时使用该知识库以及如何组织 query" /></label>
        <label>知识库<select value={tool.knowledgeBaseId} onChange={(event) => updateTool(index, { knowledgeBaseId: event.target.value })}><option value="">选择已有知识库</option>{knowledgeBases.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
        <label>检索方式<select value={tool.retrievalMode} onChange={(event) => updateTool(index, { retrievalMode: event.target.value as AgentToolConfig["retrievalMode"] })}><option value="vector">向量检索</option><option value="hybrid">混合检索</option></select></label>
        {tool.retrievalMode === "hybrid" && <label>向量权重<input type="number" min="0" max="1" step="0.05" value={tool.vectorWeight} onChange={(event) => updateTool(index, { vectorWeight: Number(event.target.value) })} /></label>}
        <div className="start-input-row"><label>Top K<input type="number" min="1" max="50" value={tool.topK} onChange={(event) => updateTool(index, { topK: Number(event.target.value) })} /></label><label>Score Threshold<input type="number" min="-1" max="1" step="0.01" value={tool.scoreThreshold} onChange={(event) => updateTool(index, { scoreThreshold: Number(event.target.value) })} /></label></div>
        <JsonField key={`${tool.id}-agent-filters`} label="固定 Metadata Filters" value={tool.filters} update={(value) => updateTool(index, { filters: value })} groups={variableGroups} />
        <label className="agent-switch-row"><span>允许 Agent 动态生成 Metadata Filters</span><input type="checkbox" checked={tool.dynamicFilters} onChange={(event) => updateTool(index, { dynamicFilters: event.target.checked })} /></label>
        <label className="agent-switch-row"><span>重排</span><input type="checkbox" checked={tool.rerank} onChange={(event) => updateTool(index, { rerank: event.target.checked })} /></label>
        {tool.rerank && <><label>重排模型<select value={tool.rerankModel} onChange={(event) => updateTool(index, { rerankModel: event.target.value })}><option value="">本地关键词重排</option>{models.filter((item) => item.enabled && ["rerank", "multimodal_rerank"].includes(item.modelType)).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>重排 Top K<input type="number" min="1" max="50" value={tool.rerankTopK} onChange={(event) => updateTool(index, { rerankTopK: Number(event.target.value) })} /></label></>}
      </article>)}</div>}
    </section>
    <section className="agent-settings-section"><h4>运行设置</h4><div className="start-input-row"><label>最大迭代次数<input type="number" min="1" max="20" value={Number(config.maxIterations ?? 5)} onChange={(event) => updateConfig("maxIterations", Number(event.target.value))} /></label><label>响应超时 (ms)<input type="number" min="1000" max="600000" step="1000" value={Number(config.timeoutMs ?? 30000)} onChange={(event) => updateConfig("timeoutMs", Number(event.target.value))} /></label></div>
      <label className="agent-switch-row"><span>流式输出</span><input type="checkbox" checked={config.streaming !== false} onChange={(event) => updateConfig("streaming", event.target.checked)} /></label>
      <label className="agent-switch-row"><span>上下文 / Memory</span><input type="checkbox" checked={config.memory !== false} onChange={(event) => updateConfig("memory", event.target.checked)} /></label>
      <p className="field-help">对话调试会携带多轮对话历史，并保留此前已采集的消息输入节点字段。</p>
      <details className="agent-advanced-settings"><summary>高级设置 · 模型参数</summary><label>Temperature<input type="number" min="0" max="2" step="0.1" value={Number(config.temperature ?? selectedModel?.temperature ?? 0.7)} onChange={(event) => updateConfig("temperature", Number(event.target.value))} /></label><p className="field-help">默认继承模型管理中的 Temperature。</p></details>
    </section>
    <p className="field-help">节点输出：<code>{"{{agent.output.text}}"}</code>；内部 LLM / Tool 调用参数、结果、耗时和异常会写入执行日志。</p>
  </div>;
}

function normalizeAgentToolConfigs(value: unknown): AgentToolConfig[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const raw = item as Record<string, unknown>;
    return [{ id: String(raw.id || `tool_${index + 1}`), type: "knowledge_retrieval", name: String(raw.name || `knowledge_search_${index + 1}`), description: String(raw.description || ""), knowledgeBaseId: String(raw.knowledgeBaseId || ""), filters: raw.filters && typeof raw.filters === "object" && !Array.isArray(raw.filters) ? raw.filters as Record<string, unknown> : {}, dynamicFilters: raw.dynamicFilters !== false, retrievalMode: raw.retrievalMode === "hybrid" ? "hybrid" : "vector", topK: Number(raw.topK ?? 5), scoreThreshold: Number(raw.scoreThreshold ?? 0.2), rerank: raw.rerank === true, rerankModel: String(raw.rerankModel || ""), rerankTopK: Number(raw.rerankTopK ?? raw.topK ?? 5), vectorWeight: Number(raw.vectorWeight ?? 0.7), candidateCount: Number(raw.candidateCount ?? Number(raw.topK ?? 5) * 3) }];
  });
}

function KnowledgeRetrievalConfiguration({ nodeId, config, models, updateConfig, variableGroups }: { nodeId: string; config: Record<string, unknown>; models: ModelOption[]; updateConfig: (key: string, value: unknown) => void; variableGroups: WorkflowVariableGroup[] }) {
  const hybrid = config.retrievalMode === "hybrid";
  const rerank = config.rerank === true;
  return <section className="knowledge-retrieval-configuration">
    <details className="agent-advanced-settings" open><summary>作为 Agent 工具</summary>
      <label>工具名称<input value={String(config.toolName || "knowledge_search")} onChange={(event) => updateConfig("toolName", event.target.value)} placeholder="knowledge_search" /></label>
      <label>工具说明<textarea rows={2} value={String(config.toolDescription || "检索与当前问题相关的知识")} onChange={(event) => updateConfig("toolDescription", event.target.value)} /></label>
      <label className="agent-switch-row"><span>允许 Agent 动态生成 Metadata Filters</span><input type="checkbox" checked={config.dynamicFilters !== false} onChange={(event) => updateConfig("dynamicFilters", event.target.checked)} /></label>
      <p className="field-help">将该节点右侧连接到 Agent 的“工具列表”接口后，Agent 会按需调用，不会把它当作普通前置检索节点执行。</p>
    </details>
    <label>知识库 ID<input value={String(config.knowledgeBaseId || "")} onChange={(event) => updateConfig("knowledgeBaseId", event.target.value)} /></label>
    <VariableTextField label="Query" rows={4} value={String(config.query || "")} update={(value) => updateConfig("query", value)} groups={variableGroups} placeholder="选择上游问题变量" />
    <label>检索方式<select value={String(config.retrievalMode || "vector")} onChange={(event) => updateConfig("retrievalMode", event.target.value)}><option value="vector">向量检索</option><option value="hybrid">混合检索</option></select></label>
    {hybrid && <label>向量权重<input type="number" min="0" max="1" step="0.05" value={Number(config.vectorWeight ?? 0.7)} onChange={(event) => updateConfig("vectorWeight", Number(event.target.value))} /></label>}
    <div className="start-input-row"><label>Top K<input type="number" min="1" max="50" value={Number(config.topK ?? 5)} onChange={(event) => updateConfig("topK", Number(event.target.value))} /></label><label>Score Threshold<input type="number" min="-1" max="1" step="0.01" value={Number(config.scoreThreshold ?? 0.2)} onChange={(event) => updateConfig("scoreThreshold", Number(event.target.value))} /></label></div>
    <JsonField key={`${nodeId}-filters`} label="Metadata Filters" value={config.filters} update={(value) => updateConfig("filters", value)} groups={variableGroups} />
    <label className="agent-switch-row"><span>重排</span><input type="checkbox" checked={rerank} onChange={(event) => updateConfig("rerank", event.target.checked)} /></label>
    {rerank && <><label>重排模型<select value={String(config.rerankModel || "")} onChange={(event) => updateConfig("rerankModel", event.target.value)}><option value="">本地关键词重排</option>{models.filter((item) => item.enabled && ['rerank', 'multimodal_rerank'].includes(item.modelType)).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>重排 Top K<input type="number" min="1" max="50" value={Number(config.rerankTopK ?? config.topK ?? 5)} onChange={(event) => updateConfig("rerankTopK", Number(event.target.value))} /></label></>}
    <p className="field-help">输出 items、topScore、hitCount；items 保留完整文本、分数、元数据和来源信息。</p>
  </section>;
}

function StartConfiguration({ agentId, config, updateConfig }: { agentId: string; config: Record<string, unknown>; updateConfig: (key: string, value: unknown) => void }) {
  const [copied, setCopied] = useState(false);
  const mode = normalizeStartMode(config.mode);
  const inputs = normalizeStartInputs(config.inputs);
  const webhookUrl = `${resolveApiBase()}/api/v1/agents/${agentId}/webhook`;
  const updateInput = (index: number, patch: Partial<StartInput>) => updateConfig("inputs", inputs.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  const addInput = () => {
    let suffix = inputs.length + 1;
    while (inputs.some((item) => item.key === `input_${suffix}`)) suffix += 1;
    updateConfig("inputs", [...inputs, { key: `input_${suffix}`, name: `输入 ${suffix}`, type: "string", required: true } satisfies StartInput]);
  };
  return <section className="start-configuration">
    <label>模式
      <select value={mode} onChange={(event) => updateConfig("mode", event.target.value)}>
        <option value="conversation">对话</option><option value="task">任务</option><option value="webhook">网络钩子</option>
      </select>
    </label>
    {mode === "conversation" && <>
      <label className="agent-switch-row"><span>开场白开关</span><input type="checkbox" checked={config.enablePrologue !== false} onChange={(event) => updateConfig("enablePrologue", event.target.checked)} /></label>
      {config.enablePrologue !== false && <label>开场白文案<textarea rows={6} value={String(config.prologue || "")} onChange={(event) => updateConfig("prologue", event.target.value)} placeholder="您好，请描述您遇到的问题。" /></label>}
    </>}
    {mode !== "webhook" && <StartInputs inputs={inputs} add={addInput} update={updateInput} remove={(index) => updateConfig("inputs", inputs.filter((_item, itemIndex) => itemIndex !== index))} />}
    {mode === "webhook" && <div className="start-webhook-settings">
      <label>Webhook URL<div className="agent-copy-field"><input readOnly value={webhookUrl} /><button type="button" onClick={() => void navigator.clipboard.writeText(webhookUrl).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })}>{copied ? "已复制" : "复制"}</button></div></label>
      <label>方法<select value={String(config.webhookMethod || "GET")} onChange={(event) => updateConfig("webhookMethod", event.target.value)}>{["GET", "POST", "PUT", "DELETE"].map((method) => <option key={method}>{method}</option>)}</select></label>
      <details><summary>Security</summary><label>鉴权方式<select value={String(config.webhookSecurity || "none")} onChange={(event) => updateConfig("webhookSecurity", event.target.value)}><option value="none">无</option><option value="bearer">Bearer Token</option></select></label>{config.webhookSecurity === "bearer" && <label>Token<input type="password" value={String(config.webhookToken || "")} onChange={(event) => updateConfig("webhookToken", event.target.value)} /></label>}</details>
      <details><summary>模式</summary><label>输入位置<select value={String(config.webhookRequestMode || "json")} onChange={(event) => updateConfig("webhookRequestMode", event.target.value)}><option value="json">JSON Body</option><option value="query">Query 参数</option></select></label></details>
      <details><summary>Response</summary><label>响应内容<select value={String(config.webhookResponseMode || "workflow")} onChange={(event) => updateConfig("webhookResponseMode", event.target.value)}><option value="workflow">工作流最终输出</option><option value="json">完整运行 JSON</option></select></label></details>
      <p className="field-help">地址、方法、鉴权和响应配置会随工作流保存；对外调用入口为后续发布能力预留。</p>
    </div>}
  </section>;
}

function StartInputs({ inputs, add, update, remove }: { inputs: StartInput[]; add: () => void; update: (index: number, patch: Partial<StartInput>) => void; remove: (index: number) => void }) {
  return <section className="start-inputs"><header><div><strong>输入</strong><small>定义顶部“运行输入”的字段</small></div><button type="button" onClick={add} title="新增输入">＋</button></header>
    {inputs.length === 0 ? <div className="start-input-empty">暂无输入，点击＋添加</div> : <div className="start-input-list">{inputs.map((item, index) => <article key={`${item.key}-${index}`}>
      <div className="start-input-row"><label>键<input value={item.key} onChange={(event) => update(index, { key: event.target.value.trim() })} placeholder="query" /></label><label>名称<input value={item.name} onChange={(event) => update(index, { name: event.target.value })} placeholder="用户问题" /></label></div>
      <div className="start-input-row"><label>类型<select value={item.type} onChange={(event) => update(index, { type: event.target.value as StartInputType })}>{["string", "number", "boolean", "object"].map((type) => <option key={type}>{type}</option>)}</select></label><label className="start-input-required">可选项<span><input type="checkbox" checked={!item.required} onChange={(event) => update(index, { required: !event.target.checked })} /> 可选</span></label></div>
      <div className="start-input-actions"><button type="button" onClick={() => remove(index)}>删除</button></div>
    </article>)}</div>}
  </section>;
}

function WorkflowRunner({ nodes, run, running, close, execute }: { nodes: FlowNode[]; run: WorkflowRun | null; running: boolean; close: () => void; execute: (input: Record<string, unknown>) => Promise<WorkflowRun | null> }) {
  const start = nodes.find((node) => node.id === "start" && node.data.nodeType === "start") || nodes.find((node) => node.data.nodeType === "start");
  const config = start?.data.config || {};
  const mode = normalizeStartMode(config.mode);
  const inputs = Array.from(nodes.filter((node) => node.data.nodeType === "start").flatMap((node) => normalizeStartInputs(node.data.config.inputs)).reduce((fields, field) => {
    const existing = fields.get(field.key);
    fields.set(field.key, existing ? { ...existing, required: existing.required || field.required } : field);
    return fields;
  }, new Map<string, StartInput>()).values());
  const initialValues = createRunInputTemplate(nodes);
  const [taskValues, setTaskValues] = useState<Record<string, unknown>>(initialValues);
  const [conversationValues, setConversationValues] = useState<Record<string, unknown>>(initialValues);
  const [messageText, setMessageText] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>(() => config.enablePrologue !== false && String(config.prologue || "").trim() ? [{ id: "prologue", role: "assistant", content: String(config.prologue) }] : []);

  const submitConversation = async () => {
    const query = messageText.trim(); if (!query || running) return;
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content: query };
    setMessages((items) => [...items, userMessage]); setMessageText("");
    const nextInput = extractConversationInput(query, inputs, conversationValues);
    setConversationValues(nextInput);
    const missing = inputs.filter((input) => input.required && !hasRunInputValue(nextInput, input.key));
    if (missing.length) {
      setMessages((items) => [...items, { id: crypto.randomUUID(), role: "assistant", content: missingConversationPrompt(missing) }]);
      return;
    }
    const history = messages.filter((item) => item.id !== "prologue").map(({ role, content }) => ({ role, content }));
    const result = await execute({ ...nextInput, __conversationHistory: history });
    const reply = result ? customerFacingRunReply(result, nodes) : customerFacingRunError(null);
    setMessages((items) => [...items, { id: crypto.randomUUID(), role: "assistant", content: reply }]);
  };
  const submitTask = async () => { if (!running) await execute(taskValues); };

  return <aside className={`agent-runner-shell ${mode}`} aria-label="工作流运行调试">
    <section className="agent-run-log"><header><div><strong>执行日志</strong><small>{run ? `${run.status} · ${run.durationMs} ms` : "运行后可查看各节点输入与输出"}</small></div></header>
      <div className="agent-run-log-list">{run?.nodeRuns.length ? run.nodeRuns.map((nodeRun) => <details key={nodeRun.nodeId} open={nodeRun.status === "failed"}><summary><span className={`run-dot ${nodeRun.status}`} />{nodeLabel(nodes, nodeRun.nodeId)}<small>{nodeRun.durationMs} ms</small></summary><div><strong>Input</strong><pre>{pretty(nodeRun.input)}</pre><strong>Output</strong><pre>{pretty(nodeRun.output)}</pre>{nodeRun.error && <><strong>Error</strong><pre className="error">{nodeRun.error}</pre></>}</div></details>) : <div className="runner-empty">尚未运行工作流</div>}</div>
    </section>
    <section className="agent-run-surface"><header><div><strong>{mode === "conversation" ? "对话调试" : mode === "task" ? "任务运行" : "网络钩子"}</strong><small>{startModeLabel(mode)}模式</small></div><button type="button" onClick={close} aria-label="关闭运行面板">×</button></header>
      {mode === "conversation" && <><div className="agent-chat-messages">{messages.length ? messages.map((item) => <article className={item.role} key={item.id}><span>{item.role === "assistant" ? "DP" : "我"}</span><p>{item.content}</p></article>) : <div className="runner-empty">输入消息开始调试</div>}{running && <article className="assistant pending"><span>DP</span><p>{streamingAgentText(run, nodes) || "工作流运行中…"}</p></article>}</div><div className="agent-chat-composer"><textarea rows={3} value={messageText} onChange={(event) => setMessageText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submitConversation(); } }} placeholder="请输入消息…" /><button type="button" disabled={!messageText.trim() || running} onClick={() => void submitConversation()}>发送</button></div></>}
      {mode === "task" && <div className="agent-task-runner"><p>填写消息输入节点定义的输入，然后运行工作流。</p>{inputs.length ? inputs.map((input) => <label key={input.key}>{input.name || input.key}{input.required && <em>*</em>}{input.type === "boolean" ? <select value={String(inputPath(taskValues, input.key) ?? false)} onChange={(event) => setNestedInput(setTaskValues, input.key, event.target.value === "true")}><option value="false">false</option><option value="true">true</option></select> : input.options?.length ? <select value={String(inputPath(taskValues, input.key) ?? "")} onChange={(event) => setNestedInput(setTaskValues, input.key, event.target.value)}><option value="">请选择</option>{input.options.map((option) => <option key={option}>{option}</option>)}</select> : <input type={input.type === "number" ? "number" : "text"} value={String(inputPath(taskValues, input.key) ?? "")} onChange={(event) => setNestedInput(setTaskValues, input.key, input.type === "number" ? Number(event.target.value) : event.target.value)} />}</label>) : <div className="runner-empty">消息输入节点尚未配置输入字段</div>}<button className="runner-primary" type="button" onClick={() => void submitTask()} disabled={running}>{running ? "运行中…" : "运行任务"}</button>{run && <div className={`agent-task-result ${run.status}`}><strong>运行结果</strong><pre>{pretty(run.status === "success" ? run.output : "运行未成功，请查看执行日志")}</pre></div>}</div>}
      {mode === "webhook" && <div className="agent-webhook-runner"><p>网络钩子模式通过消息输入节点中配置的 URL 接收请求，请先保存并发布智能体。</p><code>{String(config.webhookMethod || "GET")} /api/v1/agents/&lt;agent-id&gt;/webhook</code><div className="runner-empty">当前面板不模拟外部网络钩子请求</div></div>}
    </section>
  </aside>;
}

function readableRunOutput(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["text", "content", "answer", "formalized_content"]) if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  }
  return "";
}
function customerFacingRunReply(run: WorkflowRun, nodes: FlowNode[]) {
  if (run.status !== "success") return customerFacingRunError(run.error);
  const finalText = readableRunOutput(run.output);
  if (finalText) return finalText;
  const agentText = [...run.nodeRuns].reverse().find((item) => {
    if (item.status !== "success" || nodes.find((node) => node.id === item.nodeId)?.data.nodeType !== "agent") return false;
    return Boolean(readableRunOutput(item.output));
  });
  return agentText ? readableRunOutput(agentText.output) : "抱歉，我暂时没有获取到有效的处理结果。您可以换一种方式描述问题，我再帮您看看。";
}
function streamingAgentText(run: WorkflowRun | null, nodes: FlowNode[]) {
  if (!run) return "";
  const active = [...run.nodeRuns].reverse().find((item) => item.status === "running" && nodes.find((node) => node.id === item.nodeId)?.data.nodeType === "agent");
  const output = active?.output;
  return output && typeof output === "object" && typeof (output as Record<string, unknown>).text === "string" ? String((output as Record<string, unknown>).text) : "";
}
function nodeLabel(nodes: FlowNode[], id: string) { return nodes.find((node) => node.id === id)?.data.label || id; }
function setObjectPath(target: Record<string, unknown>, path: string, value: unknown) { const parts = path.split("."); let current = target; for (const part of parts.slice(0, -1)) { if (!current[part] || typeof current[part] !== "object" || Array.isArray(current[part])) current[part] = {}; current = current[part] as Record<string, unknown>; } current[parts.at(-1)!] = value; }
function setNestedInput(setter: (value: (current: Record<string, unknown>) => Record<string, unknown>) => void, path: string, value: unknown) {
  setter((current) => { const next = structuredClone(current); setObjectPath(next, path, value); return next; });
}

function PermissionField({ value, change }: { value: AgentPermission; change: (value: AgentPermission) => void }) {
  return <fieldset className="agent-permission"><legend>访问权限</legend><label><input type="radio" checked={value === "private"} onChange={() => change("private")} /><span><strong>仅自己</strong><small>只有创建者可以查看和运行</small></span></label><label><input type="radio" checked={value === "tenant"} onChange={() => change("tenant")} /><span><strong>当前团队</strong><small>发布后，同一租户和账套成员可使用</small></span></label></fieldset>;
}

function PublishDialog({ agent, close, submit }: { agent: AgentItem; close: () => void; submit: (permission: AgentPermission) => Promise<void> }) {
  const [permission, setPermission] = useState<AgentPermission>(agent.permission || "private");
  return <div className="modal-backdrop"><div className="agent-dialog"><h2>确认发布</h2><p>发布后会生成一个不可变的新版本。后续保存仍是草稿，只有再次发布才会形成新版本。</p><PermissionField value={permission} change={setPermission} /><footer><button onClick={close}>取消</button><button className="primary-action" onClick={() => void submit(permission)}>确认发布</button></footer></div></div>;
}

function AgentSettingsDialog({ agent, close, submit }: { agent: AgentItem; close: () => void; submit: (values: { name: string; description: string; permission: AgentPermission }) => Promise<void> }) {
  const [permission, setPermission] = useState<AgentPermission>(agent.permission || "private");
  return <div className="modal-backdrop"><form className="agent-dialog" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void submit({ name: String(form.get("name") || ""), description: String(form.get("description") || ""), permission }); }}><h2>智能体设置</h2><label>名称<input name="name" defaultValue={agent.name} required /></label><label>描述<textarea name="description" defaultValue={agent.description} rows={4} /></label><PermissionField value={permission} change={setPermission} /><footer><button type="button" onClick={close}>取消</button><button className="primary-action" type="submit">保存设置</button></footer></form></div>;
}

function VersionPanel({ versions, close, restore }: { versions: WorkflowVersion[]; close: () => void; restore: (version: number) => Promise<void> }) {
  return <aside className="agent-manage-panel"><header><div><strong>历史版本</strong><small>仅发布操作生成版本</small></div><button onClick={close}>×</button></header><div className="agent-version-list">{versions.length ? versions.map((item) => <article key={item.id}><div><strong>v{item.version}</strong><span>已发布</span></div><small>{formatFullDate(item.createdAt)} · {item.definition.nodes.length} 个节点 · {item.definition.edges.length} 条连线</small><details><summary>查看版本内容</summary><pre>{pretty(item.definition)}</pre></details><button onClick={() => void restore(item.version)}>回退到此版本</button></article>) : <div className="runner-empty">尚无已发布版本</div>}</div></aside>;
}

function RunHistoryPanel({ runs, selected, close, select }: { runs: WorkflowRun[]; selected: WorkflowRun | null; close: () => void; select: (id: string) => Promise<void> }) {
  return <aside className="agent-manage-panel agent-history-panel"><header><div><strong>运行日志</strong><small>查看历史测试链路和节点输入输出</small></div><button onClick={close}>×</button></header><div className="agent-history-layout"><nav>{runs.length ? runs.map((item) => <button className={selected?.id === item.id ? "selected" : ""} key={item.id} onClick={() => void select(item.id)}><span className={`run-dot ${item.status}`} /><strong>{formatFullDate(item.startedAt || "")}</strong><small>{item.status} · {item.durationMs} ms · v{item.workflowVersion ?? 0}</small></button>) : <div className="runner-empty">尚无运行日志</div>}</nav><section>{selected ? <><div className="agent-log-summary"><strong>{selected.status}</strong><span>{selected.durationMs} ms</span></div><details open><summary>工作流输入 / 输出</summary><pre>{pretty({ input: selected.input, output: selected.output, error: selected.error })}</pre></details>{selected.nodeRuns.map((nodeRun, index) => <details key={`${nodeRun.nodeId}-${index}`} open={nodeRun.status === "failed"}><summary><span className={`run-dot ${nodeRun.status}`} />{nodeRun.nodeId}<small>{nodeRun.durationMs} ms</small></summary><pre>{pretty({ status: nodeRun.status, input: nodeRun.input, output: nodeRun.output, error: nodeRun.error })}</pre></details>)}</> : <div className="runner-empty">选择一条记录查看完整执行链路</div>}</section></div></aside>;
}

function VariablePicker({ groups, select }: { groups: WorkflowVariableGroup[]; select: (expression: string) => void }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, maxHeight: 330 });
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const closeOnExternalScroll = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(".variable-picker-menu")) return;
      close();
    };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", closeOnExternalScroll, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", closeOnExternalScroll, true);
    };
  }, [open]);
  const toggle = () => {
    if (open) { setOpen(false); return; }
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(300, window.innerWidth - 16);
      const spaceBelow = window.innerHeight - rect.bottom - 8;
      const maxHeight = Math.max(160, Math.min(360, spaceBelow >= 200 ? spaceBelow : rect.top - 8));
      const top = spaceBelow >= 200 ? rect.bottom + 6 : Math.max(8, rect.top - maxHeight - 6);
      const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
      setPosition({ top, left, maxHeight });
    }
    setOpen(true);
  };
  const menu = open && typeof document !== "undefined" ? createPortal(<span className="variable-picker-menu variable-picker-portal" style={position}>
    <strong>选择上游变量</strong>
    {groups.length ? groups.map((group) => <span className="variable-picker-group" key={group.nodeId}>
      <b><span>{group.nodeLabel}</span><small>{group.nodeId}</small></b>
      {group.fields.map((field) => <button type="button" key={field.path || "$output"} onClick={() => { select(variableExpression(group.nodeId, field.path)); setOpen(false); }}><span>{field.label}</span><em>{field.type}</em></button>)}
    </span>) : <span className="variable-picker-empty">当前节点没有可访问的上游变量</span>}
  </span>, document.body) : null;
  return <span className="variable-picker">
    <button ref={trigger} type="button" className="variable-picker-trigger" aria-label="选择变量" title="选择变量" aria-expanded={open} onClick={toggle}>(x)</button>
    {menu}
  </span>;
}

function VariableTextControl({ value, update, groups, placeholder, rows, ariaLabel }: { value: string; update: (value: string) => void; groups: WorkflowVariableGroup[]; placeholder?: string; rows?: number; ariaLabel?: string }) {
  const [selection, setSelection] = useState({ start: value.length, end: value.length });
  const insert = (expression: string) => {
    const next = insertVariableAt(value, expression, selection.start, selection.end);
    update(next);
    const cursor = selection.start + expression.length;
    setSelection({ start: cursor, end: cursor });
  };
  const selectionChanged = (event: React.SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const target = event.currentTarget;
    setSelection({ start: target.selectionStart ?? value.length, end: target.selectionEnd ?? value.length });
  };
  return <span className="variable-text-control">
    {rows ? <textarea aria-label={ariaLabel} rows={rows} value={value} placeholder={placeholder} onChange={(event) => update(event.target.value)} onSelect={selectionChanged} /> : <input aria-label={ariaLabel} value={value} placeholder={placeholder} onChange={(event) => update(event.target.value)} onSelect={selectionChanged} />}
    <VariablePicker groups={groups} select={insert} />
  </span>;
}

function VariableTextField({ label, value, update, groups, placeholder, rows }: { label: string; value: string; update: (value: string) => void; groups: WorkflowVariableGroup[]; placeholder?: string; rows?: number }) {
  return <label className="variable-text-field"><span>{label}</span><VariableTextControl value={value} update={update} groups={groups} placeholder={placeholder} rows={rows} ariaLabel={label} /></label>;
}

function CodeInputConfiguration({ value, update, groups }: { value: unknown; update: (value: unknown) => void; groups: WorkflowVariableGroup[] }) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const [advanced, setAdvanced] = useState(!record);
  const entries = Object.entries(record || {});
  const saveEntries = (next: [string, unknown][]) => update(Object.fromEntries(next.filter(([key]) => key.trim()).map(([key, item]) => [key.trim(), item])));
  const add = () => {
    let index = entries.length + 1;
    while (record?.[`param_${index}`] !== undefined) index += 1;
    saveEntries([...entries, [`param_${index}`, ""]]);
  };
  return <section className="code-input-configuration">
    <header><div><strong>输入参数</strong><small>代码中通过 input.参数名 使用</small></div><button type="button" onClick={() => setAdvanced((current) => !current)}>{advanced ? "表单模式" : "高级模式"}</button></header>
    {advanced ? <AdvancedValueField value={value} update={update} groups={groups} /> : <>
      <div className="code-parameter-list">{entries.map(([name, item], index) => <div className="code-parameter-row" key={`${name}-${index}`}>
        <input aria-label="参数名" value={name} placeholder="参数名" onChange={(event) => saveEntries(entries.map((entry, itemIndex) => itemIndex === index ? [event.target.value, entry[1]] : entry))} />
        <VariableTextControl ariaLabel={`${name} 的值`} value={typeof item === "string" ? item : pretty(item)} update={(next) => saveEntries(entries.map((entry, itemIndex) => itemIndex === index ? [entry[0], next] : entry))} groups={groups} placeholder="选择变量或输入值" />
        <button type="button" aria-label="删除参数" onClick={() => saveEntries(entries.filter((_entry, itemIndex) => itemIndex !== index))}>×</button>
      </div>)}</div>
      <button type="button" className="code-parameter-add" onClick={add}>＋ 添加参数</button>
    </>}
  </section>;
}

function AdvancedValueField({ value, update, groups }: { value: unknown; update: (value: unknown) => void; groups: WorkflowVariableGroup[] }) {
  const [text, setText] = useState(typeof value === "string" ? value : pretty(value ?? {}));
  const [selection, setSelection] = useState({ start: text.length, end: text.length });
  useEffect(() => setText(typeof value === "string" ? value : pretty(value ?? {})), [value]);
  const change = (next: string) => {
    setText(next);
    const parsed = tryJson(next);
    update(parsed ?? next);
  };
  return <label className="json-field">高级输入（JSON / 表达式）<span className="variable-text-control"><textarea rows={5} value={text} onChange={(event) => change(event.target.value)} onSelect={(event) => setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })} /><VariablePicker groups={groups} select={(expression) => change(insertVariableAt(text, expression, selection.start, selection.end))} /></span></label>;
}

function JsonField({ label, value, update, groups = [] }: { label: string; value: unknown; update: (value: Record<string, unknown>) => void; groups?: WorkflowVariableGroup[] }) {
  const [text, setText] = useState(pretty(value || {}));
  const [selection, setSelection] = useState({ start: text.length, end: text.length });
  useEffect(() => setText(pretty(value || {})), [value]);
  const change = (next: string) => {
    setText(next);
    const parsed = tryJson(next);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) update(parsed);
  };
  return <label className="json-field">{label}<span className="variable-text-control"><textarea rows={5} value={text} onChange={(event) => change(event.target.value)} onSelect={(event) => setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })} /><VariablePicker groups={groups} select={(expression) => change(insertVariableAt(text, JSON.stringify(expression), selection.start, selection.end))} /></span></label>;
}
function RunSummary({ run }: { run: WorkflowRun }) { return <section className={`agent-run-summary ${run.status}`}><h4>最近运行</h4><p>{run.status} · {run.durationMs} ms</p><pre>{pretty(run.output ?? run.error)}</pre></section>; }
function AgentDialog({ dialog, close, submit }: { dialog: { mode: "create" | "edit" | "delete"; agent?: AgentItem }; close: () => void; submit: (values: { name?: string; description?: string }) => Promise<void> }) { if (dialog.mode === "delete") return <div className="modal-backdrop"><div className="agent-dialog"><h2>删除智能体</h2><p>确认删除“{dialog.agent?.name}”及其工作流版本和运行记录？</p><footer><button onClick={close}>取消</button><button className="danger-confirm" onClick={() => void submit({})}>确认删除</button></footer></div></div>; return <div className="modal-backdrop"><form className="agent-dialog" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); void submit({ name: String(form.get("name") || ""), description: String(form.get("description") || "") }); }}><h2>{dialog.mode === "create" ? "新建智能体" : "编辑智能体"}</h2><label>名称<input name="name" defaultValue={dialog.agent?.name} required autoFocus /></label><label>描述<textarea name="description" defaultValue={dialog.agent?.description} rows={4} /></label><footer><button type="button" onClick={close}>取消</button><button className="primary-action" type="submit">保存</button></footer></form></div>; }

function defaultConfig(kind: NodeKind, models: ModelOption[], sources: DataSourceOption[]): Record<string, unknown> { if (kind === "start") return defaultStartConfig(); if (kind === "llm") return { modelId: models.find((item) => item.enabled && item.modelType === "llm")?.id || "", systemPrompt: "你是 DataPilot 智能体。", userPrompt: "{{start.output.query}}" }; if (kind === "agent") return { input: "{{start.output.query}}", modelId: models.find((item) => item.enabled && ["llm", "multimodal_llm"].includes(item.modelType))?.id || "", systemPrompt: "你是一个严谨、通用的 AI Agent。请遵守用户要求和工具使用边界。", userPrompt: "{{agent.input}}", tools: [], maxIterations: 5, timeoutMs: 30000, streaming: true, memory: true }; if (kind === "knowledge_retrieval") return { knowledgeBaseId: "", query: "{{start.output.query}}", toolName: "knowledge_search", toolDescription: "检索与当前问题相关的知识", dynamicFilters: true, retrievalMode: "vector", vectorWeight: 0.7, topK: 5, scoreThreshold: 0.2, filters: {}, rerank: false, rerankModel: "", rerankTopK: 5 }; if (kind === "sql") return { datasourceId: sources[0]?.connectionId || "", sql: "SELECT 1 AS value" }; if (kind === "http") return { method: "GET", url: "https://example.com", headers: {}, query: {}, body: {} }; if (kind === "code") return { input: { value: "{{start.output}}" }, code: "return { result: input };" }; if (kind === "condition") return { branches: [{ id: "true", label: "Case 1", condition: { id: conditionId("group"), combinator: "and", items: [{ id: conditionId("rule"), left: "{{start.output.value}}", operator: "==", right: "true" }] } }] }; if (kind === "assign") return { assignments: { value: "{{start.output.value}}" } }; if (kind === "end") return { output: "{{start.output}}" }; return {}; }
function defaultStartConfig() { return { mode: "conversation", enablePrologue: true, prologue: "您好，请描述您遇到的问题。", inputs: [] as StartInput[], webhookMethod: "GET", webhookSecurity: "none", webhookRequestMode: "json", webhookResponseMode: "workflow" }; }
function normalizeStartMode(value: unknown): StartMode { return value === "task" || value === "webhook" ? value : "conversation"; }
function startModeLabel(mode: StartMode) { return mode === "task" ? "任务" : mode === "webhook" ? "网络钩子" : "对话"; }
function normalizeStartInputs(value: unknown): StartInput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const input = item as Record<string, unknown>; const key = String(input.key || "").trim();
    if (!key) return [];
    const type = ["string", "number", "boolean", "object"].includes(String(input.type)) ? String(input.type) as StartInputType : "string";
    return [{ key, name: String(input.name || key), type, required: input.required !== false, options: Array.isArray(input.options) ? input.options.map(String) : undefined }];
  });
}
function requiredRunInputFields(nodes: FlowNode[]) {
  const fields = new Set<string>();
  for (const node of nodes) {
    if (node.data.nodeType === "start") for (const input of normalizeStartInputs(node.data.config.inputs)) if (input.required) fields.add(input.key);
    const text = JSON.stringify(node.data.config || {});
    for (const match of text.matchAll(/\{\{\s*(?:start\.output|input)\.([^}\s]+)\s*\}\}/g)) if (!match[1].endsWith("?")) fields.add(match[1]);
  }
  return [...fields].sort();
}
function createRunInputTemplate(nodes: FlowNode[], placeholder = "") {
  const result: Record<string, unknown> = {};
  const fields = new Set(requiredRunInputFields(nodes));
  for (const node of nodes) if (node.data.nodeType === "start") for (const input of normalizeStartInputs(node.data.config.inputs)) fields.add(input.key);
  for (const path of [...fields].sort()) {
    const parts = path.split(".");
    let target = result;
    for (const part of parts.slice(0, -1)) {
      if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part])) target[part] = {};
      target = target[part] as Record<string, unknown>;
    }
    target[parts.at(-1)!] = placeholder;
  }
  return result;
}
function inputPath(input: Record<string, unknown>, path: string) {
  let current: unknown = input;
  for (const part of path.split(".")) current = current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined;
  return current;
}
function tryJson(value: string): Record<string, unknown> | null { try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null; } catch { return null; } }
function pretty(value: unknown) { try { return JSON.stringify(value ?? null, null, 2); } catch { return String(value); } }
function statusLabel(status: AgentItem["status"]) { return status === "published" ? "已发布" : status === "disabled" ? "已停用" : "草稿"; }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatFullDate(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "未知时间" : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date); }
function safeFileName(value: string) { return value.replace(/[\\/:*?"<>|]/g, "-").trim() || "datapilot-agent"; }
function message(error: unknown) { return error instanceof Error ? error.message : "操作失败"; }
const jsonHeaders = { "Content-Type": "application/json" };
