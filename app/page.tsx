"use client";

import { FormEvent, useEffect, useState } from "react";
import { AuthScreen, UserAccountMenu, type AuthUser } from "../components/datapilot/account-access";
import { AgentTracePanel, AnswerExplanation, BusinessErrorCard } from "../components/datapilot/agent-explanation";
import { CurrentDatasourceShortcut } from "../components/datapilot/current-datasource-shortcut";
import { DatasourceDetail } from "../components/datapilot/datasource-detail";
import { erpLabel, sourceState } from "../components/datapilot/datasource-status-card";
import { fallbackDatasourceId } from "../components/datapilot/datasource-selection";
import { DatasourceSwitcher } from "../components/datapilot/datasource-switcher";
import { ChatBubbleIcon, KnowledgeDatabaseIcon, ModelCubeIcon, ServerStackIcon } from "../components/datapilot/icons";
import { KnowledgeBaseView } from "../components/datapilot/knowledge-base";
import { ModelManagement, ModelSelector, type ModelOption } from "../components/datapilot/model-management";
import { RecentAnalyses } from "../components/datapilot/recent-analyses";
import type { AnalysisMessage, AnalysisSession, AnalysisSessionDetail, DataSource, DetailTab, MappingDraftPayload, MappingVersionResponse, MappingVersionsResponse, QueryResult, SchemaMappingResponse } from "../components/datapilot/types";

type View = "chat" | "sources" | "source-detail" | "database" | "knowledge" | "models";
type SchemaTable = { name: string; rows: number; columns: { name: string; type: string; nullable: boolean; key: string; comment: string }[] };
type SqlResult = { sql: string; columns: { key: string; label: string }[]; rows: Record<string, unknown>[]; rowCount: number; executionMs: number; requiresConfirmation?: boolean; operation?: string; affectedRows?: number };
type PendingSql = { sql: string; operation: string; origin: "natural" | "console" };

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001";
const suggestions = ["本月营业收入是多少？", "按月展示今年营业收入趋势", "应收账款余额是多少？", "哪些客户应收金额最高？", "本月费用主要集中在哪些科目？"];

function agentHeaders() {
  const key = "datapilot-session-id";
  let sessionId = window.localStorage.getItem(key);
  if (!sessionId) { sessionId = window.crypto.randomUUID(); window.localStorage.setItem(key, sessionId); }
  return { "Content-Type": "application/json", "X-Session-Id": sessionId };
}

function apiFetch(path: string, init: RequestInit = {}) {
  return fetch(`${API_BASE}${path}`, { ...init, credentials: "include" });
}

