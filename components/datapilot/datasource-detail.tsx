import { useState } from "react";
import { erpLabel } from "./datasource-status-card";
import { JoinPathEditor, MappingEditor } from "./mapping-editor";
import { EntityMappingCard, JoinPathCard, MappingOverview, MappingValidationPanel } from "./mapping-panels";
import { MappingVersions } from "./mapping-versions";
import type { DataSource, DetailTab, MappingDraftPayload, MappingVersionResponse, MappingVersionsResponse, SchemaMappingResponse } from "./types";

const tabs: { id: DetailTab; label: string }[] = [
  { id: "overview", label: "Overview" }, { id: "mapping", label: "Schema Mapping" }, { id: "joins", label: "Join Paths" },
  { id: "validation", label: "Validation" }, { id: "versions", label: "Versions" }, { id: "raw", label: "Raw Schema" },
];

type Actions = {
  onSaveDraft: (draft: MappingDraftPayload) => Promise<void>;
  onValidate: (draft: MappingDraftPayload) => Promise<void>;
  onPublish: (erpType: string) => Promise<void>;
  onLoadVersions: (erpType: string) => Promise<MappingVersionsResponse>;
  onLoadVersion: (erpType: string, version: number) => Promise<MappingVersionResponse>;
  onRollback: (erpType: string, version: number) => Promise<void>;
};

export function DatasourceDetail(props: { source: DataSource; mapping: SchemaMappingResponse | null; loading: boolean; error: string; tab: DetailTab; focusedEntity?: string; onTab: (tab: DetailTab) => void; onBack: () => void; onOpenWorkbench: () => void; onRefresh: () => void } & Actions) {
  return <div className="module-content datasource-detail-page"><button className="back-link" onClick={props.onBack}>← 返回数据源</button>
    <div className="detail-hero"><div><span className="eyebrow">ERP MAPPING REGISTRY</span><h2>{props.source.name}</h2><p>{props.source.engine} · Database: {props.source.database} · ERP: {erpLabel(props.mapping?.erpType)}</p></div><div className="detail-actions"><span className={`source-status ${props.source.status}`}>{props.source.status === "connected" ? "Connected" : "Offline"}</span><button onClick={props.onRefresh}>↻ 重新分析</button><button onClick={props.onOpenWorkbench}>数据库编辑台</button></div></div>
    {props.loading && <div className="detail-loading"><span className="spinner" />正在读取 ERP Mapping Registry…</div>}{props.error && <div className="connection-notice">{props.error}</div>}
    {props.mapping && <MappingWorkspace key={`${props.mapping.erpType}-${props.mapping.review.draftVersion?.updatedAt || props.mapping.review.publishedVersion?.updatedAt || props.mapping.registryVersion || 0}`} {...props} mapping={props.mapping} />}
  </div>;
}

function MappingWorkspace(props: { mapping: SchemaMappingResponse; tab: DetailTab; focusedEntity?: string; onTab: (tab: DetailTab) => void } & Actions) {
  const draft = props.mapping.review.draftVersion;
  const [editing, setEditing] = useState(Boolean(draft));
  const [entities, setEntities] = useState(() => structuredClone(draft?.entities || props.mapping.semanticSchema));
  const [joins, setJoins] = useState(() => structuredClone(draft?.joinPaths || props.mapping.joinPaths));
  const [summary, setSummary] = useState(draft?.changeSummary || "");
  const [busy, setBusy] = useState(""); const [notice, setNotice] = useState("");
  const [versions, setVersions] = useState<MappingVersionsResponse>({ items: [], audits: [] });
  const [selectedVersion, setSelectedVersion] = useState<MappingVersionResponse>();
  const capabilities = new Set(props.mapping.review.capabilities);
  const published = props.mapping.review.publishedVersion;
  const status = published ? `Published v${published.version}` : "Not Published";
  const payload = (): MappingDraftPayload => ({ erpType: props.mapping.erpType, entities, joinPaths: joins, changeSummary: summary });
  async function action(name: string, run: () => Promise<void>) { setBusy(name); setNotice(""); try { await run(); } catch (error) { setNotice(error instanceof Error ? error.message : "操作失败"); } finally { setBusy(""); } }
  async function loadVersions() { const data = await props.onLoadVersions(props.mapping.erpType); setVersions(data); if (data.items[0]) await selectVersion(data.items[0].version); }
  async function selectVersion(version: number) { const data = await props.onLoadVersion(props.mapping.erpType, version); setSelectedVersion(data); }

  return <><div className="mapping-lifecycle-bar"><div><span className={`mapping-status ${published ? "published" : "unpublished"}`}>{status}</span>{draft && <span className="mapping-status draft">Draft v{draft.version} · 当前存在未发布修改</span>}</div><div>{capabilities.has("schema_mapping:write") && <button onClick={() => setEditing((value) => !value)}>{editing ? "退出编辑" : "编辑 Mapping"}</button>}{editing && <><button onClick={() => void action("save", () => props.onSaveDraft(payload()))} disabled={!!busy}>{busy === "save" ? "保存中…" : "保存草稿"}</button><button onClick={() => void action("validate", () => props.onValidate(payload()))} disabled={!!busy}>{busy === "validate" ? "校验中…" : "验证"}</button></>}{capabilities.has("schema_mapping:publish") && draft && <button className="publish-button" onClick={() => void action("publish", () => props.onPublish(props.mapping.erpType))} disabled={!!busy}>{busy === "publish" ? "发布中…" : "发布 Mapping"}</button>}</div></div>
    {notice && <div className="connection-notice">{notice}</div>}
    <MappingOverview mapping={{ ...props.mapping, semanticSchema: entities, joinPaths: joins, mappingValidation: draft?.validation || props.mapping.mappingValidation }} />
    <nav className="detail-tabs"><div>{tabs.map((item) => <button key={item.id} className={props.tab === item.id ? "active" : ""} onClick={() => { props.onTab(item.id); if (item.id === "versions") void action("versions", loadVersions); }}>{item.label}{item.id === "joins" && <em>{joins.length}</em>}</button>)}</div></nav>
    <section className="detail-tab-panel">
      {props.tab === "overview" && <Overview mapping={props.mapping} onTab={props.onTab} />}
      {props.tab === "mapping" && (editing ? <><label className="change-summary">修改摘要<input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="例如：确认 VoucherEntry 科目编码字段" maxLength={300} /></label><MappingEditor entities={entities} rawSchema={props.mapping.rawSchema} onChange={setEntities} /></> : <div className="entity-card-grid">{entities.map((entity) => <EntityMappingCard key={entity.entity} mapping={entity} focused={props.focusedEntity === entity.entity} />)}</div>)}
      {props.tab === "joins" && (editing ? <JoinPathEditor joins={joins} entities={entities} onChange={setJoins} /> : <JoinReadOnly joins={joins} candidates={props.mapping.joinCandidates || []} />)}
      {props.tab === "validation" && <MappingValidationPanel mapping={{ ...props.mapping, semanticSchema: entities, joinPaths: joins, mappingValidation: draft?.validation || props.mapping.mappingValidation }} />}
      {props.tab === "versions" && <MappingVersions versions={versions.items} audits={versions.audits} selected={selectedVersion?.version} diff={selectedVersion?.diff} onSelect={(version) => void action("version", () => selectVersion(version))} canRollback={capabilities.has("schema_mapping:publish")} onRollback={(version) => void action("rollback", () => props.onRollback(props.mapping.erpType, version))} />}
      {props.tab === "raw" && <RawSchema mapping={props.mapping} />}
    </section>
  </>;
}

