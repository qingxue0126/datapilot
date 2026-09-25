import { erpLabel } from "./datasource-status-card";
import { EntityMappingCard, JoinPathCard, MappingOverview, MappingValidationPanel } from "./mapping-panels";
import type { DataSource, DetailTab, SchemaMappingResponse } from "./types";

const tabs: { id: DetailTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "mapping", label: "Schema Mapping" },
  { id: "joins", label: "Join Paths" },
  { id: "validation", label: "Validation" },
  { id: "raw", label: "Raw Schema" },
];

export function DatasourceDetail({ source, mapping, loading, error, tab, focusedEntity, onTab, onBack, onOpenWorkbench, onRefresh }: {
  source: DataSource;
  mapping: SchemaMappingResponse | null;
  loading: boolean;
  error: string;
  tab: DetailTab;
  focusedEntity?: string;
  onTab: (tab: DetailTab) => void;
  onBack: () => void;
  onOpenWorkbench: () => void;
  onRefresh: () => void;
}) {
  return <div className="module-content datasource-detail-page">
    <button className="back-link" onClick={onBack}>← 返回数据源</button>
    <div className="detail-hero"><div><span className="eyebrow">ERP DATA UNDERSTANDING</span><h2>{source.name}</h2><p>{source.engine} · Database: {source.database} · ERP: {erpLabel(mapping?.erpType)}</p></div><div className="detail-actions"><span className={`source-status ${source.status}`}>{source.status === "connected" ? "Connected" : "Offline"}</span><button onClick={onRefresh}>↻ 重新分析</button><button onClick={onOpenWorkbench}>打开数据库编辑台</button></div></div>
    {loading && <div className="detail-loading"><span className="spinner" />正在读取并校验 ERP Schema…</div>}
    {error && <div className="connection-notice">{error}</div>}
    {mapping && <>
      <MappingOverview mapping={mapping} />
      <nav className="detail-tabs" aria-label="数据源详情"><div>{tabs.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => onTab(item.id)}>{item.label}{item.id === "joins" && <em>{mapping.joinPaths.length}</em>}</button>)}</div></nav>
      <section className="detail-tab-panel">
        {tab === "overview" && <Overview mapping={mapping} onTab={onTab} />}
        {tab === "mapping" && <div className="entity-card-grid">{mapping.semanticSchema.map((entity) => <EntityMappingCard key={entity.entity} mapping={entity} focused={focusedEntity === entity.entity} />)}{mapping.semanticSchema.length === 0 && <Empty title="尚未识别 ERP 实体" text="当前原始 Schema 无法达到自动映射置信度阈值。" />}</div>}
        {tab === "joins" && <div className="join-list"><div className="section-heading"><div><h3>Validated Join Paths</h3><p>Text2SQL 只允许使用这里列出的已校验关联。</p></div></div>{mapping.joinPaths.map((path) => <JoinPathCard key={path.id} path={path} />)}{mapping.joinPaths.length === 0 && <Empty title="暂无经过验证的 Join Path" text="多表查询将被拒绝，而不会根据字段名相似度猜测 JOIN。" />}{(mapping.joinCandidates || []).length > 0 && <><div className="section-heading secondary"><div><h3>Join Candidates</h3><p>候选关系尚未通过真实性校验，不会用于 SQL 生成。</p></div></div>{(mapping.joinCandidates || []).map((path) => <JoinPathCard key={path.id} path={path} candidate />)}</>}</div>}
        {tab === "validation" && <MappingValidationPanel mapping={mapping} />}
        {tab === "raw" && <div className="raw-schema-list">{mapping.rawSchema.map((table) => <details key={table.name}><summary><strong>{table.name}</strong><span>{table.rows.toLocaleString()} 行 · {table.columns.length} 列</span></summary><div>{table.columns.map((column) => <p key={column.name}><code>{column.name}</code><span>{column.type}</span><span>{column.comment || "—"}</span></p>)}</div></details>)}</div>}
      </section>
    </>}
  </div>;
}

function Overview({ mapping, onTab }: { mapping: SchemaMappingResponse; onTab: (tab: DetailTab) => void }) {
  const issues = mapping.unresolvedFields.slice(0, 6);
  return <div className="detail-overview-grid"><section><div className="section-heading"><div><h3>ERP Schema Understanding</h3><p>业务实体优先，原始数据库结构最后展示。</p></div><button onClick={() => onTab("mapping")}>查看全部 Mapping →</button></div><div className="entity-chip-grid">{mapping.semanticSchema.map((item) => <span key={item.entity}><strong>{item.entity}</strong><small>→ {item.table}</small><em>{Math.round(item.confidence * 100)}%</em></span>)}</div></section><section><div className="section-heading"><div><h3>理解状态</h3><p>DataPilot 在信息不足时会明确拒绝猜测。</p></div></div><ul className="understanding-list"><li className={mapping.mappingValidation.valid ? "ok" : "bad"}><span>{mapping.mappingValidation.valid ? "✓" : "✕"}</span><div><strong>Schema Validation</strong><small>{mapping.mappingValidation.valid ? "映射字段与当前数据库一致" : `${mapping.mappingValidation.errors.length} 个映射错误`}</small></div></li><li className={mapping.joinPaths.length ? "ok" : "warn"}><span>{mapping.joinPaths.length ? "✓" : "!"}</span><div><strong>Join Path Registry</strong><small>{mapping.joinPaths.length ? `${mapping.joinPaths.length} 条关系已验证` : "尚无可用于多表查询的关联"}</small></div></li><li className={issues.length ? "warn" : "ok"}><span>{issues.length ? "!" : "✓"}</span><div><strong>关键字段</strong><small>{issues.length ? issues.join(" · ") : "当前 Mapping 无未解析字段"}</small></div></li></ul></section></div>;
}

function Empty({ title, text }: { title: string; text: string }) { return <div className="semantic-empty"><span>◇</span><h3>{title}</h3><p>{text}</p></div>; }
