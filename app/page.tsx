"use client";

import { FormEvent, useState } from "react";

type QueryResult = {
  question: string; summary: string; sql: string;
  columns: { key: string; label: string }[];
  rows: Record<string, string | number>[];
  chart?: { label: string; value: number }[];
  executionMs: number; rowCount: number;
};

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

export default function Home() {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<QueryResult>(initialResult);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showSql, setShowSql] = useState(true);

  async function ask(text?: string) {
    const query = (text ?? question).trim();
    if (!query || loading) return;
    setQuestion(query); setLoading(true); setError("");
    try {
      const response = await fetch("/api/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: query }) });
      if (!response.ok) throw new Error("查询暂时不可用，请稍后再试");
      setResult(await response.json());
    } catch (err) { setError(err instanceof Error ? err.message : "查询失败"); }
    finally { setLoading(false); }
  }

  function submit(event: FormEvent) { event.preventDefault(); void ask(); }
  const maxChart = Math.max(...(result.chart?.map((item) => item.value) ?? [1]));

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">D</span><span>DataPilot</span></div>
        <button className="new-chat" onClick={() => { setQuestion(""); setResult(initialResult); }}>＋ 新建对话</button>
        <nav aria-label="主导航">
          <a className="nav-item active" href="#workspace"><span>⌁</span>数据问答</a>
          <a className="nav-item" href="#sources"><span>▦</span>数据源</a>
          <a className="nav-item" href="#history"><span>◷</span>查询历史</a>
        </nav>
        <div className="source-card" id="sources">
          <div className="source-title"><span className="status-dot" />电商业务库</div>
          <div className="source-meta">SQLite · 已连接</div>
          <div className="source-stats"><span>6 张表</span><span>2.4 万行</span></div>
        </div>
        <div className="sidebar-bottom">
          <button className="plain-button">⚙ <span>工作区设置</span></button>
          <div className="profile"><span className="avatar">陈</span><span><strong>陈宇</strong><small>数据分析团队</small></span><span className="more">•••</span></div>
        </div>
      </aside>

      <section className="workspace" id="workspace">
        <header className="topbar">
          <div><h1>数据问答</h1><p>用自然语言探索你的业务数据</p></div>
          <div className="top-actions"><span className="connection"><i /> 数据已更新</span><button aria-label="帮助">?</button></div>
        </header>
        <div className="content">
          <section className="hero-copy"><div className="eyebrow">AI DATA ANALYST</div><h2>今天想了解什么？</h2><p>直接提问，我会理解你的业务意图、生成 SQL 并返回可信结果。</p></section>
          <form className="query-box" onSubmit={submit}>
            <textarea aria-label="输入数据问题" value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask(); } }} placeholder="例如：上个月各地区的销售额是多少？" rows={2} />
            <div className="query-footer"><span>已连接：电商业务库</span><button type="submit" disabled={loading || !question.trim()}>{loading ? "分析中…" : "发送 ↗"}</button></div>
          </form>
          <div className="suggestions" aria-label="示例问题">{suggestions.map((item) => <button key={item} onClick={() => void ask(item)}>{item}<span>↗</span></button>)}</div>
          {error && <div className="error-message">{error}</div>}
          <section className={`result-card ${loading ? "is-loading" : ""}`} aria-live="polite">
            <div className="result-head"><div><span className="answer-badge">✓</span><div><h3>分析完成</h3><p>{result.question}</p></div></div><span className="runtime">{result.executionMs} ms</span></div>
            <div className="summary"><span>✦</span><p>{result.summary}</p></div>
            {result.chart && <div className="chart-wrap"><div className="chart-head"><h4>核心指标对比</h4><span>单位：万元</span></div><div className="bar-chart">{result.chart.map((item) => <div className="bar-column" key={item.label}><span className="bar-value">{item.value}</span><div className="bar" style={{ height: `${Math.max(18, (item.value / maxChart) * 100)}%` }} /><span className="bar-label">{item.label}</span></div>)}</div></div>}
            <div className="table-section"><div className="table-toolbar"><h4>查询结果 <span>{result.rowCount} 行</span></h4><button onClick={() => downloadCsv(result)}>⇩ 导出 CSV</button></div><div className="table-scroll"><table><thead><tr>{result.columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{result.rows.map((row, index) => <tr key={index}>{result.columns.map((column) => <td key={column.key}>{row[column.key]}</td>)}</tr>)}</tbody></table></div></div>
            <div className="sql-block"><button className="sql-toggle" onClick={() => setShowSql((value) => !value)}><span>⌘</span> 生成的 SQL <i>{showSql ? "⌃" : "⌄"}</i></button>{showSql && <div className="code-wrap"><pre><code>{result.sql}</code></pre><button className="copy" onClick={() => void navigator.clipboard.writeText(result.sql)}>复制</button></div>}</div>
          </section>
          <p className="disclaimer">DataPilot 可能会产生不准确的结果，请在关键决策前复核数据。</p>
        </div>
      </section>
    </main>
  );
}

function downloadCsv(result: QueryResult) {
  const header = result.columns.map((column) => column.label).join(",");
  const body = result.rows.map((row) => result.columns.map((column) => `"${String(row[column.key]).replaceAll('"', '""')}"`).join(",")).join("\n");
  const blob = new Blob(["\ufeff" + header + "\n" + body], { type: "text/csv;charset=utf-8" });
  const anchor = document.createElement("a"); anchor.href = URL.createObjectURL(blob); anchor.download = "datapilot-result.csv"; anchor.click(); URL.revokeObjectURL(anchor.href);
}
