import type { AgentTraceEvent, DataSource, DetailTab, QueryExplanation } from "./types";

const stepLabels: Record<string, { title: string; detail: string }> = {
  "metric.search": { title: "识别财务指标", detail: "匹配 ERP 财务指标定义" },
  "schema.search": { title: "定位并校验 ERP Schema", detail: "读取实体映射与 Validated Join Paths" },
  "result.analyze": { title: "生成业务回答", detail: "基于真实查询结果总结" },
};
function traceLabel(step: string) {
  if (step.startsWith("sql.generate")) return { title: "生成 SQL", detail: "限定在指标、Mapping 与 Join Path 范围内" };
  if (step.startsWith("database.query")) return { title: "SQL 安全检查与数据库查询", detail: "执行只读策略、权限校验和查询" };
  return stepLabels[step] || { title: step, detail: "Agent 执行步骤" };
}

export function AgentTracePanel({ trace, loading = false }: { trace?: AgentTraceEvent[]; loading?: boolean }) {
  if (!trace?.length) return loading ? <div className="agent-loading"><span className="spinner" /><div><strong>正在分析你的问题…</strong><small>完成后将展示后端真实执行链路</small></div></div> : null;
  return <div className="agent-trace"><header><h4>Agent 执行链路</h4><span>{trace.filter((item) => item.status === "succeeded").length} 个步骤完成</span></header><ol>{trace.map((event, index) => { const label = traceLabel(event.step); return <li className={event.status} key={`${event.step}-${index}`}><span>{event.status === "succeeded" ? "✓" : event.status === "failed" ? "✕" : "·"}</span><div><strong>{label.title}</strong><small>{event.detail || label.detail}</small></div>{event.durationMs !== undefined && <em>{event.durationMs} ms</em>}</li>; })}</ol></div>;
}

export function AnswerExplanation({ explanation, sql, trace }: { explanation?: QueryExplanation; sql: string; trace?: AgentTraceEvent[] }) {
  if (!explanation) return null;
  const mappingStatus = explanation.mappingStatus === "published" ? "Published"
    : explanation.mappingStatus === "draft" ? "Draft"
      : explanation.mappingStatus === "unpublished" ? "Unpublished" : "—";
  const mappingVersion = explanation.publishedVersion ?? explanation.registryVersion;
  return <div className="answer-explanation">
    <div className="evidence-grid"><div><span>指标</span><strong>{explanation.metrics.map((item) => item.name).join("、") || "普通数据查询"}</strong></div><div><span>ERP 实体</span><strong>{explanation.semanticEntities.join("、") || "—"}</strong></div><div><span>数据表</span><strong>{explanation.mappingsUsed.map((item) => item.table).join("、") || "—"}</strong></div><div><span>Validated Join</span><strong>{explanation.joinPathsUsed.length}</strong></div><div><span>Mapping 状态</span><strong>{mappingStatus}</strong></div><div><span>Mapping 版本</span><strong>{mappingVersion === undefined ? "—" : `v${mappingVersion}`}</strong></div></div>
    <details><summary>查看数据来源</summary>{explanation.mappingsUsed.map((mapping) => <div className="explanation-mapping" key={mapping.entity}><strong>{mapping.entity} → {mapping.table}</strong><p>{Object.entries(mapping.fields).map(([field, column]) => `${field} → ${column}`).join(" · ")}</p></div>)}</details>
    <details><summary>查看指标定义</summary>{explanation.metrics.map((metric) => <div className="metric-definition" key={metric.id}><strong>{metric.name}</strong><p>{metric.businessDefinition}</p><code>{metric.calculationRule.expression}</code></div>)}</details>
    <details><summary>查看 Join Paths</summary>{explanation.joinPathsUsed.length ? explanation.joinPathsUsed.map((path) => <p key={path.id}><code>{path.leftEntity}</code> → <code>{path.rightEntity}</code> · {path.fields.map((pair) => `${pair.leftField}=${pair.rightField}`).join(" + ")}</p>) : <p>本次查询未使用多表 Join。</p>}</details>
    <details><summary>查看 SQL</summary><pre><code>{sql}</code></pre></details>
    <details><summary>查看执行链路</summary><AgentTracePanel trace={trace} /></details>
  </div>;
}

export function BusinessErrorCard({ message, source, onInspect }: { message: string; source?: DataSource; onInspect: (tab: DetailTab, entity?: string) => void }) {
  const joinProblem = /Join Path|之间没有经过验证/.test(message);
  const mappingProblem = /Schema 映射不足|Mapping|关键字段/.test(message);
  const missing = [...message.matchAll(/(?:缺少关键字段：|缺少必要.*?：)([^；。]+)/g)].flatMap((match) => match[1].split(/[、,]/)).filter(Boolean);
  const entity = message.match(/(VoucherEntry|Voucher|Account|Customer|Supplier|Receivable|Payable|Organization|Department)/)?.[1];
  return <section className="business-error-card"><span className="business-error-icon">!</span><div><h3>无法安全完成查询</h3><p>{mappingProblem ? `当前数据源缺少必要的 ERP Schema Mapping${joinProblem ? " 或经过验证的 Join Path" : ""}。` : "当前指标口径或查询上下文不足，DataPilot 已停止生成 SQL。"}</p><strong>{message}</strong>{missing.length > 0 && <ul>{missing.map((item) => <li key={item}>{item}</li>)}</ul>}<small>DataPilot 未猜测缺失的业务口径、字段或关联条件，以避免生成错误 SQL。</small>{mappingProblem && <button onClick={() => onInspect(joinProblem ? "joins" : "mapping", entity)} disabled={!source}>{joinProblem ? "查看 Join Paths" : "查看 Schema Mapping"} →</button>}</div></section>;
}
