"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type View = "chat" | "sources" | "history";
type QueryResult = { question: string; summary: string; sql: string; columns: { key: string; label: string }[]; rows: Record<string, string | number>[]; chart?: { label: string; value: number }[]; executionMs: number; rowCount: number };
type HistoryItem = { id: string; question: string; createdAt: string; rowCount: number; executionMs: number; result: QueryResult };
type DataSource = { id: string; connectionId: string; name: string; engine: string; host: string; database: string; tables: number; status: "connected" | "offline"; sshEnabled: boolean };
type SchemaTable = { name: string; rows: number; columns: { name: string; type: string; nullable: boolean; key: string; comment: string }[] };
type SqlResult = { sql: string; columns: { key: string; label: string }[]; rows: Record<string, unknown>[]; rowCount: number; executionMs: number };

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001";
const suggestions = ["本月收入和支出分别是多少？", "按月展示今年的利润趋势", "金额最高的 10 笔交易是什么？"];

export default function Home() {
  const [view, setView] = useState<View>("sources");
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showSql, setShowSql] = useState(true);
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

  useEffect(() => {
    const saved = localStorage.getItem("datapilot-history");
    if (saved) { try { setHistory(JSON.parse(saved)); } catch { localStorage.removeItem("datapilot-history"); } }
  }, []);

  const activeSource = sources.find((source) => source.id === activeSourceId);
  const filteredHistory = useMemo(() => history.filter((item) => item.question.toLowerCase().includes(historySearch.toLowerCase())), [history, historySearch]);
  const maxChart = Math.max(...(result?.chart?.map((item) => item.value) ?? [1]));
  const viewTitles: Record<View, [string, string]> = { chat: ["数据问答", "用自然语言探索你的业务数据"], sources: ["数据源", "由客户管理数据库连接与业务表结构"], history: ["查询历史", "查看、检索并复用过去的分析"] };

  function saveHistory(items: HistoryItem[]) { setHistory(items); localStorage.setItem("datapilot-history", JSON.stringify(items.slice(0, 50))); }

  async function ask(text?: string) {
    const query = (text ?? question).trim();
    if (!activeSource) { setError("请先添加并连接一个数据源"); setView("sources"); return; }
    if (!query || loading) return;
    setQuestion(query); setLoading(true); setError(""); setView("chat");
    try {
      const response = await fetch(`${API_BASE}/api/query`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: query, connectionId: activeSource.connectionId }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "查询失败");
      setResult(data);
      const entry: HistoryItem = { id: crypto.randomUUID(), question: query, createdAt: new Date().toISOString(), rowCount: data.rowCount, executionMs: data.executionMs, result: data };
      saveHistory([entry, ...history.filter((item) => item.question !== query)]);
    } catch (queryError) { setError(queryError instanceof Error ? queryError.message : "查询失败"); }
    finally { setLoading(false); }
  }

  async function addConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setConnecting(true); setConnectionNotice("");
    try {
      const form = new FormData(event.currentTarget);
      const keyFile = form.get("sshKey") as File | null;
      const config = {
        name: String(form.get("name") || ""), engine: "mysql",
        host: String(form.get("host") || ""), port: Number(form.get("port")), database: String(form.get("database") || ""),
        user: String(form.get("user") || ""), password: String(form.get("password") || ""),
        ssh: sshEnabled ? { enabled: true, host: String(form.get("sshHost") || ""), port: Number(form.get("sshPort")), user: String(form.get("sshUser") || ""), privateKey: keyFile?.size ? await keyFile.text() : "", passphrase: String(form.get("sshPassphrase") || "") } : undefined,
      };
      const response = await fetch(`${API_BASE}/api/connections`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "连接失败");
      const source: DataSource = { id: crypto.randomUUID(), connectionId: data.connectionId, name: data.name, engine: `MySQL ${String(data.version).split("-")[0]}`, host: `${data.host}:${data.port}`, database: data.database, tables: data.tables, status: "connected", sshEnabled: data.sshEnabled };
      setSources((items) => [...items, source]); setActiveSourceId(source.id); setShowAddSource(false); setSshEnabled(false);
      setConnectionNotice(`连接成功 · ${data.tables} 张表 · ${data.latencyMs} ms`);
      await loadSchema(source.connectionId);
    } catch (connectionError) { setConnectionNotice(connectionError instanceof Error ? connectionError.message : "连接失败"); }
    finally { setConnecting(false); }
  }

  async function testConnection(source: DataSource) {
    setTestingSource(source.id); setConnectionNotice("");
    try {
      const response = await fetch(`${API_BASE}/api/connections/${source.connectionId}/test`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "连接失败");
      setSources((items) => items.map((item) => item.id === source.id ? { ...item, status: "connected", tables: data.tables } : item));
      setConnectionNotice(`连接成功 · ${data.tables} 张表 · ${data.latencyMs} ms`);
      await loadSchema(source.connectionId);
    } catch (connectionError) {
      setSources((items) => items.map((item) => item.id === source.id ? { ...item, status: "offline" } : item));
      setConnectionNotice(connectionError instanceof Error ? connectionError.message : "连接失败");
    } finally { setTestingSource(null); }
  }

  async function loadSchema(connectionId = activeSource?.connectionId) {
    if (!connectionId) throw new Error("请先连接数据源");
    const response = await fetch(`${API_BASE}/api/database/schema?connectionId=${encodeURIComponent(connectionId)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取 Schema 失败");
    setServerSchema(data.tables || []);
  }

  async function runSql() {
    if (!activeSource) { setConnectionNotice("请先连接数据源"); return; }
    if (!sqlText.trim() || sqlRunning) return;
    setSqlRunning(true); setConnectionNotice("");
    try {
      const response = await fetch(`${API_BASE}/api/database/query`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql: sqlText, connectionId: activeSource.connectionId }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "SQL 执行失败");
      setSqlResult(data);
    } catch (sqlError) { setConnectionNotice(sqlError instanceof Error ? sqlError.message : "SQL 执行失败"); }
    finally { setSqlRunning(false); }
  }

  async function removeSource(source: DataSource) {
    await fetch(`${API_BASE}/api/connections/${source.connectionId}`, { method: "DELETE" }).catch(() => undefined);
    const remaining = sources.filter((item) => item.id !== source.id); setSources(remaining); setActiveSourceId(remaining[0]?.id || ""); setServerSchema([]); setSqlResult(null);
  }

  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">D</span><span>DataPilot</span></div>
      <button className="new-chat" onClick={() => { setQuestion(""); setResult(null); setView("chat"); }}>＋ 新建对话</button>
      <nav aria-label="主导航">
        <button className={`nav-item ${view === "chat" ? "active" : ""}`} onClick={() => setView("chat")}><span>⌁</span>数据问答</button>
        <button className={`nav-item ${view === "sources" ? "active" : ""}`} onClick={() => setView("sources")}><span>▦</span>数据源</button>
        <button className={`nav-item ${view === "history" ? "active" : ""}`} onClick={() => setView("history")}><span>◷</span>查询历史{history.length > 0 && <em>{history.length}</em>}</button>
      </nav>
      <button className="source-card" onClick={() => setView("sources")}><span className="source-title"><span className={`status-dot ${activeSource?.status || "offline"}`} />{activeSource?.name || "未连接数据源"}</span><span className="source-meta">{activeSource ? `${activeSource.engine} · 已连接` : "点击添加客户数据库"}</span>{activeSource && <span className="source-stats"><span>{activeSource.tables} 张表</span><span>{activeSource.sshEnabled ? "SSH 隧道" : "直连"}</span></span>}</button>
      <div className="sidebar-bottom"><button className="plain-button">⚙ <span>工作区设置</span></button><div className="profile"><span className="avatar">陈</span><span><strong>陈宇</strong><small>数据分析团队</small></span><span className="more">•••</span></div></div>
    </aside>

    <section className="workspace">
      <header className="topbar"><div><h1>{viewTitles[view][0]}</h1><p>{viewTitles[view][1]}</p></div><div className="top-actions"><span className="connection"><i className={activeSource ? "" : "offline"} />{activeSource ? "数据源已就绪" : "等待连接"}</span><button aria-label="帮助">?</button></div></header>

      {view === "chat" && <div className="content">
        <section className="hero-copy"><div className="eyebrow">AI DATA ANALYST</div><h2>今天想了解什么？</h2><p>连接客户数据库后，用自然语言生成并执行只读 SQL。</p></section>
        <form className="query-box" onSubmit={(event) => { event.preventDefault(); void ask(); }}><textarea aria-label="输入数据问题" value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask(); } }} placeholder={activeSource ? "例如：本月收入和支出分别是多少？" : "请先添加一个数据源"} rows={2} disabled={!activeSource} /><div className="query-footer"><button className="source-selector" type="button" onClick={() => setView("sources")}><span />{activeSource?.name || "选择数据源"}⌄</button><button className="send-button" type="submit" disabled={loading || !question.trim() || !activeSource}>{loading ? "分析中…" : "发送 ↗"}</button></div></form>
        <div className="suggestions">{suggestions.map((item) => <button key={item} onClick={() => void ask(item)} disabled={!activeSource}>{item}<span>↗</span></button>)}</div>
        {error && <div className="error-message">{error}</div>}
        {!activeSource && <div className="empty-state compact"><span>▦</span><h3>还没有数据源</h3><p>由客户填写数据库地址、账号和密码，连接成功后即可开始问数。</p><button onClick={() => { setShowAddSource(true); setView("sources"); }}>添加数据源</button></div>}
        {result && <section className={`result-card ${loading ? "is-loading" : ""}`} aria-live="polite"><div className="result-head"><div><span className="answer-badge">✓</span><div><h3>分析完成</h3><p>{result.question}</p></div></div><span className="runtime">{result.executionMs} ms</span></div><div className="summary"><span>✦</span><p>{result.summary}</p></div>{result.chart && <div className="chart-wrap"><div className="chart-head"><h4>核心指标</h4></div><div className="bar-chart">{result.chart.map((item) => <div className="bar-column" key={item.label}><span className="bar-value">{item.value}</span><div className="bar" style={{ height: `${Math.max(18, (item.value / maxChart) * 100)}%` }} /><span className="bar-label">{item.label}</span></div>)}</div></div>}<ResultTable result={result} /><div className="sql-block"><button className="sql-toggle" onClick={() => setShowSql((value) => !value)}><span>⌘</span> 生成的 SQL <i>{showSql ? "⌃" : "⌄"}</i></button>{showSql && <div className="code-wrap"><pre><code>{result.sql}</code></pre><button className="copy" onClick={() => void navigator.clipboard.writeText(result.sql)}>复制</button></div>}</div></section>}
      </div>}

      {view === "sources" && <div className="module-content sources-page">
        <div className="module-heading"><div><span className="eyebrow">DATA CONNECTIONS</span><h2>连接客户的业务数据</h2><p>连接凭据只保存在当前服务内存中，不写入浏览器或环境变量。</p></div><button className="primary-action" onClick={() => { setConnectionNotice(""); setShowAddSource(true); }}>＋ 添加数据源</button></div>
        {sources.length === 0 ? <div className="empty-state source-empty"><span>＋</span><h3>添加第一个数据源</h3><p>支持 MySQL 8 直连，也支持通过 SSH 私钥建立安全隧道。</p><button onClick={() => setShowAddSource(true)}>配置连接</button></div> : <div className="source-grid">{sources.map((source) => <article className={`db-card ${activeSourceId === source.id ? "selected" : ""}`} key={source.id} onClick={() => { setActiveSourceId(source.id); setServerSchema([]); void loadSchema(source.connectionId).catch((e) => setConnectionNotice(e.message)); }}><div className="db-card-top"><span className="db-icon">MY</span><span className={`source-status ${source.status}`}>{source.status === "connected" ? "已连接" : "离线"}</span></div><h3>{source.name}</h3><p>{source.host} / {source.database}</p><div className="db-stats"><span><strong>{source.tables}</strong> 张表</span><span><strong>{source.sshEnabled ? "SSH" : "TCP"}</strong> 连接方式</span></div><div className="db-actions"><button onClick={(event) => { event.stopPropagation(); void testConnection(source); }}>{testingSource === source.id ? "测试中…" : "测试连接"}</button><button onClick={(event) => { event.stopPropagation(); void removeSource(source); }}>移除</button></div></article>)}</div>}
        {connectionNotice && <div className={`connection-notice ${connectionNotice.startsWith("连接成功") ? "success" : ""}`}>{connectionNotice}</div>}
        {activeSource && <><section className="schema-panel"><div className="schema-head"><div><h3>{activeSource.name} · 数据结构</h3><p>{activeSource.host} / {activeSource.database}</p></div><button className="schema-refresh" onClick={() => void loadSchema().catch((e) => setConnectionNotice(e.message))}>↻ 刷新 Schema</button></div>{serverSchema.length ? <div className="schema-list">{serverSchema.map((table) => <div className="schema-row" key={table.name}><span className="table-symbol">▦</span><div><strong>{table.name}</strong><small>{table.columns.map((column) => `${column.name} ${column.type}`).join(", ")}</small></div><span>{table.rows.toLocaleString()} 行</span></div>)}</div> : <div className="schema-loading">选择“刷新 Schema”读取真实表结构</div>}</section><section className="sql-console"><div className="schema-head"><div><h3>SQL 控制台</h3><p>仅允许 SELECT、SHOW、DESCRIBE 和 EXPLAIN，最多返回 200 行</p></div><span className="schema-sync">{activeSource.engine}</span></div><textarea value={sqlText} onChange={(event) => setSqlText(event.target.value)} spellCheck={false} /><div className="sql-console-actions"><button onClick={() => void runSql()} disabled={sqlRunning}>{sqlRunning ? "执行中…" : "▶ 执行 SQL"}</button></div>{sqlResult && <SqlResultTable result={sqlResult} />}</section></>}
      </div>}

      {view === "history" && <div className="module-content history-page"><div className="module-heading"><div><span className="eyebrow">QUERY LIBRARY</span><h2>查询历史</h2><p>找回过去的问题，一键重新分析最新数据。</p></div>{history.length > 0 && <button className="danger-action" onClick={() => saveHistory([])}>清空历史</button>}</div><div className="history-toolbar"><label><span>⌕</span><input value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder="搜索历史问题…" /></label><span>共 {filteredHistory.length} 条记录</span></div>{filteredHistory.length === 0 ? <div className="empty-state"><span>◷</span><h3>还没有查询历史</h3><p>完成第一次数据问答后，记录会出现在这里。</p><button onClick={() => setView("chat")}>开始提问</button></div> : <div className="history-list">{filteredHistory.map((item) => <article className="history-item" key={item.id}><span className="history-icon">⌁</span><div className="history-main"><h3>{item.question}</h3><p>{formatDate(item.createdAt)} · {item.rowCount} 行结果 · {item.executionMs} ms</p><span>{item.result.summary}</span></div><div className="history-actions"><button onClick={() => { setResult(item.result); setQuestion(item.question); setView("chat"); }}>查看结果</button><button className="rerun" onClick={() => void ask(item.question)}>重新运行 ↗</button><button aria-label="删除记录" onClick={() => saveHistory(history.filter((record) => record.id !== item.id))}>×</button></div></article>)}</div>}</div>}
    </section>

    {showAddSource && <div className="modal-backdrop" onMouseDown={() => !connecting && setShowAddSource(false)}><form className="source-modal source-modal-wide" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void addConnection(event)}><div className="modal-head"><div><h2>添加数据源</h2><p>由客户填写连接信息；密码与私钥仅用于当前服务会话。</p></div><button type="button" onClick={() => setShowAddSource(false)} disabled={connecting}>×</button></div><div className="connection-form-grid"><label>连接名称<input name="name" required placeholder="例如：财务数据库" /></label><label>数据库类型<select name="engine" defaultValue="mysql"><option value="mysql">MySQL 8+</option></select></label><label className="span-two">主机名或 IP<input name="host" required placeholder="例如：127.0.0.1 或 db.example.com" /></label><label>端口<input name="port" type="number" min="1" max="65535" defaultValue="3306" required /></label><label>数据库名<input name="database" required placeholder="例如：finance_db" /></label><label>用户名<input name="user" required placeholder="数据库用户名" autoComplete="username" /></label><label>密码<input name="password" type="password" required placeholder="数据库密码" autoComplete="current-password" /></label></div><label className="ssh-switch"><input type="checkbox" checked={sshEnabled} onChange={(event) => setSshEnabled(event.target.checked)} /><span><strong>通过 SSH 隧道连接</strong><small>适用于数据库仅能从跳板机访问的情况</small></span></label>{sshEnabled && <div className="ssh-fields"><div className="connection-form-grid"><label className="span-two">SSH 主机名或 IP<input name="sshHost" required placeholder="例如：bastion.example.com" /></label><label>SSH 端口<input name="sshPort" type="number" min="1" max="65535" defaultValue="22" required /></label><label>SSH 用户名<input name="sshUser" required placeholder="例如：root" /></label><label className="span-two">SSH 私钥文件<input name="sshKey" type="file" required accept=".pem,.key,.txt" /></label><label className="span-two">私钥口令（可选）<input name="sshPassphrase" type="password" placeholder="私钥没有口令时留空" /></label></div></div>}{connectionNotice && <div className="connection-notice modal-notice">{connectionNotice}</div>}<div className="modal-actions"><button type="button" onClick={() => setShowAddSource(false)} disabled={connecting}>取消</button><button className="primary-action" type="submit" disabled={connecting}>{connecting ? "正在测试连接…" : "测试并连接"}</button></div></form></div>}
  </main>;
}

function ResultTable({ result }: { result: QueryResult }) { return <div className="table-section"><div className="table-toolbar"><h4>查询结果 <span>{result.rowCount} 行</span></h4><button onClick={() => downloadCsv(result)}>⇩ 导出 CSV</button></div><div className="table-scroll"><table><thead><tr>{result.columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{result.rows.map((row, index) => <tr key={index}>{result.columns.map((column) => <td key={column.key}>{row[column.key]}</td>)}</tr>)}</tbody></table></div></div>; }
function SqlResultTable({ result }: { result: SqlResult }) { return <div className="sql-result"><div className="table-toolbar"><h4>执行结果 <span>{result.rowCount} 行 · {result.executionMs} ms</span></h4></div><div className="table-scroll"><table><thead><tr>{result.columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{result.rows.map((row, index) => <tr key={index}>{result.columns.map((column) => <td key={column.key}>{String(row[column.key] ?? "")}</td>)}</tr>)}</tbody></table></div></div>; }
function formatDate(date: string) { return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(date)); }
function downloadCsv(result: QueryResult) { const header = result.columns.map((column) => column.label).join(","); const body = result.rows.map((row) => result.columns.map((column) => `"${String(row[column.key]).replaceAll('"', '""')}"`).join(",")).join("\n"); const blob = new Blob(["\ufeff" + header + "\n" + body], { type: "text/csv;charset=utf-8" }); const anchor = document.createElement("a"); anchor.href = URL.createObjectURL(blob); anchor.download = "datapilot-result.csv"; anchor.click(); URL.revokeObjectURL(anchor.href); }
