"use client";

import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
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
} from "@xyflow/react";
import type { ModelOption } from "./model-management";

const LOCAL_API_BASE = "http://localhost:3001";

// A stale local environment can point an API request back to Vite (port 3000),
// which returns the app HTML rather than JSON. Keep the workflow editor bound
// to the Express API when it runs locally.
function resolveApiBase() {
  const configured = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (typeof window !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) {
    if (!configured || /localhost:3000|127\.0\.0\.1:3000/.test(configured)) return LOCAL_API_BASE;
  }
  return configured || LOCAL_API_BASE;
}

const api = (path: string, init: RequestInit = {}) => fetch(`${resolveApiBase()}${path}`, { ...init, credentials: "include" });

async function readJson(response: Response) {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("智能体服务未返回 JSON；请确认本地 API 已运行在 http://localhost:3001。");
  }
  return response.json();
}

type NodeKind = "start" | "llm" | "sql" | "http" | "code" | "condition" | "assign" | "end";
type NodeState = "pending" | "running" | "success" | "failed" | "skipped";
type AgentItem = { id: string; name: string; description: string; status: "draft" | "published" | "disabled"; currentVersion: number; createdAt: string; updatedAt: string };
type NodeData = { label: string; nodeType: NodeKind; config: Record<string, unknown>; runStatus?: NodeState };
type FlowNode = Node<NodeData>;
type WorkflowDefinition = { nodes: { id: string; type: NodeKind; position: { x: number; y: number }; data: { label: string; config: Record<string, unknown> } }[]; edges: Edge[]; variables: Record<string, unknown> };
type NodeRun = { nodeId: string; status: NodeState; input: unknown; output: unknown; error: string | null; durationMs: number };
type WorkflowRun = { id: string; status: "pending" | "running" | "success" | "failed"; output: unknown; error: string | null; durationMs: number; nodeRuns: NodeRun[] };
type DataSourceOption = { connectionId: string; name: string };

const nodeCatalog: { type: NodeKind; label: string; description: string; icon: string }[] = [
  { type: "start", label: "开始", description: "接收运行输入", icon: "▶" },
  { type: "llm", label: "LLM", description: "调用已启用模型", icon: "✦" },
  { type: "sql", label: "SQL 查询", description: "执行只读安全查询", icon: "▦" },
  { type: "http", label: "HTTP 请求", description: "调用外部 API", icon: "↗" },
  { type: "code", label: "代码", description: "安全执行 JavaScript", icon: "{}" },
  { type: "condition", label: "条件分支", description: "True / False 路由", icon: "◇" },
  { type: "assign", label: "变量赋值", description: "生成结构化变量", icon: "=" },
  { type: "end", label: "结束", description: "返回最终结果", icon: "■" },
];

const flowNodeTypes = Object.fromEntries(nodeCatalog.map((item) => [item.type, WorkflowNodeCard]));