export default function Home() {
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authError, setAuthError] = useState("");
  const [view, setView] = useState<View>("chat");
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [analysisSessions, setAnalysisSessions] = useState<AnalysisSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [messages, setMessages] = useState<AnalysisMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sources, setSources] = useState<DataSource[]>([]);
  const [activeSourceId, setActiveSourceId] = useState("");
  const [testingSource, setTestingSource] = useState<string | null>(null);
  const [showAddSource, setShowAddSource] = useState(false);
  const [sshEnabled, setSshEnabled] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [serverSchema, setServerSchema] = useState<SchemaTable[]>([]);
  const [connectionNotice, setConnectionNotice] = useState("");
  const [sqlText, setSqlText] = useState("SHOW TABLES");
  const [sqlResult, setSqlResult] = useState<SqlResult | null>(null);
  const [sqlRunning, setSqlRunning] = useState(false);
  const [pendingSql, setPendingSql] = useState<PendingSql | null>(null);
  const [dbMode, setDbMode] = useState<"natural" | "sql">("natural");
  const [mapping, setMapping] = useState<SchemaMappingResponse | null>(null);
  const [mappingLoading, setMappingLoading] = useState(false);
  const [mappingError, setMappingError] = useState("");
  const [detailTab, setDetailTab] = useState<DetailTab>("overview");
  const [focusedEntity, setFocusedEntity] = useState("");
  const [interactionNotice, setInteractionNotice] = useState("");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState("");

  // Authentication bootstrap intentionally runs once; later changes are explicit account actions.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void restoreSession(); }, []);

  useEffect(() => {
    if (!interactionNotice) return;
    const timer = window.setTimeout(() => setInteractionNotice(""), 2600);
    return () => window.clearTimeout(timer);
  }, [interactionNotice]);

  async function restoreSession() {
    try {
      const response = await apiFetch("/api/auth/me");
      if (!response.ok) return;
      const data = await response.json(); setCurrentUser(data.user); await restoreModels(); const restored = await restoreConnections(); await restoreAnalyses(restored);
    } finally { setAuthLoading(false); }
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setAuthSubmitting(true); setAuthError("");
    try {
      const form = new FormData(event.currentTarget);
      const body = { identifier: String(form.get("identifier") || ""), password: String(form.get("password") || ""), confirmPassword: String(form.get("confirmPassword") || "") };
      if (authMode === "register" && body.password !== body.confirmPassword) throw new Error("两次输入的密码不一致");
      const response = await apiFetch(`/api/auth/${authMode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "认证失败");
      setCurrentUser(data.user); await restoreModels(); const restored = await restoreConnections(); await restoreAnalyses(restored);
    } catch (caught) { setAuthError(message(caught, "认证失败")); }
    finally { setAuthSubmitting(false); }
  }

  async function logout() {
    await apiFetch("/api/auth/logout", { method: "POST" });
    resetAuthenticatedState();
  }

  async function deleteAccount(confirmation: string) {
    const response = await apiFetch("/api/auth/account", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation }) });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || "注销账户失败"); }
    resetAuthenticatedState();
  }

  function resetAuthenticatedState() {
    setCurrentUser(null); setSources([]); setActiveSourceId(""); setResult(null); setMapping(null); setQuestion(""); setAnalysisSessions([]); setActiveSessionId(""); setMessages([]); setModels([]); setSelectedModel(""); setAuthMode("login"); setAuthError("");
  }

  async function restoreModels() {
    const response = await apiFetch("/api/models");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "无法读取模型列表");
    const items = (data.items || []) as ModelOption[];
    const saved = window.localStorage.getItem("datapilot-model");
    const enabled = items.filter((item) => item.enabled);
    const selected = enabled.some((item) => item.id === saved) ? saved! : "";
    setModels(items); setSelectedModel(selected);
  }

  function selectModel(id: string) {
    if (id && !models.some((model) => model.id === id && model.enabled)) return;
    setSelectedModel(id); window.localStorage.setItem("datapilot-model", id);
  }

  async function restoreConnections() {
    try {
      const response = await apiFetch("/api/connections"); const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法恢复数据源");
      const restored: DataSource[] = (data.items || []).map((item: Record<string, unknown>) => ({
        id: String(item.connectionId), connectionId: String(item.connectionId), name: String(item.name),
        engine: `MySQL ${String(item.version || "8+").split("-")[0]}`, host: `${String(item.host)}:${Number(item.port)}`,
        database: String(item.database), tables: Number(item.tables || 0), status: "connected" as const, sshEnabled: Boolean(item.sshEnabled),
      }));
      setSources(restored); setActiveSourceId(fallbackDatasourceId(restored)); void hydrateInsights(restored); return restored;
    } catch (restoreError) { setConnectionNotice(message(restoreError, "无法恢复数据源")); return [] as DataSource[]; }
  }

  async function restoreAnalyses(availableSources: DataSource[]) {
    try {
      const response = await apiFetch("/api/sessions");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法恢复最近分析");
      const items = (data.items || []) as AnalysisSession[];
      setAnalysisSessions(items);
      if (items[0]) await openAnalysis(items[0], availableSources);
      else { setActiveSessionId(""); setMessages([]); setResult(null); setView("chat"); }
    } catch (caught) { setError(message(caught, "无法恢复最近分析")); }
  }

  async function createAnalysis() {
    const response = await apiFetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ datasourceId: activeSource?.connectionId }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "无法新建分析");
    const session = data.session as AnalysisSession;
    setAnalysisSessions((items) => [session, ...items.filter((item) => item.id !== session.id)]);
    setActiveSessionId(session.id); setMessages([]); setQuestion(""); setResult(null); setError(""); setView("chat");
    return session;
  }

  async function openAnalysis(session: AnalysisSession, availableSources = sources) {
    try {
      const response = await apiFetch(`/api/sessions/${encodeURIComponent(session.id)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法打开分析");
      const detail = data as AnalysisSessionDetail;
      setActiveSessionId(detail.session.id); setMessages(detail.messages); setQuestion(""); setResult(null); setError(""); setView("chat");
      if (detail.session.datasourceId && availableSources.some((source) => source.connectionId === detail.session.datasourceId)) {
        setActiveSourceId(detail.session.datasourceId);
      }
    } catch (caught) { setError(message(caught, "无法打开分析")); }
  }

  async function renameAnalysis(session: AnalysisSession, title: string) {
    const response = await apiFetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "无法重命名分析");
    const updated = data.session as AnalysisSession;
    setAnalysisSessions((items) => [updated, ...items.filter((item) => item.id !== updated.id)]);
  }

  async function pinAnalysis(session: AnalysisSession, pinned: boolean) {
    const optimistic = { ...session, pinned, updatedAt: new Date().toISOString() };
    setAnalysisSessions((items) => items.map((item) => item.id === session.id ? optimistic : item));
    try {
      const response = await apiFetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pinned }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法更新置顶状态");
      const updated = data.session as AnalysisSession;
      setAnalysisSessions((items) => items.map((item) => item.id === updated.id ? updated : item));
    } catch (caught) {
      setAnalysisSessions((items) => items.map((item) => item.id === session.id ? session : item));
      setError(message(caught, "无法更新置顶状态"));
    }
  }

  async function deleteAnalysis(session: AnalysisSession) {
    if (!window.confirm(`删除分析“${session.title}”及其全部对话？`)) return;
    const response = await apiFetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || "无法删除分析"); }
    const remaining = analysisSessions.filter((item) => item.id !== session.id);
    setAnalysisSessions(remaining);
    if (activeSessionId === session.id) {
      if (remaining[0]) await openAnalysis(remaining[0]);
      else { setActiveSessionId(""); setMessages([]); setQuestion(""); setResult(null); setView("chat"); }
    }
  }

  async function ensureAnalysisSession() {
    if (activeSessionId) return activeSessionId;
    return (await createAnalysis()).id;
  }

  function startAnalysis() {
    void createAnalysis().catch((caught) => { setError(message(caught, "无法新建分析")); setView("chat"); });
  }

  async function hydrateInsights(items: DataSource[]) {
    const settled = await Promise.all(items.map(async (source) => {
      try { return { id: source.id, insight: await fetchMapping(source, false) }; } catch { return { id: source.id, insight: undefined }; }
    }));
    setSources((current) => current.map((source) => {
      const found = settled.find((item) => item.id === source.id)?.insight;
      return found ? { ...source, insight: found } : source;
    }));
  }

  const activeSource = sources.find((source) => source.id === activeSourceId);
  const activeSession = analysisSessions.find((session) => session.id === activeSessionId);
  const chatHasConversation = view === "chat" && messages.length > 0;
  const viewTitles: Record<View, [string, string]> = {
    chat: [activeSession?.title || "分析工作区", "连续追问，完整上下文仅在当前分析中生效"], sources: ["数据源", "查看数据库连接与 ERP Schema 理解状态"],
    "source-detail": [activeSource?.name || "数据源详情", "ERP Schema Mapping、Join Path 与验证结果"],
    database: [activeSource?.name || "数据库编辑台", "浏览数据结构并通过自然语言或 SQL 操作数据"],
    knowledge: ["知识库", "管理文档、检索配置与向量检索测试"],
    models: ["模型管理", "管理智能问数模型并设置当前默认模型"],
  };

  async function ask(text?: string) {
    const query = (text ?? question).trim();
    if (!activeSource) { setError("请先添加并连接一个数据源"); setView("sources"); return; }
    if (activeSource.status !== "connected") { setError(`数据源 ${activeSource.name} 当前未连接，请先测试连接`); return; }
    if (!query || loading) return;
    const showInConversation = view !== "database";
    const optimisticMessage: AnalysisMessage | undefined = showInConversation ? {
      id: `pending-${window.crypto.randomUUID()}`, sessionId: activeSessionId, role: "user", content: query, createdAt: new Date().toISOString(),
    } : undefined;
    setQuestion(""); setLoading(true); setError(""); setResult(null);
    if (optimisticMessage) { setMessages((items) => [...items, optimisticMessage]); setView("chat"); }
    try {
      const sessionId = await ensureAnalysisSession();
      const response = await apiFetch("/api/query", { method: "POST", headers: agentHeaders(), body: JSON.stringify({ sessionId, question: query, connectionId: activeSource.connectionId, model: selectedModel }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "查询失败");
      if (data.requiresConfirmation) { setPendingSql({ sql: data.sql, operation: data.operation, origin: "natural" }); setResult(data); return; }
      const queryResult = data as QueryResult;
      if (!showInConversation) setResult(queryResult);
      else setMessages((items) => [...items.filter((item) => item.id !== optimisticMessage?.id), ...(queryResult.persistedMessages || [])]);
      if (queryResult.session) setAnalysisSessions((items) => [queryResult.session!, ...items.filter((item) => item.id !== queryResult.session!.id)]);
    } catch (queryError) { setError(message(queryError, "查询失败")); } finally { setLoading(false); }
  }

  async function fetchMapping(source: DataSource, samples: boolean) {
    const response = await apiFetch(`/api/datasources/${encodeURIComponent(source.connectionId)}/schema-mapping?samples=${samples ? "1" : "0"}`); const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取 ERP Schema Mapping 失败"); return data as SchemaMappingResponse;
  }

  async function openSourceDetail(source: DataSource, tab: DetailTab = "overview", entity = "") {
    setActiveSourceId(source.id); setView("source-detail"); setDetailTab(tab); setFocusedEntity(entity); setMappingLoading(true); setMappingError("");
    try {
      const detail = await fetchMapping(source, true); setMapping(detail); setSources((items) => items.map((item) => item.id === source.id ? { ...item, insight: detail } : item));
      if (entity) setTimeout(() => document.getElementById(`entity-${entity}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 60);
    } catch (detailError) { setMapping(null); setMappingError(message(detailError, "读取 ERP Schema Mapping 失败")); } finally { setMappingLoading(false); }
  }

  async function mappingMutation<T>(source: DataSource, path: string, body: unknown) {
    const response = await apiFetch(`/api/datasources/${encodeURIComponent(source.connectionId)}/schema-mapping${path}`, { method: "POST", headers: agentHeaders(), body: JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || "Mapping 操作失败"); return data as T;
  }
  async function saveMappingDraft(draft: MappingDraftPayload) { if (!activeSource) return; await mappingMutation(activeSource, "/draft", draft); await openSourceDetail(activeSource, detailTab, focusedEntity); }
  async function validateMappingDraft(draft: MappingDraftPayload) { if (!activeSource) return; await mappingMutation(activeSource, "/validate", draft); await openSourceDetail(activeSource, "validation", focusedEntity); }
  async function publishMapping(erpType: string) { if (!activeSource) return; await mappingMutation(activeSource, "/publish", { erpType }); await openSourceDetail(activeSource, "overview"); }
  async function loadMappingVersions(erpType: string) {
    if (!activeSource) return { items: [], audits: [] };
    const response = await apiFetch(`/api/datasources/${encodeURIComponent(activeSource.connectionId)}/schema-mapping/versions?erpType=${encodeURIComponent(erpType)}`, { headers: agentHeaders() });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || "读取 Mapping 版本失败"); return data as MappingVersionsResponse;
  }
  async function loadMappingVersion(erpType: string, version: number) {
    if (!activeSource) throw new Error("数据源不存在");
    const response = await apiFetch(`/api/datasources/${encodeURIComponent(activeSource.connectionId)}/schema-mapping/versions/${version}?erpType=${encodeURIComponent(erpType)}`, { headers: agentHeaders() });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || "读取 Mapping 版本失败"); return data as MappingVersionResponse;
  }
  async function rollbackMapping(erpType: string, version: number) { if (!activeSource) return; await mappingMutation(activeSource, `/rollback/${version}`, { erpType, changeSummary: `从前端回滚到 v${version}` }); await openSourceDetail(activeSource, "versions"); }

  async function addConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setConnecting(true); setConnectionNotice("");
    try {
      const form = new FormData(event.currentTarget); const keyFile = form.get("sshKey") as File | null;
      const config = { name: String(form.get("name") || ""), engine: "mysql", host: String(form.get("host") || ""), port: Number(form.get("port")), database: String(form.get("database") || ""), user: String(form.get("user") || ""), password: String(form.get("password") || ""), ssh: sshEnabled ? { enabled: true, host: String(form.get("sshHost") || ""), port: Number(form.get("sshPort")), user: String(form.get("sshUser") || ""), privateKey: keyFile?.size ? await keyFile.text() : "", passphrase: String(form.get("sshPassphrase") || "") } : undefined };
      const response = await apiFetch("/api/connections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) }); const data = await response.json();
      if (!response.ok) throw new Error(data.error || "连接失败");
      const source: DataSource = { id: data.connectionId, connectionId: data.connectionId, name: data.name, engine: `MySQL ${String(data.version).split("-")[0]}`, host: `${data.host}:${data.port}`, database: data.database, tables: data.tables, status: "connected", sshEnabled: data.sshEnabled };
      setSources((items) => [...items, source]); setActiveSourceId(source.id); setShowAddSource(false); setSshEnabled(false); setConnectionNotice(`连接成功 · ${data.tables} 张表 · ${data.latencyMs} ms`); await openSourceDetail(source);
    } catch (connectionError) { setConnectionNotice(message(connectionError, "连接失败")); } finally { setConnecting(false); }
  }

  async function testConnection(source: DataSource) {
    setTestingSource(source.id); setConnectionNotice("");
    try {
      const response = await apiFetch(`/api/connections/${source.connectionId}/test`, { method: "POST" }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "连接失败");
      setSources((items) => items.map((item) => item.id === source.id ? { ...item, status: "connected", tables: data.tables } : item)); setConnectionNotice(`连接成功 · ${data.tables} 张表 · ${data.latencyMs} ms`);
    } catch (connectionError) { setSources((items) => items.map((item) => item.id === source.id ? { ...item, status: "offline" } : item)); setConnectionNotice(message(connectionError, "连接失败")); } finally { setTestingSource(null); }
  }

  async function loadSchema(connectionId = activeSource?.connectionId) {
    if (!connectionId) throw new Error("请先连接数据源"); const response = await apiFetch(`/api/database/schema?connectionId=${encodeURIComponent(connectionId)}`); const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取 Schema 失败"); setServerSchema(data.tables || []);
  }
  function openDatabase(source: DataSource) { setActiveSourceId(source.id); setView("database"); setServerSchema([]); setSqlResult(null); setPendingSql(null); void loadSchema(source.connectionId).catch((e) => setConnectionNotice(e.message)); }

  async function runSql(confirm = false) {
    if (!activeSource || !sqlText.trim() || sqlRunning) return; setSqlRunning(true); setConnectionNotice("");
    try {
      const requested = confirm && pendingSql ? pendingSql.sql : sqlText; const response = await apiFetch("/api/database/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql: requested, connectionId: activeSource.connectionId, confirm }) }); const data = await response.json();
      if (!response.ok) throw new Error(data.error || "SQL 执行失败");
      if (data.requiresConfirmation) { setPendingSql({ sql: data.sql, operation: data.operation, origin: "console" }); setSqlResult(null); }
      else { setSqlResult(data); setPendingSql(null); if (confirm) { setConnectionNotice(`执行成功 · ${data.operation} 影响 ${data.affectedRows ?? 0} 行`); await loadSchema(); } }
    } catch (sqlError) { setConnectionNotice(message(sqlError, "SQL 执行失败")); } finally { setSqlRunning(false); }
  }

  function selectQuerySource(source: DataSource) {
    setActiveSourceId(source.id); setResult(null); setError("");
    if (activeSessionId) void apiFetch(`/api/sessions/${encodeURIComponent(activeSessionId)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ datasourceId: source.connectionId }),
    }).then(async (response) => {
      if (!response.ok) return;
      const data = await response.json();
      setAnalysisSessions((items) => [data.session, ...items.filter((item) => item.id !== data.session.id)]);
    });
  }
  async function removeSource(source: DataSource) { await apiFetch(`/api/connections/${source.connectionId}`, { method: "DELETE" }).catch(() => undefined); const remaining = sources.filter((item) => item.id !== source.id); setSources(remaining); setActiveSourceId(fallbackDatasourceId(remaining, activeSourceId === source.id ? undefined : activeSourceId)); setMapping(null); }

  if (authLoading) return <main className="auth-page"><div className="auth-loading">正在验证登录状态…</div></main>;
  if (!currentUser) return <AuthScreen mode={authMode} setMode={(mode) => { setAuthMode(mode); setAuthError(""); }} submitting={authSubmitting} error={authError} submit={submitAuth} />;

  return <main className="app-shell">
    <aside className="sidebar">
      <button className="brand" aria-label="打开当前分析" onClick={() => setView("chat")}><span>DataPilot</span></button>
      <button className="new-chat" onClick={startAnalysis}><span className="nav-icon">＋</span><span>新建分析</span></button>
      <nav aria-label="主导航">
        <button className={`nav-item ${view === "sources" || view === "source-detail" ? "active" : ""}`} onClick={() => setView("sources")}><span className="nav-icon"><ServerStackIcon /></span>数据源</button>
        <button className={`nav-item ${view === "knowledge" ? "active" : ""}`} onClick={() => setView("knowledge")}><span className="nav-icon"><KnowledgeDatabaseIcon /></span>知识库</button>
        <button className={`nav-item ${view === "models" ? "active" : ""}`} onClick={() => setView("models")}><span className="nav-icon"><ModelCubeIcon /></span>模型管理</button>
      </nav>
      <div className="sidebar-sessions">
        <RecentAnalyses sessions={analysisSessions} activeSessionId={activeSessionId} onOpen={(session) => void openAnalysis(session)} onPin={pinAnalysis} onRename={renameAnalysis} onDelete={deleteAnalysis} />
      </div>
      <div className="sidebar-footer">
        <CurrentDatasourceShortcut source={activeSource} onOpen={() => activeSource ? void openSourceDetail(activeSource) : setView("sources")} />
        <div className="sidebar-bottom"><UserAccountMenu user={currentUser} onLogout={logout} onDelete={deleteAccount} /></div>
      </div>
    </aside>

    <section className={`workspace ${chatHasConversation ? "chat-conversation-active" : ""}`}>{!chatHasConversation && <header className="topbar"><div><h1>{viewTitles[view][0]}</h1><p>{viewTitles[view][1]}</p></div><div className="top-actions"><span className="connection"><i className={activeSource?.status === "connected" ? "" : "offline"} />{activeSource ? sourceState(activeSource).title : "等待连接"}</span><button aria-label="帮助" title="帮助中心" onClick={() => setInteractionNotice("帮助中心功能开发中")}>?</button></div></header>}
      {view === "chat" && <ChatView session={activeSession} messages={messages} createAnalysis={startAnalysis} sources={sources} activeSource={activeSource} activeSourceId={activeSourceId} selectSource={selectQuerySource} models={models} selectedModel={selectedModel} selectModel={selectModel} question={question} setQuestion={setQuestion} ask={ask} loading={loading} error={error} result={result} openSources={() => setView("sources")} addSource={() => { setShowAddSource(true); setView("sources"); }} inspect={(tab, entity) => activeSource && void openSourceDetail(activeSource, tab, entity)} />}
      {view === "sources" && <SourcesView sources={sources} activeSourceId={activeSourceId} testingSource={testingSource} notice={connectionNotice} add={() => { setConnectionNotice(""); setShowAddSource(true); }} open={(source) => void openSourceDetail(source)} test={testConnection} workbench={openDatabase} remove={removeSource} />}
      {view === "source-detail" && activeSource && <DatasourceDetail source={activeSource} mapping={mapping} loading={mappingLoading} error={mappingError} tab={detailTab} focusedEntity={focusedEntity} onTab={setDetailTab} onBack={() => setView("sources")} onOpenWorkbench={() => openDatabase(activeSource)} onRefresh={() => void openSourceDetail(activeSource, detailTab, focusedEntity)} onSaveDraft={saveMappingDraft} onValidate={validateMappingDraft} onPublish={publishMapping} onLoadVersions={loadMappingVersions} onLoadVersion={loadMappingVersion} onRollback={rollbackMapping} />}
      {view === "database" && activeSource && <DatabaseWorkbench source={activeSource} schema={serverSchema} mode={dbMode} setMode={setDbMode} question={question} setQuestion={setQuestion} ask={ask} loading={loading} error={error} result={result} sqlText={sqlText} setSqlText={setSqlText} sqlResult={sqlResult} sqlRunning={sqlRunning} runSql={() => void runSql()} notice={connectionNotice} pendingSql={pendingSql} cancelPending={() => setPendingSql(null)} confirmWrite={() => void runSql(true)} back={() => void openSourceDetail(activeSource)} setNotice={setConnectionNotice} loadSchema={loadSchema} />}
      {view === "knowledge" && <KnowledgeBaseView />}
      {view === "models" && <ModelManagement models={models} selectedModel={selectedModel} onSelect={selectModel} onRefresh={restoreModels} />}
    </section>
    {showAddSource && <ConnectionModal sshEnabled={sshEnabled} setSshEnabled={setSshEnabled} connecting={connecting} notice={connectionNotice} close={() => setShowAddSource(false)} submit={addConnection} />}
    {interactionNotice && <div className="interaction-toast" role="status"><span>{interactionNotice}</span><button aria-label="关闭提示" onClick={() => setInteractionNotice("")}>×</button></div>}
  </main>;
}

function ChatView({ session, messages, createAnalysis, sources, activeSource, activeSourceId, selectSource, models, selectedModel, selectModel, question, setQuestion, ask, loading, error, result, openSources, addSource, inspect }: { session?: AnalysisSession; messages: AnalysisMessage[]; createAnalysis: () => void; sources: DataSource[]; activeSource?: DataSource; activeSourceId: string; selectSource: (source: DataSource) => void; models: ModelOption[]; selectedModel: string; selectModel: (id: string) => void; question: string; setQuestion: (v: string) => void; ask: (v?: string) => Promise<void>; loading: boolean; error: string; result: QueryResult | null; openSources: () => void; addSource: () => void; inspect: (tab: DetailTab, entity?: string) => void }) {
  const queryAvailable = activeSource?.status === "connected";
  const hasConversation = messages.length > 0;
  const composer = <form className="query-box" onSubmit={(event) => { event.preventDefault(); void ask(); }}>
    <textarea aria-label="输入数据问题" value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask(); } }} placeholder={queryAvailable ? "例如：本月营业收入是多少？" : activeSource ? "当前数据源未连接" : "请先添加一个数据源"} rows={2} disabled={!queryAvailable} />
    <div className="query-footer"><div className="query-options"><DatasourceSwitcher sources={sources} activeSourceId={activeSourceId} onSelect={selectSource} onManageSources={openSources} /><ModelSelector models={models} value={selectedModel} onChange={selectModel} /></div><button className="send-button" type="submit" disabled={loading || !question.trim() || !queryAvailable}>{loading ? "分析中…" : "发送 ↗"}</button></div>
  </form>;
  if (!session && !result) return <div className="content"><div className="empty-analysis"><span><ChatBubbleIcon /></span><h2>开始一项新的数据分析</h2><p>每项分析拥有独立的多轮上下文，刷新或重新登录后仍可继续。</p><button onClick={createAnalysis}>＋ 新建分析</button></div></div>;
  return <div className={`content analysis-workspace ${hasConversation ? "has-conversation" : "new-conversation"}`}>
    {!hasConversation && <section className="hero-copy"><div className="eyebrow">ERP FINANCE DATA AGENT</div><h2>今天想了解什么？</h2><p>当前分析中的连续追问会共享上下文，不会与其他分析串联。</p></section>}
    {!hasConversation && composer}
    {!hasConversation && <div className="suggestions">{suggestions.map((item) => <button key={item} onClick={() => void ask(item)} disabled={!queryAvailable}>{item}<span>↗</span></button>)}</div>}
    {error && <BusinessErrorCard message={error} source={activeSource} onInspect={inspect} />}
    {!activeSource && <div className="empty-state compact"><span>▦</span><h3>还没有数据源</h3><p>连接数据源后即可开始 ERP 智能问数。</p><button onClick={addSource}>添加数据源</button></div>}
    <section className="message-stream" aria-label="分析对话">
      {messages.map((item) => item.role === "user"
        ? <article className="user-message" key={item.id}><p>{item.content}</p></article>
        : item.result ? <QueryResultCard key={item.id} result={item.result} /> : <article className="assistant-message" key={item.id}>{item.content}</article>)}
      <AgentTracePanel loading={loading} />
      {result && <QueryResultCard result={result} />}
    </section>
    {hasConversation && <div className="conversation-composer">{composer}</div>}
  </div>;
}

