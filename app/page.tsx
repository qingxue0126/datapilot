"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type View = "chat" | "sources" | "history";
type QueryResult = {
  question: string; summary: string; sql: string;
  columns: { key: string; label: string }[];
  rows: Record<string, string | number>[];
  chart?: { label: string; value: number }[];
  executionMs: number; rowCount: number;
};
type HistoryItem = { id: string; question: string; createdAt: string; rowCount: number; executionMs: number; result: QueryResult };
type DataSource = { id: string; name: string; engine: string; host: string; database: string; tables: number; rows: string; status: "connected" | "offline"; color: string };
type SchemaTable = { name: string; rows: number; columns: { name: string; type: string; nullable: boolean; key: string; comment: string }[] };
type SqlResult = { sql: string; columns: { key: string; label: string }[]; rows: Record<string, unknown>[]; rowCount: number; executionMs: number };

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001";

const suggestions = ["今年各月份的销售额趋势如何？", "华东区销售额最高的 5 个产品", "各地区的订单量和平均客单价"];
const initialResult: QueryResult = {
  question: "今年各月份的销售额趋势如何？",
  summary: "今年累计销售额 1,284.6 万元，其中 6 月表现最好，较 1 月增长 58.7%。",
  sql: `SELECT strftime('%Y-%m', order_date) AS month,\n       ROUND(SUM(amount) / 10000, 1) AS revenue_wan\nFROM orders\nWHERE order_date >= date('now', 'start of year')\nGROUP BY month\nORDER BY month;`,
  columns: [{ key: "month", label: "月份" }, { key: "revenue", label: "销售额（万元）" }, { key: "growth", label: "环比" }],
  rows: [
    { month: "2026-01", revenue: 162.4, growth: "—" }, { month: "2026-02", revenue: 176.8, growth: "+8.9%" },
    { month: "2026-03", revenue: 201.3, growth: "+13.9%" }, { month: "2026-04", revenue: 229.7, growth: "+14.1%" },
    { month: "2026-05", revenue: 256.9, growth: "+11.8%" }, { month: "2026-06", revenue: 257.5, growth: "+0.2%" },
  ],
  chart: [{ label: "1月", value: 162.4 }, { label: "2月", value: 176.8 }, { label: "3月", value: 201.3 }, { label: "4月", value: 229.7 }, { label: "5月", value: 256.9 }, { label: "6月", value: 257.5 }],
  executionMs: 126, rowCount: 6,
};

const initialSources: DataSource[] = [
  { id: "finance", name: "finance_db", engine: "MySQL 8", host: "SSH 隧道 · 127.0.0.1:3307", database: "finance_db", tables: 0, rows: "—", status: "offline", color: "#2f8b68" },
  { id: "crm", name: "客户关系库", engine: "PostgreSQL", host: "crm.internal:5432", database: "customer_360", tables: 12, rows: "18.7 万", status: "connected", color: "#4778a8" },
  { id: "warehouse", name: "经营数据仓库", engine: "MySQL", host: "dw.internal:3306", database: "business_dw", tables: 24, rows: "128 万", status: "offline", color: "#bf8547" },
];

const schemaTables = [
  { name: "orders", label: "订单", rows: "12,486", fields: "id, customer_id, product_id, amount, region, order_date" },
  { name: "products", label: "商品", rows: "1,284", fields: "id, name, category, price, cost" },
  { name: "customers", label: "客户", rows: "8,932", fields: "id, name, city, level, created_at" },
  { name: "order_items", label: "订单明细", rows: "24,761", fields: "id, order_id, product_id, quantity, subtotal" },
  { name: "regions", label: "区域", rows: "34", fields: "id, name, manager, target" },
  { name: "campaigns", label: "营销活动", rows: "126", fields: "id, name, channel, spend, start_date, end_date" },
];

