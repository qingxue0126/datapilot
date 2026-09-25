"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { AgentTracePanel, AnswerExplanation, BusinessErrorCard } from "../components/datapilot/agent-explanation";
import { DatasourceDetail } from "../components/datapilot/datasource-detail";
import { DatasourceStatusCard, erpLabel, sourceState } from "../components/datapilot/datasource-status-card";
import type { DataSource, DetailTab, QueryResult, SchemaMappingResponse } from "../components/datapilot/types";

type View = "chat" | "sources" | "source-detail" | "database" | "history";
type HistoryItem = { id: string; question: string; createdAt: string; rowCount: number; executionMs: number; result: QueryResult };
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

export default function Home() {
  const [view, setView] = useState<View>("sources");
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historySearch, setHistorySearch] = useState("");
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

  // Initial connection discovery intentionally runs once; later refreshes are explicit user actions.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void restoreConnections(); }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = localStorage.getItem("datapilot-history");
      if (!saved) return;
      try { setHistory(JSON.parse(saved)); } catch { localStorage.removeItem("datapilot-history"); }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function restoreConnections() {
    try {
      const response = await fetch(`${API_BASE}/api/connections`); const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法恢复数据源");
      const restored: DataSource[] = (data.items || []).map((item: Record<string, unknown>) => ({
        id: String(item.connectionId), connectionId: String(item.connectionId), name: String(item.name),
        engine: `MySQL ${String(item.version || "8+").split("-")[0]}`, host: `${String(item.host)}:${Number(item.port)}`,
        database: String(item.database), tables: Number(item.tables || 0), status: "connected" as const, sshEnabled: Boolean(item.sshEnabled),
      }));
      setSources(restored); if (restored.length) setActiveSourceId(restored[0].id); void hydrateInsights(restored);
    } catch (restoreError) { setConnectionNotice(message(restoreError, "无法恢复数据源")); }
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
  const filteredHistory = useMemo(() => history.filter((item) => item.question.toLowerCase().includes(historySearch.toLowerCase())), [history, historySearch]);
  const maxChart = Math.max(...(result?.chart?.map((item) => item.value) ?? [1]));
  const viewTitles: Record<View, [string, string]> = {
    chat: ["数据问答", "从 ERP 语义理解到安全 SQL 的可解释问数"], sources: ["数据源", "查看数据库连接与 ERP Schema 理解状态"],
    "source-detail": [activeSource?.name || "数据源详情", "ERP Schema Mapping、Join Path 与验证结果"],
    database: [activeSource?.name || "数据库编辑台", "浏览数据结构并通过自然语言或 SQL 操作数据"], history: ["查询历史", "查看、检索并复用过去的分析"],
  };

  function saveHistory(items: HistoryItem[]) { setHistory(items); localStorage.setItem("datapilot-history", JSON.stringify(items.slice(0, 50))); }

  async function ask(text?: string) {
    const query = (text ?? question).trim();
    if (!activeSource) { setError("请先添加并连接一个数据源"); setView("sources"); return; }
    if (!query || loading) return;
    setQuestion(query); setLoading(true); setError(""); setResult(null); if (view !== "database") setView("chat");
    try {
      const response = await fetch(`${API_BASE}/api/query`, { method: "POST", headers: agentHeaders(), body: JSON.stringify({ question: query, connectionId: activeSource.connectionId }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "查询失败");
      if (data.requiresConfirmation) { setPendingSql({ sql: data.sql, operation: data.operation, origin: "natural" }); setResult(data); return; }
      setResult(data); const entry: HistoryItem = { id: crypto.randomUUID(), question: query, createdAt: new Date().toISOString(), rowCount: data.rowCount, executionMs: data.executionMs, result: data };
      saveHistory([entry, ...history.filter((item) => item.question !== query)]);
    } catch (queryError) { setError(message(queryError, "查询失败")); } finally { setLoading(false); }
  }

  async function fetchMapping(source: DataSource, samples: boolean) {
    const response = await fetch(`${API_BASE}/api/datasources/${encodeURIComponent(source.connectionId)}/schema-mapping?samples=${samples ? "1" : "0"}`); const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取 ERP Schema Mapping 失败"); return data as SchemaMappingResponse;
  }

  async function openSourceDetail(source: DataSource, tab: DetailTab = "overview", entity = "") {
    setActiveSourceId(source.id); setView("source-detail"); setDetailTab(tab); setFocusedEntity(entity); setMappingLoading(true); setMappingError("");
    try {
      const detail = await fetchMapping(source, true); setMapping(detail); setSources((items) => items.map((item) => item.id === source.id ? { ...item, insight: detail } : item));
      if (entity) setTimeout(() => document.getElementById(`entity-${entity}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 60);
    } catch (detailError) { setMapping(null); setMappingError(message(detailError, "读取 ERP Schema Mapping 失败")); } finally { setMappingLoading(false); }
  }

  async function addConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setConnecting(true); setConnectionNotice("");
    try {
      const form = new FormData(event.currentTarget); const keyFile = form.get("sshKey") as File | null;
      const config = { name: String(form.get("name") || ""), engine: "mysql", host: String(form.get("host") || ""), port: Number(form.get("port")), database: String(form.get("database") || ""), user: String(form.get("user") || ""), password: String(form.get("password") || ""), ssh: sshEnabled ? { enabled: true, host: String(form.get("sshHost") || ""), port: Number(form.get("sshPort")), user: String(form.get("sshUser") || ""), privateKey: keyFile?.size ? await keyFile.text() : "", passphrase: String(form.get("sshPassphrase") || "") } : undefined };
      const response = await fetch(`${API_BASE}/api/connections`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) }); const data = await response.json();
      if (!response.ok) throw new Error(data.error || "连接失败");
      const source: DataSource = { id: data.connectionId, connectionId: data.connectionId, name: data.name, engine: `MySQL ${String(data.version).split("-")[0]}`, host: `${data.host}:${data.port}`, database: data.database, tables: data.tables, status: "connected", sshEnabled: data.sshEnabled };
      setSources((items) => [...items, source]); setActiveSourceId(source.id); setShowAddSource(false); setSshEnabled(false); setConnectionNotice(`连接成功 · ${data.tables} 张表 · ${data.latencyMs} ms`); await openSourceDetail(source);
    } catch (connectionError) { setConnectionNotice(message(connectionError, "连接失败")); } finally { setConnecting(false); }
  }

  async function testConnection(source: DataSource) {
    setTestingSource(source.id); setConnectionNotice("");
    try {
      const response = await fetch(`${API_BASE}/api/connections/${source.connectionId}/test`, { method: "POST" }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "连接失败");
      setSources((items) => items.map((item) => item.id === source.id ? { ...item, status: "connected", tables: data.tables } : item)); setConnectionNotice(`连接成功 · ${data.tables} 张表 · ${data.latencyMs} ms`);
    } catch (connectionError) { setSources((items) => items.map((item) => item.id === source.id ? { ...item, status: "offline" } : item)); setConnectionNotice(message(connectionError, "连接失败")); } finally { setTestingSource(null); }
  }

  async function loadSchema(connectionId = activeSource?.connectionId) {
    if (!connectionId) throw new Error("请先连接数据源"); const response = await fetch(`${API_BASE}/api/database/schema?connectionId=${encodeURIComponent(connectionId)}`); const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取 Schema 失败"); setServerSchema(data.tables || []);
  }
  function openDatabase(source: DataSource) { setActiveSourceId(source.id); setView("database"); setServerSchema([]); setSqlResult(null); setPendingSql(null); void loadSchema(source.connectionId).catch((e) => setConnectionNotice(e.message)); }

  async function runSql(confirm = false) {
    if (!activeSource || !sqlText.trim() || sqlRunning) return; setSqlRunning(true); setConnectionNotice("");
    try {
      const requested = confirm && pendingSql ? pendingSql.sql : sqlText; const response = await fetch(`${API_BASE}/api/database/query`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql: requested, connectionId: activeSource.connectionId, confirm }) }); const data = await response.json();
      if (!response.ok) throw new Error(data.error || "SQL 执行失败");
      if (data.requiresConfirmation) { setPendingSql({ sql: data.sql, operation: data.operation, origin: "console" }); setSqlResult(null); }
      else { setSqlResult(data); setPendingSql(null); if (confirm) { setConnectionNotice(`执行成功 · ${data.operation} 影响 ${data.affectedRows ?? 0} 行`); await loadSchema(); } }
    } catch (sqlError) { setConnectionNotice(message(sqlError, "SQL 执行失败")); } finally { setSqlRunning(false); }
  }

  async function removeSource(source: DataSource) { await fetch(`${API_BASE}/api/connections/${source.connectionId}`, { method: "DELETE" }).catch(() => undefined); const remaining = sources.filter((item) => item.id !== source.id); setSources(remaining); setActiveSourceId(remaining[0]?.id || ""); setMapping(null); }

  return <main className="app-shell">
    <aside className="sidebar"><div className="brand"><span className="brand-mark">D</span><span>DataPilot</span></div><button className="new-chat" onClick={() => { setQuestion(""); setResult(null); setError(""); setView("chat"); }}>＋ 新建对话</button><nav aria-label="主导航"><button className={`nav-item ${view === "chat" ? "active" : ""}`} onClick={() => setView("chat")}><span>⌁</span>数据问答</button><button className={`nav-item ${view === "sources" || view === "source-detail" ? "active" : ""}`} onClick={() => setView("sources")}><span>▦</span>数据源</button><button className={`nav-item ${view === "history" ? "active" : ""}`} onClick={() => setView("history")}><span>◷</span>查询历史{history.length > 0 && <em>{history.length}</em>}</button></nav>{activeSource ? <DatasourceStatusCard source={activeSource} onClick={() => void openSourceDetail(activeSource)} /> : <button className="source-card" onClick={() => setView("sources")}><span className="source-title"><span className="status-dot offline" />未连接数据源<b>›</b></span><span className="source-meta">点击添加客户数据库</span></button>}<div className="sidebar-bottom"><button className="plain-button">⚙ <span>工作区设置</span></button><div className="profile"><span className="avatar">陈</span><span><strong>陈宇</strong><small>数据分析团队</small></span><span className="more">•••</span></div></div></aside>

    <section className="workspace"><header className="topbar"><div><h1>{viewTitles[view][0]}</h1><p>{viewTitles[view][1]}</p></div><div className="top-actions"><span className="connection"><i className={activeSource ? "" : "offline"} />{activeSource ? sourceState(activeSource).title : "等待连接"}</span><button aria-label="帮助">?</button></div></header>
      {view === "chat" && <ChatView activeSource={activeSource} question={question} setQuestion={setQuestion} ask={ask} loading={loading} error={error} result={result} maxChart={maxChart} openSources={() => setView("sources")} addSource={() => { setShowAddSource(true); setView("sources"); }} inspect={(tab, entity) => activeSource && void openSourceDetail(activeSource, tab, entity)} />}
      {view === "sources" && <SourcesView sources={sources} activeSourceId={activeSourceId} testingSource={testingSource} notice={connectionNotice} add={() => { setConnectionNotice(""); setShowAddSource(true); }} open={(source) => void openSourceDetail(source)} test={testConnection} workbench={openDatabase} remove={removeSource} />}
      {view === "source-detail" && activeSource && <DatasourceDetail source={activeSource} mapping={mapping} loading={mappingLoading} error={mappingError} tab={detailTab} focusedEntity={focusedEntity} onTab={setDetailTab} onBack={() => setView("sources")} onOpenWorkbench={() => openDatabase(activeSource)} onRefresh={() => void openSourceDetail(activeSource, detailTab, focusedEntity)} />}
      {view === "database" && activeSource && <DatabaseWorkbench source={activeSource} schema={serverSchema} mode={dbMode} setMode={setDbMode} question={question} setQuestion={setQuestion} ask={ask} loading={loading} error={error} result={result} sqlText={sqlText} setSqlText={setSqlText} sqlResult={sqlResult} sqlRunning={sqlRunning} runSql={() => void runSql()} notice={connectionNotice} pendingSql={pendingSql} cancelPending={() => setPendingSql(null)} confirmWrite={() => void runSql(true)} back={() => void openSourceDetail(activeSource)} setNotice={setConnectionNotice} loadSchema={loadSchema} />}
      {view === "history" && <HistoryView history={history} filtered={filteredHistory} search={historySearch} setSearch={setHistorySearch} clear={() => saveHistory([])} open={(item) => { setResult(item.result); setQuestion(item.question); setView("chat"); }} rerun={(item) => void ask(item.question)} remove={(id) => saveHistory(history.filter((item) => item.id !== id))} start={() => setView("chat")} />}
    </section>
    {showAddSource && <ConnectionModal sshEnabled={sshEnabled} setSshEnabled={setSshEnabled} connecting={connecting} notice={connectionNotice} close={() => setShowAddSource(false)} submit={addConnection} />}
  </main>;
}

function ChatView({ activeSource, question, setQuestion, ask, loading, error, result, maxChart, openSources, addSource, inspect }: { activeSource?: DataSource; question: string; setQuestion: (v: string) => void; ask: (v?: string) => Promise<void>; loading: boolean; error: string; result: QueryResult | null; maxChart: number; openSources: () => void; addSource: () => void; inspect: (tab: DetailTab, entity?: string) => void }) { return <div className="content"><section className="hero-copy"><div className="eyebrow">ERP FINANCE DATA AGENT</div><h2>今天想了解什么？</h2><p>DataPilot 会先理解数据库结构和 ERP 语义，再生成并执行安全 SQL。</p></section><form className="query-box" onSubmit={(event) => { event.preventDefault(); void ask(); }}><textarea aria-label="输入数据问题" value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask(); } }} placeholder={activeSource ? "例如：本月营业收入是多少？" : "请先添加一个数据源"} rows={2} disabled={!activeSource} /><div className="query-footer"><button className="source-selector" type="button" onClick={openSources}><span />{activeSource?.name || "选择数据源"}⌄</button><button className="send-button" type="submit" disabled={loading || !question.trim() || !activeSource}>{loading ? "分析中…" : "发送 ↗"}</button></div></form><div className="suggestions">{suggestions.map((item) => <button key={item} onClick={() => void ask(item)} disabled={!activeSource}>{item}<span>↗</span></button>)}</div><AgentTracePanel loading={loading} />{error && <BusinessErrorCard message={error} source={activeSource} onInspect={inspect} />}{!activeSource && <div className="empty-state compact"><span>▦</span><h3>还没有数据源</h3><p>由客户填写数据库地址、账号和密码，连接后即可开始 ERP 智能问数。</p><button onClick={addSource}>添加数据源</button></div>}{result && <section className="result-card" aria-live="polite"><div className="result-head"><div><span className="answer-badge">✓</span><div><h3>{result.explanation?.metrics[0]?.name || "分析完成"}</h3><p>{result.question}</p></div></div><span className="runtime">{result.executionMs} ms</span></div><div className="summary"><span>✦</span><p>{result.summary}</p></div>{result.chart && <div className="chart-wrap"><div className="chart-head"><h4>核心指标</h4></div><div className="bar-chart">{result.chart.map((item, index) => <div className="bar-column" key={`${item.label}-${index}`}><span className="bar-value">{item.value}</span><div className="bar" style={{ height: `${Math.max(18, (item.value / maxChart) * 100)}%` }} /><span className="bar-label">{item.label}</span></div>)}</div></div>}<ResultTable result={result} /><AnswerExplanation explanation={result.explanation} sql={result.sql} trace={result.agent?.trace} /></section>}</div>; }

function SourcesView({ sources, activeSourceId, testingSource, notice, add, open, test, workbench, remove }: { sources: DataSource[]; activeSourceId: string; testingSource: string | null; notice: string; add: () => void; open: (s: DataSource) => void; test: (s: DataSource) => Promise<void>; workbench: (s: DataSource) => void; remove: (s: DataSource) => Promise<void> }) { return <div className="module-content sources-page"><div className="module-heading"><div><span className="eyebrow">ERP DATA CONNECTIONS</span><h2>连接并理解客户的业务数据</h2><p>每个数据源独立维护 ERP Mapping 与 Join Registry。</p></div><button className="primary-action" onClick={add}>＋ 添加数据源</button></div>{sources.length === 0 ? <div className="empty-state source-empty"><span>＋</span><h3>添加第一个数据源</h3><p>连接后自动分析 ERP Schema。</p><button onClick={add}>配置连接</button></div> : <div className="source-grid">{sources.map((source) => { const state = sourceState(source); return <article className={`db-card ${activeSourceId === source.id ? "selected" : ""}`} key={source.id} onClick={() => open(source)}><div className="db-card-top"><span className="db-icon">ERP</span><span className={`source-status ${state.tone}`}>{state.title}</span></div><h3>{source.name}</h3><p>{source.engine} · {source.insight ? erpLabel(source.insight.erpType) : "待分析"}<br />{source.host} / {source.database}</p><div className="db-stats semantic"><span><strong>{source.insight?.semanticSchema.length || 0} / 9</strong> ERP 实体</span><span><strong>{Math.round((source.insight?.mappingConfidence || 0) * 100)}%</strong> Mapping</span><span><strong>{source.insight?.joinPaths.length || 0}</strong> Validated Join</span></div><div className="db-open">查看 ERP Schema 理解详情 →</div><div className="db-actions"><button onClick={(event) => { event.stopPropagation(); void test(source); }}>{testingSource === source.id ? "测试中…" : "测试连接"}</button><button onClick={(event) => { event.stopPropagation(); workbench(source); }}>数据库编辑台</button><button onClick={(event) => { event.stopPropagation(); void remove(source); }}>移除</button></div></article>; })}</div>}{notice && <div className={`connection-notice ${notice.startsWith("连接成功") ? "success" : ""}`}>{notice}</div>}</div>; }

function DatabaseWorkbench(p: { source: DataSource; schema: SchemaTable[]; mode: "natural" | "sql"; setMode: (v: "natural" | "sql") => void; question: string; setQuestion: (v: string) => void; ask: () => Promise<void>; loading: boolean; error: string; result: QueryResult | null; sqlText: string; setSqlText: (v: string) => void; sqlResult: SqlResult | null; sqlRunning: boolean; runSql: () => void; notice: string; pendingSql: PendingSql | null; cancelPending: () => void; confirmWrite: () => void; back: () => void; setNotice: (v: string) => void; loadSchema: () => Promise<void> }) { return <div className="database-workbench"><aside className="db-explorer"><div className="explorer-head"><button onClick={p.back}>← 数据源详情</button><h3>{p.source.database}</h3><p>{p.source.host}</p></div><div className="explorer-label"><span>原始数据表</span><button onClick={() => void p.loadSchema().catch((e) => p.setNotice(e.message))}>↻</button></div>{p.schema.length ? <div className="table-tree">{p.schema.map((table) => <button key={table.name} onClick={() => { p.setSqlText(`SELECT * FROM \`${table.name}\` LIMIT 100`); p.setMode("sql"); }}><span>▦</span><div><strong>{table.name}</strong><small>{table.rows.toLocaleString()} 行 · {table.columns.length} 列</small></div><em>›</em></button>)}</div> : <div className="explorer-empty">正在读取表结构…</div>}</aside><section className="db-editor"><div className="db-editor-head"><div><span className="source-status connected">已连接</span><h2>{p.source.name}</h2><p>{p.source.engine} · {p.source.sshEnabled ? "SSH 隧道" : "TCP 直连"}</p></div></div><div className="editor-tabs"><button className={p.mode === "natural" ? "active" : ""} onClick={() => p.setMode("natural")}>✦ 自然语言</button><button className={p.mode === "sql" ? "active" : ""} onClick={() => p.setMode("sql")}>⌘ SQL 编辑器</button></div>{p.notice && <div className={`connection-notice ${p.notice.startsWith("执行成功") ? "success" : ""}`}>{p.notice}</div>}{p.pendingSql && <div className="write-confirm"><div><span>需要确认</span><h3>{p.pendingSql.operation} 将修改数据库</h3><p>请核对 SQL 和 WHERE 条件。</p></div><pre><code>{p.pendingSql.sql}</code></pre><div><button onClick={p.cancelPending}>取消</button><button className="danger-confirm" onClick={p.confirmWrite} disabled={p.sqlRunning}>{p.sqlRunning ? "执行中…" : `确认执行 ${p.pendingSql.operation}`}</button></div></div>}{p.mode === "natural" ? <div className="natural-panel"><h3>用自然语言操作数据库</h3><p>问数请求会经过 ERP 指标、Schema Mapping、Join Path 与 SQL Safety。</p><form onSubmit={(event) => { event.preventDefault(); void p.ask(); }}><textarea value={p.question} onChange={(event) => p.setQuestion(event.target.value)} placeholder="例如：本月营业收入是多少？" /><button disabled={!p.question.trim() || p.loading}>{p.loading ? "生成中…" : "生成并运行"}</button></form>{p.error && <div className="error-message">{p.error}</div>}{p.result && <><div className="summary"><span>✦</span><p>{p.result.summary}</p></div><ResultTable result={p.result} /><AnswerExplanation explanation={p.result.explanation} sql={p.result.sql} trace={p.result.agent?.trace} /></>}</div> : <section className="sql-console workbench-console"><div className="schema-head"><div><h3>SQL 编辑器</h3><p>支持 SELECT、INSERT、UPDATE、DELETE；写操作执行前必须确认</p></div><span className="schema-sync">最多返回 200 行</span></div><textarea value={p.sqlText} onChange={(event) => p.setSqlText(event.target.value)} spellCheck={false} /><div className="sql-console-actions"><button onClick={p.runSql} disabled={p.sqlRunning}>{p.sqlRunning ? "执行中…" : "▶ 执行 SQL"}</button></div>{p.sqlResult && <SqlResultTable result={p.sqlResult} />}</section>}</section></div>; }