function QueryResultCard({ result }: { result: QueryResult }) {
  const maxChart = Math.max(...(result.chart?.map((item) => item.value) ?? [1]));
  return <section className="result-card" aria-live="polite"><div className="result-head"><div><span className="answer-badge">✓</span><div><h3>{result.explanation?.metrics[0]?.name || "分析完成"}</h3><p>{result.question}</p></div></div><span className="runtime">{result.executionMs} ms</span></div><div className="summary"><span>✦</span><p>{result.summary}</p></div>{result.chart && <div className="chart-wrap"><div className="chart-head"><h4>核心指标</h4></div><div className="bar-chart">{result.chart.map((item, index) => <div className="bar-column" key={`${item.label}-${index}`}><span className="bar-value">{item.value}</span><div className="bar" style={{ height: `${Math.max(18, (item.value / maxChart) * 100)}%` }} /><span className="bar-label">{item.label}</span></div>)}</div></div>}<ResultTable result={result} /><AnswerExplanation explanation={result.explanation} sql={result.sql} trace={result.agent?.trace} /></section>;
}

function SourcesView({ sources, activeSourceId, testingSource, notice, add, open, test, workbench, remove }: { sources: DataSource[]; activeSourceId: string; testingSource: string | null; notice: string; add: () => void; open: (s: DataSource) => void; test: (s: DataSource) => Promise<void>; workbench: (s: DataSource) => void; remove: (s: DataSource) => Promise<void> }) { return <div className="module-content sources-page"><div className="module-heading"><div><span className="eyebrow">ERP DATA CONNECTIONS</span><h2>连接并理解客户的业务数据</h2><p>每个数据源独立维护 ERP Mapping 与 Join Registry。</p></div><button className="primary-action" onClick={add}>＋ 添加数据源</button></div>{sources.length === 0 ? <div className="empty-state source-empty"><span>＋</span><h3>添加第一个数据源</h3><p>连接后自动分析 ERP Schema。</p><button onClick={add}>配置连接</button></div> : <div className="source-grid">{sources.map((source) => { const state = sourceState(source); return <article className={`db-card ${activeSourceId === source.id ? "selected" : ""}`} key={source.id} role="button" tabIndex={0} aria-label={`查看数据源 ${source.name}`} onClick={() => open(source)} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); open(source); } }}><div className="db-card-top"><span className="db-icon">ERP</span><span className={`source-status ${state.tone}`}>{state.title}</span></div><h3>{source.name}</h3><p>{source.engine} · {source.insight ? erpLabel(source.insight.erpType) : "待分析"}<br />{source.host} / {source.database}</p><div className="db-stats semantic"><span><strong>{source.insight?.semanticSchema.length || 0} / 9</strong> ERP 实体</span><span><strong>{Math.round((source.insight?.mappingConfidence || 0) * 100)}%</strong> Mapping</span><span><strong>{source.insight?.joinPaths.length || 0}</strong> Validated Join</span></div><div className="db-open">查看 ERP Schema 理解详情 →</div><div className="db-actions"><button onClick={(event) => { event.stopPropagation(); void test(source); }}>{testingSource === source.id ? "测试中…" : "测试连接"}</button><button onClick={(event) => { event.stopPropagation(); workbench(source); }}>数据库编辑台</button><button aria-label={`移除数据源 ${source.name}`} onClick={(event) => { event.stopPropagation(); void remove(source); }}>移除</button></div></article>; })}</div>}{notice && <div className={`connection-notice ${notice.startsWith("连接成功") ? "success" : ""}`}>{notice}</div>}</div>; }