export function AgentStudio({ models }: { models: ModelOption[] }) {
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [active, setActive] = useState<AgentItem | null>(null);
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [variables, setVariables] = useState<Record<string, unknown>>({});
  const [selectedId, setSelectedId] = useState("");
  const [sources, setSources] = useState<DataSourceOption[]>([]);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [runInput, setRunInput] = useState("{}");
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [dialog, setDialog] = useState<{ mode: "create" | "edit" | "delete"; agent?: AgentItem } | null>(null);
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
    setNotice(""); setRun(null); setSelectedId("");
    const [detailResponse, sourcesResponse] = await Promise.all([api(`/api/agents/${agent.id}`), api("/api/connections")]);
    const detail = await readJson(detailResponse); const sourceData = await readJson(sourcesResponse);
    if (!detailResponse.ok) throw new Error(detail.error || "无法加载工作流");
    const definition = detail.workflow.definition as WorkflowDefinition;
    const flowNodes = definition.nodes.map((node) => ({ ...node, data: { ...node.data, nodeType: node.type } })) as FlowNode[];
    setActive(detail.agent); setVariables(definition.variables || {});
    setNodes(flowNodes);
    setRunInput(pretty(createRunInputTemplate(flowNodes)));
    setEdges(definition.edges || []); setSources(sourceData.items || []);
  }

  async function save() {
    if (!active) return;
    setSaving(true); setNotice("");
    try {
      const definition: WorkflowDefinition = {
        nodes: nodes.map((node) => ({ id: node.id, type: node.data.nodeType, position: node.position, data: { label: node.data.label, config: node.data.config } })),
        edges: edges.map(({ id, source, target, sourceHandle, targetHandle }) => ({ id, source, target, sourceHandle, targetHandle })),
        variables,
      };
      const response = await api(`/api/agents/${active.id}/workflow`, { method: "PUT", headers: jsonHeaders, body: JSON.stringify({ definition }) });
      const data = await readJson(response); if (!response.ok) throw new Error(data.error || "保存失败");
      const next = { ...active, status: "draft" as const, currentVersion: data.workflow.version, updatedAt: data.workflow.updatedAt };
      setActive(next); setAgents((items) => items.map((item) => item.id === next.id ? next : item)); setNotice("工作流草稿已保存");
    } catch (error) { setNotice(message(error)); }
    finally { setSaving(false); }
  }

  async function runWorkflow() {
    if (!active) return;
    let input: Record<string, unknown>;
    try { input = JSON.parse(runInput); if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(); }
    catch { setNotice("运行输入必须是 JSON 对象"); return; }
    const missingFields = requiredRunInputFields(nodes).filter((path) => {
      const value = inputPath(input, path);
      return value === undefined || value === null || (typeof value === "string" && !value.trim());
    });
    if (missingFields.length) {
      setNotice(`请在运行输入中填写：${missingFields.join("、")}，例如 ${JSON.stringify(createRunInputTemplate(nodes, "用户问题"))}`);
      return;
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
      setNotice(completed.status === "success" ? `运行成功 · ${completed.durationMs} ms` : completed.error || "运行失败");
    } catch (error) { setNotice(message(error)); }
    finally { setRunning(false); }
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
  const onConnect = useCallback((connection: Connection) => setEdges((items) => addEdge({ ...connection, id: crypto.randomUUID(), animated: true }, items)), []);
  const selected = nodes.find((node) => node.id === selectedId);
  const selectedRun = run?.nodeRuns.find((item) => item.nodeId === selectedId);

  function updateNode(patch: Partial<NodeData>) {
    setNodes((items) => items.map((node) => node.id === selectedId ? { ...node, data: { ...node.data, ...patch } } : node));
  }
  function updateConfig(key: string, value: unknown) { if (selected) updateNode({ config: { ...selected.data.config, [key]: value } }); }
  function drop(event: DragEvent) {
    event.preventDefault(); if (!instance) return;
    const kind = event.dataTransfer.getData("application/datapilot-node") as NodeKind;
    const catalog = nodeCatalog.find((item) => item.type === kind); if (!catalog) return;
    if ((kind === "start" || kind === "end") && nodes.some((node) => node.data.nodeType === kind)) { setNotice(`${catalog.label}节点已存在`); return; }
    const position = instance.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const id = `${kind}-${crypto.randomUUID().slice(0, 8)}`;
    const node = { id, type: kind, position, data: { label: catalog.label, nodeType: kind, config: defaultConfig(kind, models, sources) } } as FlowNode;
    const next = [...nodes, node];
    setNodes(next);
    if (requiredRunInputFields(nodes).length === 0 && requiredRunInputFields(next).length > 0) setRunInput(pretty(createRunInputTemplate(next)));
    setSelectedId(id);
  }

  if (active) return <div className="agent-editor-page">
    <header className="agent-editor-header">
      <div><button onClick={() => { setActive(null); setRun(null); void loadAgents(); }}>← 智能体列表</button><h2>{active.name}</h2><span className={`agent-status ${active.status}`}>{statusLabel(active.status)}</span><small>v{active.currentVersion}</small></div>
      <div className="agent-run-input"><span>运行输入</span><input value={runInput} onChange={(event) => setRunInput(event.target.value)} aria-label="工作流运行输入 JSON" /></div>
      <div><button onClick={() => void save()} disabled={saving || running}>{saving ? "保存中…" : "保存"}</button><button className="primary-action" onClick={() => void runWorkflow()} disabled={running}>{running ? "运行中…" : "▶ 运行"}</button></div>
    </header>
    {notice && <div className={`agent-notice ${run?.status === "failed" ? "error" : ""}`}>{notice}</div>}
    <div className="agent-builder">
      <aside className="agent-node-palette"><h3>节点</h3><p>拖入画布构建流程</p>{nodeCatalog.map((item) => <div key={item.type} draggable onDragStart={(event) => { event.dataTransfer.setData("application/datapilot-node", item.type); event.dataTransfer.effectAllowed = "move"; }}><span>{item.icon}</span><div><strong>{item.label}</strong><small>{item.description}</small></div></div>)}</aside>
      <section className="agent-canvas" ref={canvasRef} onDrop={drop} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}>
        <ReactFlow<FlowNode, Edge> nodes={nodes} edges={edges} nodeTypes={flowNodeTypes} onInit={setInstance} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={(_event, node) => setSelectedId(node.id)} onPaneClick={() => setSelectedId("")} fitView deleteKeyCode={["Backspace", "Delete"]}>
          <Background color="#d5e1db" gap={22} /><MiniMap nodeColor="#2d8163" maskColor="rgba(244,247,245,.72)" /><Controls />
        </ReactFlow>
      </section>
      <aside className="agent-config-panel">
        {selected ? <NodeConfiguration node={selected} models={models} sources={sources} updateLabel={(value) => updateNode({ label: value })} updateConfig={updateConfig} remove={() => { setNodes((items) => items.filter((node) => node.id !== selected.id)); setEdges((items) => items.filter((edge) => edge.source !== selected.id && edge.target !== selected.id)); setSelectedId(""); }} run={selectedRun} /> : <><h3>工作流配置</h3><p>选择一个节点查看配置、输入输出与错误。</p><label>全局变量（JSON）<textarea value={pretty(variables)} onChange={(event) => { const parsed = tryJson(event.target.value); if (parsed) setVariables(parsed); }} rows={8} /></label>{run && <RunSummary run={run} />}</>}
      </aside>
    </div>
  </div>;

  return <div className="module-content agent-list-page">
    <div className="module-heading"><div><span className="eyebrow">AGENT WORKFLOW</span><h2>智能体</h2><p>用可视化工作流连接模型、数据和业务动作。</p></div><div className="module-heading-actions"><button onClick={() => importInputRef.current?.click()} disabled={importing}>{importing ? "导入中…" : "导入 JSON 文件"}</button><button className="primary-action" onClick={() => setDialog({ mode: "create" })}>＋ 新建智能体</button></div></div>
    <input ref={importInputRef} type="file" accept=".json,application/json" hidden onChange={(event) => void importRagflow(event)} />
    {notice && <div className="agent-notice">{notice}</div>}
    {loading ? <div className="empty-state"><p>正在加载智能体…</p></div> : agents.length === 0 ? <div className="empty-state agent-empty"><span>◇</span><h3>创建第一个智能体</h3><p>从开始节点出发，拖入 LLM、SQL、HTTP 或代码节点。</p><button onClick={() => setDialog({ mode: "create" })}>新建智能体</button></div> : <div className="agent-grid">{agents.map((agent) => <article className="agent-card" key={agent.id} onClick={() => void openAgent(agent).catch((error) => setNotice(message(error)))}><div className="agent-card-icon">◇</div><div><div className="agent-card-title"><h3>{agent.name}</h3><span className={`agent-status ${agent.status}`}>{statusLabel(agent.status)}</span></div><p>{agent.description || "暂无描述"}</p><small>v{agent.currentVersion} · 更新于 {formatDate(agent.updatedAt)}</small></div><footer><button onClick={(event) => { event.stopPropagation(); setDialog({ mode: "edit", agent }); }}>编辑</button><button onClick={(event) => { event.stopPropagation(); void mutateAgent(`/api/agents/${agent.id}/copy`, { method: "POST" }).catch((error) => setNotice(message(error))); }}>复制</button><button onClick={(event) => { event.stopPropagation(); void mutateAgent(`/api/agents/${agent.id}/publish`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ enabled: agent.status !== "published" }) }).catch((error) => setNotice(message(error))); }}>{agent.status === "published" ? "停用" : "发布"}</button><button className="danger" onClick={(event) => { event.stopPropagation(); setDialog({ mode: "delete", agent }); }}>删除</button></footer></article>)}</div>}
    {dialog && <AgentDialog dialog={dialog} close={() => setDialog(null)} submit={async (values) => { try { if (dialog.mode === "create") await mutateAgent("/api/agents", { method: "POST", headers: jsonHeaders, body: JSON.stringify(values) }); else if (dialog.mode === "edit" && dialog.agent) await mutateAgent(`/api/agents/${dialog.agent.id}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(values) }); else if (dialog.agent) await mutateAgent(`/api/agents/${dialog.agent.id}`, { method: "DELETE" }); setDialog(null); } catch (error) { setNotice(message(error)); } }} />}
  </div>;
}

function WorkflowNodeCard({ data, selected }: NodeProps<FlowNode>) {
  const condition = data.nodeType === "condition";
  return <div className={`workflow-node ${data.nodeType} ${selected ? "selected" : ""} ${data.runStatus || ""}`}>
    {data.nodeType !== "start" && <Handle type="target" position={Position.Left} />}
    <span className="workflow-node-icon">{nodeCatalog.find((item) => item.type === data.nodeType)?.icon}</span><div><strong>{data.label}</strong><small>{data.nodeType}</small></div>{data.runStatus && <i title={data.runStatus} />}
    {data.nodeType !== "end" && !condition && <Handle type="source" position={Position.Right} />}
    {condition && <><Handle id="true" type="source" position={Position.Right} style={{ top: "34%" }} /><Handle id="false" type="source" position={Position.Right} style={{ top: "72%" }} /><em className="condition-true">T</em><em className="condition-false">F</em></>}
  </div>;
}

function NodeConfiguration({ node, models, sources, updateLabel, updateConfig, remove, run }: { node: FlowNode; models: ModelOption[]; sources: DataSourceOption[]; updateLabel: (value: string) => void; updateConfig: (key: string, value: unknown) => void; remove: () => void; run?: NodeRun }) {
  const config = node.data.config;
  return <><div className="agent-config-title"><div><small>{node.data.nodeType}</small><h3>{node.data.label}</h3></div>{!['start', 'end'].includes(node.data.nodeType) && <button onClick={remove}>删除</button>}</div><label>节点名称<input value={node.data.label} onChange={(event) => updateLabel(event.target.value)} /></label>
    {node.data.nodeType === "llm" && <><label>模型<select value={String(config.modelId || "")} onChange={(event) => updateConfig("modelId", event.target.value)}><option value="">选择模型</option>{models.filter((item) => item.enabled && ['llm', 'multimodal_llm'].includes(item.modelType)).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>System Prompt<textarea rows={5} value={String(config.systemPrompt || "")} onChange={(event) => updateConfig("systemPrompt", event.target.value)} /></label><label>User Prompt<textarea rows={7} value={String(config.userPrompt || "")} onChange={(event) => updateConfig("userPrompt", event.target.value)} /></label></>}
    {node.data.nodeType === "sql" && <><label>数据源<select value={String(config.datasourceId || "")} onChange={(event) => updateConfig("datasourceId", event.target.value)}><option value="">选择数据源</option>{sources.map((item) => <option value={item.connectionId} key={item.connectionId}>{item.name}</option>)}</select></label><label>SQL 模板<textarea rows={8} value={String(config.sql || "")} onChange={(event) => updateConfig("sql", event.target.value)} placeholder="SELECT ... WHERE id = {{start.output.id}}" /></label></>}
    {node.data.nodeType === "http" && <><label>方法<select value={String(config.method || "GET")} onChange={(event) => updateConfig("method", event.target.value)}>{['GET','POST','PUT','DELETE'].map((item) => <option key={item}>{item}</option>)}</select></label><label>URL<input value={String(config.url || "")} onChange={(event) => updateConfig("url", event.target.value)} /></label><JsonField key={`${node.id}-headers`} label="Headers" value={config.headers} update={(value) => updateConfig("headers", value)} /><JsonField key={`${node.id}-query`} label="Query" value={config.query} update={(value) => updateConfig("query", value)} /><JsonField key={`${node.id}-body`} label="Body" value={config.body} update={(value) => updateConfig("body", value)} /></>}
    {node.data.nodeType === "code" && <><label>输入（JSON）<textarea rows={5} value={pretty(config.input || {})} onChange={(event) => { const value = tryJson(event.target.value); if (value) updateConfig("input", value); }} /></label><label>JavaScript<textarea className="code-input" rows={10} value={String(config.code || "")} onChange={(event) => updateConfig("code", event.target.value)} /></label><p className="field-help">使用 input 读取输入，必须 return JSON；不可访问文件、命令或模块。</p></>}
    {node.data.nodeType === "condition" && <><label>左值<input value={String(config.left || "")} onChange={(event) => updateConfig("left", event.target.value)} placeholder="{{sql-1.output.rowCount}}" /></label><label>运算符<select value={String(config.operator || "==")} onChange={(event) => updateConfig("operator", event.target.value)}>{['==','!=','>','>=','<','<=','contains'].map((item) => <option key={item}>{item}</option>)}</select></label><label>右值<input value={String(config.right || "")} onChange={(event) => updateConfig("right", event.target.value)} /></label></>}
    {node.data.nodeType === "assign" && <JsonField key={`${node.id}-assignments`} label="赋值对象" value={config.assignments} update={(value) => updateConfig("assignments", value)} />}
    {node.data.nodeType === "end" && <label>返回值<input value={String(config.output || "")} onChange={(event) => updateConfig("output", event.target.value)} placeholder="{{nodeId.output}}" /></label>}
    {run && <section className={`node-run-detail ${run.status}`}><h4>执行结果</h4><div><span>状态</span><strong>{run.status}</strong><span>Duration</span><strong>{run.durationMs} ms</strong></div><details open><summary>Input</summary><pre>{pretty(run.input)}</pre></details><details open><summary>Output</summary><pre>{pretty(run.output)}</pre></details>{run.error && <details open><summary>Error</summary><pre>{run.error}</pre></details>}</section>}
  </>;
}

function JsonField({ label, value, update }: { label: string; value: unknown; update: (value: Record<string, unknown>) => void }) { const [text, setText] = useState(pretty(value || {})); return <label>{label}<textarea rows={5} value={text} onChange={(event) => { setText(event.target.value); const parsed = tryJson(event.target.value); if (parsed) update(parsed); }} /></label>; }
function RunSummary({ run }: { run: WorkflowRun }) { return <section className={`agent-run-summary ${run.status}`}><h4>最近运行</h4><p>{run.status} · {run.durationMs} ms</p><pre>{pretty(run.output ?? run.error)}</pre></section>; }
function AgentDialog({ dialog, close, submit }: { dialog: { mode: "create" | "edit" | "delete"; agent?: AgentItem }; close: () => void; submit: (values: { name?: string; description?: string }) => Promise<void> }) { if (dialog.mode === "delete") return <div className="modal-backdrop"><div className="agent-dialog"><h2>删除智能体</h2><p>确认删除“{dialog.agent?.name}”及其工作流版本和运行记录？</p><footer><button onClick={close}>取消</button><button className="danger-confirm" onClick={() => void submit({})}>确认删除</button></footer></div></div>; return <div className="modal-backdrop"><form className="agent-dialog" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); void submit({ name: String(form.get("name") || ""), description: String(form.get("description") || "") }); }}><h2>{dialog.mode === "create" ? "新建智能体" : "编辑智能体"}</h2><label>名称<input name="name" defaultValue={dialog.agent?.name} required autoFocus /></label><label>描述<textarea name="description" defaultValue={dialog.agent?.description} rows={4} /></label><footer><button type="button" onClick={close}>取消</button><button className="primary-action" type="submit">保存</button></footer></form></div>; }

function defaultConfig(kind: NodeKind, models: ModelOption[], sources: DataSourceOption[]): Record<string, unknown> { if (kind === "llm") return { modelId: models.find((item) => item.enabled && item.modelType === "llm")?.id || "", systemPrompt: "你是 DataPilot 智能体。", userPrompt: "{{start.output.query}}" }; if (kind === "sql") return { datasourceId: sources[0]?.connectionId || "", sql: "SELECT 1 AS value" }; if (kind === "http") return { method: "GET", url: "https://example.com", headers: {}, query: {}, body: {} }; if (kind === "code") return { input: "{{start.output}}", code: "return { result: input };" }; if (kind === "condition") return { left: "{{start.output.value}}", operator: "==", right: "true" }; if (kind === "assign") return { assignments: { value: "{{start.output.value}}" } }; if (kind === "end") return { output: "{{start.output}}" }; return {}; }
function requiredRunInputFields(nodes: FlowNode[]) {
  const fields = new Set<string>();
  for (const node of nodes) {
    const text = JSON.stringify(node.data.config || {});
    for (const match of text.matchAll(/\{\{\s*(?:start\.output|input)\.([^}\s]+)\s*\}\}/g)) fields.add(match[1]);
  }
  return [...fields].sort();
}
function createRunInputTemplate(nodes: FlowNode[], placeholder = "") {
  const result: Record<string, unknown> = {};
  for (const path of requiredRunInputFields(nodes)) {
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
function message(error: unknown) { return error instanceof Error ? error.message : "操作失败"; }
const jsonHeaders = { "Content-Type": "application/json" };