export default function Home() {
  const [view, setView] = useState<View>("chat");
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<QueryResult>(initialResult);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showSql, setShowSql] = useState(true);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historySearch, setHistorySearch] = useState("");
  const [sources, setSources] = useState<DataSource[]>(initialSources);
  const [activeSourceId, setActiveSourceId] = useState("finance");
  const [testingSource, setTestingSource] = useState<string | null>(null);
  const [showAddSource, setShowAddSource] = useState(false);
  const [serverSchema, setServerSchema] = useState<SchemaTable[]>([]);
  const [connectionNotice, setConnectionNotice] = useState("");
  const [sqlText, setSqlText] = useState("SELECT * FROM information_schema.tables WHERE table_schema = DATABASE() LIMIT 20");
  const [sqlResult, setSqlResult] = useState<SqlResult | null>(null);
  const [sqlRunning, setSqlRunning] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("datapilot-history");
    if (saved) { try { setHistory(JSON.parse(saved)); } catch { localStorage.removeItem("datapilot-history"); } }
  }, []);

  function saveHistory(items: HistoryItem[]) {
    setHistory(items); localStorage.setItem("datapilot-history", JSON.stringify(items.slice(0, 50)));
  }

  async function ask(text?: string) {
    const query = (text ?? question).trim();
    if (!query || loading) return;
    setQuestion(query); setLoading(true); setError(""); setView("chat");
    try {
      const response = await fetch(`${API_BASE}/api/query`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: query, sourceId: activeSourceId }) });
      if (!response.ok) { const problem = await response.json().catch(() => ({})); throw new Error(problem.error || "查询暂时不可用，请稍后再试"); }
      const data: QueryResult = await response.json();
      setResult(data);
      const entry: HistoryItem = { id: `${Date.now()}`, question: query, createdAt: new Date().toISOString(), rowCount: data.rowCount, executionMs: data.executionMs, result: data };
      saveHistory([entry, ...history.filter((item) => item.question !== query)]);
    } catch (err) { setError(err instanceof Error ? err.message : "查询失败"); }
    finally { setLoading(false); }
  }

  function submit(event: FormEvent) { event.preventDefault(); void ask(); }
  function newChat() { setQuestion(""); setResult(initialResult); setView("chat"); }
  async function testConnection(id: string) {
    setTestingSource(id);
    setConnectionNotice("");
    try {
      if (id !== "finance") throw new Error("该数据源尚未配置服务端连接");
      const response = await fetch(`${API_BASE}/api/database/test`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "连接失败");
      setSources((items) => items.map((source) => source.id === id ? { ...source, status: "connected", tables: data.tables } : source));
      setConnectionNotice(`连接成功 · MySQL ${data.version} · ${data.tables} 张表 · ${data.latencyMs} ms`);
      await loadSchema();
    } catch (connectionError) { setConnectionNotice(connectionError instanceof Error ? connectionError.message : "连接失败"); }
    finally { setTestingSource(null); }
  }

  async function loadSchema() {
    const response = await fetch(`${API_BASE}/api/database/schema`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取 Schema 失败");
    setServerSchema(data.tables || []);
  }

  async function runSql() {
    if (!sqlText.trim() || sqlRunning) return;
    setSqlRunning(true); setConnectionNotice("");
    try {
      const response = await fetch(`${API_BASE}/api/database/query`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql: sqlText }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "SQL 执行失败");
      setSqlResult(data);
    } catch (sqlError) { setConnectionNotice(sqlError instanceof Error ? sqlError.message : "SQL 执行失败"); }
    finally { setSqlRunning(false); }
  }

  const activeSource = sources.find((source) => source.id === activeSourceId) ?? sources[0];
  const filteredHistory = useMemo(() => history.filter((item) => item.question.toLowerCase().includes(historySearch.toLowerCase())), [history, historySearch]);
  const maxChart = Math.max(...(result.chart?.map((item) => item.value) ?? [1]));
  const viewTitles: Record<View, [string, string]> = { chat: ["数据问答", "用自然语言探索你的业务数据"], sources: ["数据源", "管理数据库连接与业务表结构"], history: ["查询历史", "查看、检索并复用过去的分析"] };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">D</span><span>DataPilot</span></div>
        <button className="new-chat" onClick={newChat}>＋ 新建对话</button>
        <nav aria-label="主导航">
          <button className={`nav-item ${view === "chat" ? "active" : ""}`} onClick={() => setView("chat")}><span>⌁</span>数据问答</button>
          <button className={`nav-item ${view === "sources" ? "active" : ""}`} onClick={() => setView("sources")}><span>▦</span>数据源</button>
          <button className={`nav-item ${view === "history" ? "active" : ""}`} onClick={() => setView("history")}><span>◷</span>查询历史{history.length > 0 && <em>{history.length}</em>}</button>
        </nav>
        <button className="source-card" onClick={() => setView("sources")}> 
          <span className="source-title"><span className={`status-dot ${activeSource.status}`} />{activeSource.name}</span>
          <span className="source-meta">{activeSource.engine} · {activeSource.status === "connected" ? "已连接" : "连接中断"}</span>
          <span className="source-stats"><span>{activeSource.tables} 张表</span><span>{activeSource.rows} 行</span></span>
        </button>
        <div className="sidebar-bottom"><button className="plain-button">⚙ <span>工作区设置</span></button><div className="profile"><span className="avatar">陈</span><span><strong>陈宇</strong><small>数据分析团队</small></span><span className="more">•••</span></div></div>
      </aside>

      <section className="workspace">
        <header className="topbar"><div><h1>{viewTitles[view][0]}</h1><p>{viewTitles[view][1]}</p></div><div className="top-actions"><span className="connection"><i /> 数据已更新</span><button aria-label="帮助">?</button></div></header>
        {view === "chat" && <div className="content">
          <section className="hero-copy"><div className="eyebrow">AI DATA ANALYST</div><h2>今天想了解什么？</h2><p>直接提问，我会理解你的业务意图、生成 SQL 并返回可信结果。</p></section>
          <form className="query-box" onSubmit={submit}><textarea aria-label="输入数据问题" value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask(); } }} placeholder="例如：上个月各地区的销售额是多少？" rows={2} /><div className="query-footer"><button className="source-selector" type="button" onClick={() => setView("sources")}><span />{activeSource.name}⌄</button><button className="send-button" type="submit" disabled={loading || !question.trim()}>{loading ? "分析中…" : "发送 ↗"}</button></div></form>
          <div className="suggestions" aria-label="示例问题">{suggestions.map((item) => <button key={item} onClick={() => void ask(item)}>{item}<span>↗</span></button>)}</div>
          {error && <div className="error-message">{error}</div>}
          <section className={`result-card ${loading ? "is-loading" : ""}`} aria-live="polite">
            <div className="result-head"><div><span className="answer-badge">✓</span><div><h3>分析完成</h3><p>{result.question}</p></div></div><span className="runtime">{result.executionMs} ms</span></div>
            <div className="summary"><span>✦</span><p>{result.summary}</p></div>
            {result.chart && <div className="chart-wrap"><div className="chart-head"><h4>核心指标对比</h4><span>单位：万元</span></div><div className="bar-chart">{result.chart.map((item) => <div className="bar-column" key={item.label}><span className="bar-value">{item.value}</span><div className="bar" style={{ height: `${Math.max(18, (item.value / maxChart) * 100)}%` }} /><span className="bar-label">{item.label}</span></div>)}</div></div>}
            <div className="table-section"><div className="table-toolbar"><h4>查询结果 <span>{result.rowCount} 行</span></h4><button onClick={() => downloadCsv(result)}>⇩ 导出 CSV</button></div><div className="table-scroll"><table><thead><tr>{result.columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{result.rows.map((row, index) => <tr key={index}>{result.columns.map((column) => <td key={column.key}>{row[column.key]}</td>)}</tr>)}</tbody></table></div></div>
            <div className="sql-block"><button className="sql-toggle" onClick={() => setShowSql((value) => !value)}><span>⌘</span> 生成的 SQL <i>{showSql ? "⌃" : "⌄"}</i></button>{showSql && <div className="code-wrap"><pre><code>{result.sql}</code></pre><button className="copy" onClick={() => void navigator.clipboard.writeText(result.sql)}>复制</button></div>}</div>
          </section><p className="disclaimer">DataPilot 可能会产生不准确的结果，请在关键决策前复核数据。</p>
        </div>}

        {view === "sources" && <div className="module-content sources-page">
          <div className="module-heading"><div><span className="eyebrow">DATA CONNECTIONS</span><h2>连接你的业务数据</h2><p>选择查询使用的数据源，查看可用表与字段。</p></div><button className="primary-action" onClick={() => setShowAddSource(true)}>＋ 添加数据源</button></div>
          <div className="source-grid">{sources.map((source) => <article className={`db-card ${activeSourceId === source.id ? "selected" : ""}`} key={source.id} onClick={() => setActiveSourceId(source.id)}><div className="db-card-top"><span className="db-icon" style={{ background: source.color }}>{source.engine.slice(0, 2).toUpperCase()}</span><span className={`source-status ${source.status}`}>{source.status === "connected" ? "已连接" : "离线"}</span></div><h3>{source.name}</h3><p>{source.engine} · {source.database}</p><div className="db-stats"><span><strong>{source.tables}</strong> 张表</span><span><strong>{source.rows}</strong> 行数据</span></div><div className="db-actions"><button onClick={(event) => { event.stopPropagation(); void testConnection(source.id); }}>{testingSource === source.id ? "测试中…" : "测试连接"}</button><button onClick={(event) => { event.stopPropagation(); setActiveSourceId(source.id); setView("chat"); }} disabled={source.status === "offline"}>用于查询</button></div></article>)}</div>
          {connectionNotice && <div className={`connection-notice ${connectionNotice.startsWith("连接成功") ? "success" : ""}`}>{connectionNotice}</div>}
          <section className="schema-panel"><div className="schema-head"><div><h3>{activeSource.name} · 数据结构</h3><p>{activeSource.host} / {activeSource.database}</p></div><button className="schema-refresh" onClick={() => void loadSchema().catch((loadError) => setConnectionNotice(loadError.message))}>↻ 刷新 Schema</button></div><div className="schema-list">{(serverSchema.length ? serverSchema : schemaTables).slice(0, 12).map((table) => <div className="schema-row" key={table.name}><span className="table-symbol">▦</span><div><strong>{table.name}</strong><small>{"columns" in table ? table.columns.map((column) => `${column.name} ${column.type}`).join(", ") : `${table.label} · ${table.fields}`}</small></div><span>{table.rows.toLocaleString()} 行</span></div>)}</div></section>
          <section className="sql-console"><div className="schema-head"><div><h3>SQL 控制台</h3><p>仅允许 SELECT、SHOW、DESCRIBE 和 EXPLAIN，最多返回 200 行</p></div><span className="schema-sync">MySQL 8</span></div><textarea value={sqlText} onChange={(event) => setSqlText(event.target.value)} spellCheck={false} /><div className="sql-console-actions"><button onClick={() => void runSql()} disabled={sqlRunning}>{sqlRunning ? "执行中…" : "▶ 执行 SQL"}</button></div>{sqlResult && <div className="sql-result"><div className="table-toolbar"><h4>执行结果 <span>{sqlResult.rowCount} 行 · {sqlResult.executionMs} ms</span></h4></div><div className="table-scroll"><table><thead><tr>{sqlResult.columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{sqlResult.rows.map((row, index) => <tr key={index}>{sqlResult.columns.map((column) => <td key={column.key}>{String(row[column.key] ?? "")}</td>)}</tr>)}</tbody></table></div></div>}</section>
        </div>}

        {view === "history" && <div className="module-content history-page">
          <div className="module-heading"><div><span className="eyebrow">QUERY LIBRARY</span><h2>查询历史</h2><p>找回过去的问题，一键重新分析最新数据。</p></div>{history.length > 0 && <button className="danger-action" onClick={() => saveHistory([])}>清空历史</button>}</div>
          <div className="history-toolbar"><label><span>⌕</span><input value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder="搜索历史问题…" /></label><span>共 {filteredHistory.length} 条记录</span></div>
          {filteredHistory.length === 0 ? <div className="empty-state"><span>◷</span><h3>{history.length ? "没有匹配的查询" : "还没有查询历史"}</h3><p>{history.length ? "换一个关键词试试。" : "完成第一次数据问答后，记录会出现在这里。"}</p><button onClick={() => setView("chat")}>开始提问</button></div> : <div className="history-list">{filteredHistory.map((item) => <article className="history-item" key={item.id}><span className="history-icon">⌁</span><div className="history-main"><h3>{item.question}</h3><p>{formatDate(item.createdAt)} · {item.rowCount} 行结果 · {item.executionMs} ms</p><span>{item.result.summary}</span></div><div className="history-actions"><button onClick={() => { setResult(item.result); setQuestion(item.question); setView("chat"); }}>查看结果</button><button className="rerun" onClick={() => void ask(item.question)}>重新运行 ↗</button><button aria-label="删除记录" onClick={() => saveHistory(history.filter((record) => record.id !== item.id))}>×</button></div></article>)}</div>}
        </div>}
      </section>

      {showAddSource && <div className="modal-backdrop" onMouseDown={() => setShowAddSource(false)}><form className="source-modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const name = String(form.get("name") || "新数据源"); const engine = String(form.get("engine") || "PostgreSQL"); const created: DataSource = { id: `${Date.now()}`, name, engine, host: String(form.get("host") || "localhost"), database: String(form.get("database") || "analytics"), tables: 0, rows: "0", status: "connected", color: "#5c7395" }; setSources([...sources, created]); setActiveSourceId(created.id); setShowAddSource(false); }}><div className="modal-head"><div><h2>添加数据源</h2><p>连接信息仅保存在当前演示工作区。</p></div><button type="button" onClick={() => setShowAddSource(false)}>×</button></div><label>连接名称<input name="name" required placeholder="例如：销售数据库" /></label><label>数据库类型<select name="engine"><option>PostgreSQL</option><option>MySQL</option><option>SQLite</option><option>SQL Server</option></select></label><div className="form-row"><label>主机地址<input name="host" required placeholder="db.example.com:5432" /></label><label>数据库名<input name="database" required placeholder="analytics" /></label></div><div className="modal-actions"><button type="button" onClick={() => setShowAddSource(false)}>取消</button><button className="primary-action" type="submit">连接数据源</button></div></form></div>}
    </main>
  );
}

function formatDate(date: string) { return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(date)); }
function downloadCsv(result: QueryResult) {
  const header = result.columns.map((column) => column.label).join(",");
  const body = result.rows.map((row) => result.columns.map((column) => `"${String(row[column.key]).replaceAll('"', '""')}"`).join(",")).join("\n");
  const blob = new Blob(["\ufeff" + header + "\n" + body], { type: "text/csv;charset=utf-8" });
  const anchor = document.createElement("a"); anchor.href = URL.createObjectURL(blob); anchor.download = "datapilot-result.csv"; anchor.click(); URL.revokeObjectURL(anchor.href);
}