function HistoryView({ history, filtered, search, setSearch, clear, open, rerun, remove, start }: { history: HistoryItem[]; filtered: HistoryItem[]; search: string; setSearch: (v: string) => void; clear: () => void; open: (i: HistoryItem) => void; rerun: (i: HistoryItem) => void; remove: (id: string) => void; start: () => void }) { return <div className="module-content history-page"><div className="module-heading"><div><span className="eyebrow">QUERY LIBRARY</span><h2>查询历史</h2><p>找回过去的问题，一键重新分析最新数据。</p></div>{history.length > 0 && <button className="danger-action" onClick={clear}>清空历史</button>}</div><div className="history-toolbar"><label><span>⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索历史问题…" /></label><span>共 {filtered.length} 条记录</span></div>{filtered.length === 0 ? <div className="empty-state"><span>◷</span><h3>还没有查询历史</h3><p>完成第一次数据问答后，记录会出现在这里。</p><button onClick={start}>开始提问</button></div> : <div className="history-list">{filtered.map((item) => <article className="history-item" key={item.id}><span className="history-icon">⌁</span><div className="history-main"><h3>{item.question}</h3><p>{formatDate(item.createdAt)} · {item.rowCount} 行结果 · {item.executionMs} ms</p><span>{item.result.summary}</span></div><div className="history-actions"><button onClick={() => open(item)}>查看结果</button><button className="rerun" onClick={() => rerun(item)}>重新运行 ↗</button><button onClick={() => remove(item.id)}>×</button></div></article>)}</div>}</div>; }

function ConnectionModal({ sshEnabled, setSshEnabled, connecting, notice, close, submit }: { sshEnabled: boolean; setSshEnabled: (v: boolean) => void; connecting: boolean; notice: string; close: () => void; submit: (e: FormEvent<HTMLFormElement>) => Promise<void> }) { return <div className="modal-backdrop" onMouseDown={() => !connecting && close()}><form className="source-modal source-modal-wide" onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => void submit(e)}><div className="modal-head"><div><h2>添加数据源</h2><p>由客户填写连接信息；密码与私钥由服务端加密保存。</p></div><button type="button" onClick={close}>×</button></div><div className="connection-form-grid"><label>连接名称<input name="name" required /></label><label>数据库类型<select name="engine"><option>MySQL 8+</option></select></label><label className="span-two">主机名或 IP<input name="host" required /></label><label>端口<input name="port" type="number" defaultValue="3306" required /></label><label>数据库名<input name="database" required /></label><label>用户名<input name="user" required autoComplete="username" /></label><label>密码<input name="password" type="password" required autoComplete="current-password" /></label></div><label className="ssh-switch"><input type="checkbox" checked={sshEnabled} onChange={(e) => setSshEnabled(e.target.checked)} /><span><strong>通过 SSH 隧道连接</strong><small>适用于数据库仅能从跳板机访问的情况</small></span></label>{sshEnabled && <div className="ssh-fields"><div className="connection-form-grid"><label className="span-two">SSH 主机名或 IP<input name="sshHost" required /></label><label>SSH 端口<input name="sshPort" type="number" defaultValue="22" required /></label><label>SSH 用户名<input name="sshUser" required /></label><label className="span-two">SSH 私钥文件<input name="sshKey" type="file" required /></label><label className="span-two">私钥口令（可选）<input name="sshPassphrase" type="password" /></label></div></div>}{notice && <div className="connection-notice modal-notice">{notice}</div>}<div className="modal-actions"><button type="button" onClick={close}>取消</button><button className="primary-action" type="submit" disabled={connecting}>{connecting ? "正在测试连接…" : "测试并连接"}</button></div></form></div>; }

