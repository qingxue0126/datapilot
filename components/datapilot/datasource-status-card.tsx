import type { DataSource } from "./types";

const erpNames: Record<string, string> = { yongyou: "用友 ERP", kingdee: "金蝶 ERP", qiqi: "企企 ERP", generic: "Generic ERP" };

export function erpLabel(value?: string) { return erpNames[value || "generic"] || value || "Generic ERP"; }

export function sourceState(source: DataSource) {
  if (source.status === "offline") return { tone: "error", title: "连接异常", detail: "请重新测试数据库连接" };
  if (!source.insight) return { tone: "neutral", title: "已连接，待分析", detail: "进入详情读取 ERP Schema" };
  if (!source.insight.mappingValidation.valid) return { tone: "error", title: "Mapping Validation 失败", detail: `${source.insight.mappingValidation.errors.length} 个映射异常` };
  if (source.insight.unresolvedFields.length) return { tone: "warning", title: "Schema Mapping 待完善", detail: `${source.insight.unresolvedFields.length} 个字段待确认` };
  if (source.insight.mappingStatus !== "published") return { tone: "warning", title: source.insight.draftVersion ? "存在未发布 Draft" : "Mapping 尚未发布", detail: "当前为 Demo 兼容模式" };
  return { tone: "success", title: "ERP Schema 已校验", detail: "关键 Mapping / Join 已分析" };
}

export function DatasourceStatusCard({ source, onClick }: { source: DataSource; onClick: () => void }) {
  const state = sourceState(source);
  const entityCount = source.insight?.semanticSchema.length || 0;
  const coverage = Math.round((source.insight?.mappingConfidence || 0) * 100);
  return <button className="datasource-status-card" onClick={onClick}>
    <span className="source-title"><span className={`status-dot ${source.status}`} />{source.name}<span className="chevron-icon chevron-right" aria-hidden="true" /></span>
    <span className="source-meta">{source.engine}{source.insight ? ` · ${erpLabel(source.insight.erpType)}` : ""}</span>
    {source.insight && <span className="source-health-grid"><span>实体 {entityCount} / 9</span><span>Mapping {coverage}%</span><span>Join {source.insight.joinPaths.length}</span></span>}
    <span className={`source-understanding ${state.tone}`}><i />{state.title}</span>
  </button>;
}
