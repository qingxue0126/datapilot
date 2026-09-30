"use client";

import { useEffect, useMemo, useState } from "react";
import { apiUrl } from "./api-base";
import { CopyOutputIcon, TraceLogIcon } from "./icons";
import type { AnalysisMessage, AnalysisSession, AnalysisSessionDetail, DataSource, QueryResult } from "./types";
import type { ModelOption } from "./model-management";

type AgentOption = { id: string; name: string };
type NodeRun = { id: string; nodeId: string; nodeType: string; status: string; input: unknown; output: unknown; error: string | null; durationMs: number };
type WorkflowRun = { id: string; agentId: string; workflowVersion: number; status: string; input: unknown; output: unknown; error: string | null; durationMs: number; startedAt: string; finishedAt: string | null; nodeRuns: NodeRun[] };

export function ConversationLogs({ username, models, agents, sources }: { username: string; models: ModelOption[]; agents: AgentOption[]; sources: DataSource[] }) {
  const [sessions, setSessions] = useState<AnalysisSession[]>([]);
  const [detail, setDetail] = useState<AnalysisSessionDetail | null>(null);
  const [query, setQuery] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [traceMessage, setTraceMessage] = useState<AnalysisMessage | null>(null);
  const [workflowRun, setWorkflowRun] = useState<WorkflowRun | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [copiedId, setCopiedId] = useState("");

  useEffect(() => { void loadSessions(); }, []);

  async function loadSessions() {
    setLoading(true); setError("");
    try {
      const response = await fetch(apiUrl("/api/sessions"), { credentials: "include" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法读取会话日志");
      setSessions(((data.items || []) as AnalysisSession[]).filter((item) => item.messageCount > 0));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "无法读取会话日志"); }
    finally { setLoading(false); }
  }

  async function openSession(session: AnalysisSession) {
    setError("");
    try {
      const response = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(session.id)}`), { credentials: "include" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法读取聊天记录");
      setDetail(data as AnalysisSessionDetail);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "无法读取聊天记录"); }
  }

  async function showTrace(message: AnalysisMessage) {
    setTraceMessage(message); setWorkflowRun(null);
    const metadata = message.result;
    const runId = metadata && "runId" in metadata && typeof metadata.runId === "string" ? metadata.runId : "";
    if (!runId || isQueryResult(metadata)) return;
    setTraceLoading(true);
    try {
      const response = await fetch(apiUrl(`/api/workflow-runs/${encodeURIComponent(runId)}`), { credentials: "include" });
      const data = await response.json();
      if (response.ok) setWorkflowRun(data.run as WorkflowRun);
    } finally { setTraceLoading(false); }
  }

  async function copyOutput(message: AnalysisMessage) {
    try { await navigator.clipboard.writeText(message.content); }
    catch {
      const area = document.createElement("textarea"); area.value = message.content; document.body.appendChild(area); area.select(); document.execCommand("copy"); area.remove();
    }
    setCopiedId(message.id); window.setTimeout(() => setCopiedId(""), 1200);
  }

  const filtered = useMemo(() => sessions.filter((session) => {
    const textMatches = !query.trim() || session.title.toLowerCase().includes(query.trim().toLowerCase()) || username.toLowerCase().includes(query.trim().toLowerCase());
    const timestamp = Date.parse(session.createdAt);
    const afterStart = !startDate || timestamp >= new Date(`${startDate}T00:00:00`).getTime();
    const beforeEnd = !endDate || timestamp <= new Date(`${endDate}T23:59:59.999`).getTime();
    return textMatches && afterStart && beforeEnd;
  }), [sessions, query, startDate, endDate, username]);

  if (detail) return <section className="conversation-log-page conversation-log-detail">
    <header><button type="button" onClick={() => setDetail(null)}>← 返回会话查询</button><div><h2>{detail.session.title}</h2><p>{username} · {formatTime(detail.session.createdAt)} · {Math.ceil(detail.session.messageCount / 2)} 轮</p></div></header>
    {error && <div className="conversation-log-error">{error}</div>}
    <div className="conversation-log-messages">{detail.messages.map((message) => message.role === "user"
      ? <article className="log-user-message" key={message.id}><div>{message.content}</div><time>{formatTime(message.createdAt)}</time></article>
      : <article className="log-assistant-message" key={message.id}><div className="log-output-content">{message.content}</div><footer><time>{formatTime(message.createdAt)}</time><span><button title="复制输出" aria-label="复制输出" onClick={() => void copyOutput(message)}><CopyOutputIcon />{copiedId === message.id && <em>已复制</em>}</button><button title="查看执行日志" aria-label="查看执行日志" onClick={() => void showTrace(message)}><TraceLogIcon /></button></span></footer></article>)}</div>
    {traceMessage && <TraceDialog message={traceMessage} run={workflowRun} loading={traceLoading} models={models} agents={agents} sources={sources} datasourceId={detail.session.datasourceId} close={() => { setTraceMessage(null); setWorkflowRun(null); }} />}
  </section>;

  return <section className="conversation-log-page">
    <header className="conversation-log-heading"><div><div className="eyebrow">CONVERSATION LOGS</div><h2>会话查询</h2><p>查看智能问答与智能体会话及每次回答的执行信息。</p></div><div className="conversation-log-filters"><label><span>开始时间</span><input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label><i>→</i><label><span>结束时间</span><input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label><input aria-label="搜索会话" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="会话名称、创建人" /></div></header>
    {error && <div className="conversation-log-error">{error}</div>}
    <div className="conversation-log-table"><div className="conversation-log-row conversation-log-table-head"><span>序号</span><span>会话名称</span><span>用户</span><span>创建时间</span><span>修改时间</span><span>消息轮次</span></div>
      {loading ? <div className="conversation-log-empty">正在读取会话日志…</div> : filtered.length ? filtered.map((session, index) => <button className="conversation-log-row" key={session.id} onClick={() => void openSession(session)}><span>{index + 1}</span><strong>{session.title}</strong><span>{username}</span><time>{formatTime(session.createdAt)}</time><time>{formatTime(session.updatedAt)}</time><span>{Math.ceil(session.messageCount / 2)}</span></button>) : <div className="conversation-log-empty">没有符合条件的会话</div>}
    </div>
  </section>;
}

function TraceDialog({ message, run, loading, models, agents, sources, datasourceId, close }: { message: AnalysisMessage; run: WorkflowRun | null; loading: boolean; models: ModelOption[]; agents: AgentOption[]; sources: DataSource[]; datasourceId?: string; close: () => void }) {
  const result = message.result;
  const queryResult = isQueryResult(result) ? result : undefined;
  const metadata = object(result);
  const agentId = run?.agentId || (typeof metadata.agentId === "string" ? metadata.agentId : "");
  const modelIds = new Set<string>();
  if (queryResult?.model) modelIds.add(queryResult.model);
  for (const node of run?.nodeRuns || []) {
    const input = object(node.input); const modelId = typeof input.modelId === "string" ? input.modelId : ""; if (modelId) modelIds.add(modelId);
  }
  const modelNames = [...modelIds].map((id) => models.find((model) => model.id === id)?.name || id);
  const datasourceName = sources.find((source) => source.connectionId === datasourceId)?.name || "";
  return <div className="trace-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="trace-dialog" role="dialog" aria-modal="true" aria-label="执行日志">
    <header><div><h2>Trace 日志 <small>{run?.id || queryResult?.agent?.runId || String(metadata.runId || "")}</small></h2><div className="trace-badges"><span>{formatDuration(run?.durationMs ?? queryResult?.executionMs ?? Number(metadata.durationMs || 0))}</span><span>{run?.status || String(metadata.status || "成功")}</span></div></div><button aria-label="关闭" onClick={close}>×</button></header>
    <div className="trace-overview"><article><small>调用方式</small><strong>{agentId ? "智能体" : "智能问数"}</strong></article><article><small>智能体</small><strong>{agentId ? agents.find((agent) => agent.id === agentId)?.name || agentId : "DataPilot 数据问答"}</strong></article><article><small>大模型</small><strong>{modelNames.join("、") || "自动路由（模型管理）"}</strong></article><article><small>数据源</small><strong>{datasourceName || (queryResult ? "当前会话数据源" : "由智能体工作流配置")}</strong></article></div>
    {loading ? <div className="conversation-log-empty">正在读取执行链路…</div> : <div className="trace-layout"><nav>{run?.nodeRuns.length ? run.nodeRuns.map((node, index) => <div key={node.id}><b>{index + 1}</b><span><strong>{node.nodeId}</strong><small>{node.nodeType} · {node.durationMs} ms · {node.status}</small></span></div>) : queryResult?.agent?.trace.map((step, index) => <div key={`${step.step}-${index}`}><b>{index + 1}</b><span><strong>{step.step}</strong><small>{step.durationMs ?? 0} ms · {step.status}</small></span></div>) || <div className="trace-empty">该历史回答没有更详细的节点记录</div>}</nav><main><h3>对话输入</h3><pre>{pretty(run?.input ?? { question: queryResult?.question })}</pre><h3>对话输出</h3><pre className="trace-output">{pretty(run?.output ?? message.content)}</pre>{run?.nodeRuns.map((node) => <details key={node.id}><summary>{node.nodeId} · {node.nodeType} · {node.durationMs} ms</summary><pre>{pretty({ input: node.input, output: node.output, error: node.error })}</pre></details>)}</main></div>}
  </section></div>;
}

function isQueryResult(result: AnalysisMessage["result"]): result is QueryResult { return Boolean(result && typeof result.summary === "string" && Array.isArray(result.rows)); }
function object(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function pretty(value: unknown) { return typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2); }
function formatDuration(value: number) { return value >= 60_000 ? `${Math.floor(value / 60_000)}m ${Math.round(value % 60_000 / 1000)}s` : `${Math.max(0, value)} ms`; }
function formatTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "--" : date.toLocaleString("zh-CN", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