function ResultTable({ result }: { result: QueryResult }) { return <div className="table-section"><div className="table-toolbar"><h4>查询结果 <span>{result.rowCount} 行</span></h4><button onClick={() => downloadCsv(result)}>⇩ 导出 CSV</button></div><div className="table-scroll"><table><thead><tr>{result.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead><tbody>{result.rows.map((row, i) => <tr key={i}>{result.columns.map((c) => <td key={c.key}>{row[c.key]}</td>)}</tr>)}</tbody></table></div></div>; }
function SqlResultTable({ result }: { result: SqlResult }) { return <div className="sql-result"><div className="table-toolbar"><h4>执行结果 <span>{result.rowCount} 行 · {result.executionMs} ms</span></h4></div><div className="table-scroll"><table><thead><tr>{result.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead><tbody>{result.rows.map((row, i) => <tr key={i}>{result.columns.map((c) => <td key={c.key}>{String(row[c.key] ?? "")}</td>)}</tr>)}</tbody></table></div></div>; }
function message(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
function formatDate(date: string) { return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(date)); }
function downloadCsv(result: QueryResult) { const header = result.columns.map((c) => c.label).join(","); const body = result.rows.map((row) => result.columns.map((c) => `"${String(row[c.key]).replaceAll('"', '""')}"`).join(",")).join("\n"); const blob = new Blob(["\ufeff" + header + "\n" + body], { type: "text/csv;charset=utf-8" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "datapilot-result.csv"; a.click(); URL.revokeObjectURL(a.href); }