function JoinReadOnly({ joins, candidates }: { joins: SchemaMappingResponse["joinPaths"]; candidates: NonNullable<SchemaMappingResponse["joinCandidates"]> }) { return <div className="join-list"><div className="section-heading"><div><h3>Validated Join Paths</h3><p>正式 Text2SQL 只允许使用已发布且经过验证的关联。</p></div></div>{joins.map((path) => <JoinPathCard key={path.id} path={path} />)}{!joins.length && <Empty title="暂无经过验证的 Join Path" text="多表查询将被拒绝，而不会猜测 JOIN。" />}{candidates.length > 0 && <><div className="section-heading secondary"><div><h3>Join Candidates</h3><p>候选关系不会用于 SQL 生成。</p></div></div>{candidates.map((path) => <JoinPathCard key={path.id} path={path} candidate />)}</>}</div>; }
function RawSchema({ mapping }: { mapping: SchemaMappingResponse }) { return <div className="raw-schema-list">{mapping.rawSchema.map((table) => <details key={table.name}><summary><strong>{table.name}</strong><span>{table.rows.toLocaleString()} 行 · {table.columns.length} 列</span></summary><div>{table.columns.map((column) => <p key={column.name}><code>{column.name}</code><span>{column.type}</span><span>{column.comment || "—"}</span></p>)}</div></details>)}</div>; }
function Overview({ mapping, onTab }: { mapping: SchemaMappingResponse; onTab: (tab: DetailTab) => void }) { const issues = mapping.unresolvedFields.slice(0, 6); return <div className="detail-overview-grid"><section><div className="section-heading"><div><h3>ERP Schema Understanding</h3><p>自动识别负责候选，Published Registry 决定生产生效。</p></div><button onClick={() => onTab("mapping")}>查看全部 Mapping →</button></div><div className="entity-chip-grid">{mapping.semanticSchema.map((item) => <span key={item.entity}><strong>{item.entity}</strong><small>→ {item.table}</small><em>{Math.round(item.confidence * 100)}%</em></span>)}</div></section><section><div className="section-heading"><div><h3>生产状态</h3><p>{mapping.mappingStatus === "published" ? "Text2SQL 正在使用已发布 Mapping。" : "Demo 兼容模式正在使用未发布自动 Mapping。"}</p></div></div><ul className="understanding-list"><li className={mapping.mappingStatus === "published" ? "ok" : "warn"}><span>{mapping.mappingStatus === "published" ? "✓" : "!"}</span><div><strong>Published Registry</strong><small>{mapping.publishedVersion ? `当前 v${mapping.publishedVersion}` : "尚未发布生产版本"}</small></div></li><li className={mapping.mappingValidation.valid ? "ok" : "bad"}><span>{mapping.mappingValidation.valid ? "✓" : "✕"}</span><div><strong>Schema Validation</strong><small>{mapping.mappingValidation.valid ? "当前字段存在" : `${mapping.mappingValidation.errors.length} 个错误`}</small></div></li><li className={issues.length ? "warn" : "ok"}><span>{issues.length ? "!" : "✓"}</span><div><strong>关键字段</strong><small>{issues.length ? issues.join(" · ") : "无未解析字段"}</small></div></li></ul></section></div>; }
function Empty({ title, text }: { title: string; text: string }) { return <div className="semantic-empty"><span>◇</span><h3>{title}</h3><p>{text}</p></div>; }