function DatabaseWorkbench(p: { source: DataSource; schema: SchemaTable[]; mode: "natural" | "sql"; setMode: (v: "natural" | "sql") => void; question: string; setQuestion: (v: string) => void; ask: () => Promise<void>; loading: boolean; error: string; result: QueryResult | null; sqlText: string; setSqlText: (v: string) => void; sqlResult: SqlResult | null; sqlRunning: boolean; runSql: () => void; notice: string; pendingSql: PendingSql | null; cancelPending: () => void; confirmWrite: () => void; back: () => void; setNotice: (v: string) => void; loadSchema: () => Promise<void> }) { return <div className="database-workbench"><aside className="db-explorer"><div className="explorer-head"><button onClick={p.back}>← 数据源详情</button><h3>{p.source.database}</h3><p>{p.source.host}</p></div><div className="explorer-label"><span>原始数据表</span><button onClick={() => void p.loadSchema().catch((e) => p.setNotice(e.message))}>↻</button></div>{p.schema.length ? <div className="table-tree">{p.schema.map((table) => <button key={table.name} onClick={() => { p.setSqlText(`SELECT * FROM \`${table.name}\` LIMIT 100`); p.setMode("sql"); }}><span>▦</span><div><strong>{table.name}</strong><small>{table.rows.toLocaleString()} 行 · {table.columns.length} 列</small></div><em>›</em></button>)}</div> : <div className="explorer-empty">正在读取表结构…</div>}</aside><section className="db-editor"><div className="db-editor-head"><div><span className="source-status connected">已连接</span><h2>{p.source.name}</h2><p>{p.source.engine} · {p.source.sshEnabled ? "SSH 隧道" : "TCP 直连"}</p></div></div><div className="editor-tabs"><button className={p.mode === "natural" ? "active" : ""} onClick={() => p.setMode("natural")}>✦ 自然语言</button><button className={p.mode === "sql" ? "active" : ""} onClick={() => p.setMode("sql")}>⌘ SQL 编辑器</button></div>{p.notice && <div className={`connection-notice ${p.notice.startsWith("执行成功") ? "success" : ""}`}>{p.notice}</div>}{p.pendingSql && <div className="write-confirm"><div><span>需要确认</span><h3>{p.pendingSql.operation} 将修改数据库</h3><p>请核对 SQL 和 WHERE 条件。</p></div><pre><code>{p.pendingSql.sql}</code></pre><div><button onClick={p.cancelPending}>取消</button><button className="danger-confirm" onClick={p.confirmWrite} disabled={p.sqlRunning}>{p.sqlRunning ? "执行中…" : `确认执行 ${p.pendingSql.operation}`}</button></div></div>}{p.mode === "natural" ? <div className="natural-panel"><h3>用自然语言操作数据库</h3><p>问数请求会经过 ERP 指标、Schema Mapping、Join Path 与 SQL Safety。</p><form onSubmit={(event) => { event.preventDefault(); void p.ask(); }}><textarea value={p.question} onChange={(event) => p.setQuestion(event.target.value)} placeholder="例如：本月营业收入是多少？" /><button disabled={!p.question.trim() || p.loading}>{p.loading ? "生成中…" : "生成并运行"}</button></form>{p.error && <div className="error-message">{p.error}</div>}{p.result && <><div className="summary"><span>✦</span><p>{p.result.summary}</p></div><ResultTable result={p.result} /><AnswerExplanation explanation={p.result.explanation} sql={p.result.sql} trace={p.result.agent?.trace} /></>}</div> : <section className="sql-console workbench-console"><div className="schema-head"><div><h3>SQL 编辑器</h3><p>支持 SELECT、INSERT、UPDATE、DELETE；写操作执行前必须确认</p></div><span className="schema-sync">最多返回 200 行</span></div><textarea value={p.sqlText} onChange={(event) => p.setSqlText(event.target.value)} spellCheck={false} /><div className="sql-console-actions"><button onClick={p.runSql} disabled={p.sqlRunning}>{p.sqlRunning ? "执行中…" : "▶ 执行 SQL"}</button></div>{p.sqlResult && <SqlResultTable result={p.sqlResult} />}</section>}</section></div>; }


function ConnectionModal({ sshEnabled, setSshEnabled, connecting, notice, close, submit }: { sshEnabled: boolean; setSshEnabled: (v: boolean) => void; connecting: boolean; notice: string; close: () => void; submit: (e: FormEvent<HTMLFormElement>) => Promise<void> }) { return <div className="modal-backdrop" onMouseDown={() => !connecting && close()}><form className="source-modal source-modal-wide" onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => void submit(e)}><div className="modal-head"><div><h2>添加数据源</h2><p>由客户填写连接信息；密码与私钥由服务端加密保存。</p></div><button type="button" onClick={close}>×</button></div><div className="connection-form-grid"><label>连接名称<input name="name" required /></label><label>数据库类型<select name="engine"><option>MySQL 8+</option></select></label><label className="span-two">主机名或 IP<input name="host" required /></label><label>端口<input name="port" type="number" defaultValue="3306" required /></label><label>数据库名<input name="database" required /></label><label>用户名<input name="user" required autoComplete="username" /></label><label>密码<input name="password" type="password" required autoComplete="current-password" /></label></div><label className="ssh-switch"><input type="checkbox" checked={sshEnabled} onChange={(e) => setSshEnabled(e.target.checked)} /><span><strong>通过 SSH 隧道连接</strong><small>适用于数据库仅能从跳板机访问的情况</small></span></label>{sshEnabled && <div className="ssh-fields"><div className="connection-form-grid"><label className="span-two">SSH 主机名或 IP<input name="sshHost" required /></label><label>SSH 端口<input name="sshPort" type="number" defaultValue="22" required /></label><label>SSH 用户名<input name="sshUser" required /></label><label className="span-two">SSH 私钥文件<input name="sshKey" type="file" required /></label><label className="span-two">私钥口令（可选）<input name="sshPassphrase" type="password" /></label></div></div>}{notice && <div className="connection-notice modal-notice">{notice}</div>}<div className="modal-actions"><button type="button" onClick={close}>取消</button><button className="primary-action" type="submit" disabled={connecting}>{connecting ? "正在测试连接…" : "测试并连接"}</button></div></form></div>; }

function ResultTable({ result }: { result: QueryResult }) { return <div className="table-section"><div className="table-toolbar"><h4>查询结果 <span>{result.rowCount} 行</span></h4><button onClick={() => downloadCsv(result)}>⇩ 导出 CSV</button></div><div className="table-scroll"><table><thead><tr>{result.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead><tbody>{result.rows.map((row, i) => <tr key={i}>{result.columns.map((c) => <td key={c.key}>{row[c.key]}</td>)}</tr>)}</tbody></table></div></div>; }
function SqlResultTable({ result }: { result: SqlResult }) { return <div className="sql-result"><div className="table-toolbar"><h4>执行结果 <span>{result.rowCount} 行 · {result.executionMs} ms</span></h4></div><div className="table-scroll"><table><thead><tr>{result.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead><tbody>{result.rows.map((row, i) => <tr key={i}>{result.columns.map((c) => <td key={c.key}>{String(row[c.key] ?? "")}</td>)}</tr>)}</tbody></table></div></div>; }
function message(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
function downloadCsv(result: QueryResult) { const header = result.columns.map((c) => c.label).join(","); const body = result.rows.map((row) => result.columns.map((c) => `"${String(row[c.key]).replaceAll('"', '""')}"`).join(",")).join("\n"); const blob = new Blob(["\ufeff" + header + "\n" + body], { type: "text/csv;charset=utf-8" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "datapilot-result.csv"; a.click(); URL.revokeObjectURL(a.href); }
