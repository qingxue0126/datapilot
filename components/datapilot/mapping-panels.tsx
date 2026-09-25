import type { JoinPathDefinition, SchemaMappingResponse, SemanticEntityMapping } from "./types";

function percent(value?: number) { return value === undefined ? "—" : `${(value * 100).toFixed(value > .99 ? 0 : 1)}%`; }
function confidenceTone(value: number) { return value >= .9 ? "high" : value >= .75 ? "medium" : "low"; }

export function MappingOverview({ mapping }: { mapping: SchemaMappingResponse }) {
  const cards = [
    ["原始数据表", mapping.rawSchema.length],
    ["ERP 实体", `${mapping.semanticSchema.length} / 9`],
    ["Mapping 完整度", percent(mapping.mappingConfidence)],
    ["Validated Joins", mapping.joinPaths.length],
    ["未解析字段", mapping.unresolvedFields.length],
    ["Validation", mapping.mappingValidation.valid ? "Passed" : "Failed"],
  ];
  return <div className="mapping-overview">{cards.map(([label, value]) => <article key={label}><span>{label}</span><strong>{value}</strong></article>)}</div>;
}

export function FieldMappingRow({ semanticField, mapping }: { semanticField: string; mapping: SemanticEntityMapping }) {
  const detail = mapping.fieldMappings[semanticField];
  return <div className="field-mapping-row">
    <code>{semanticField}</code><span>→</span><code>{mapping.fields[semanticField]}</code>
    <span className={`confidence ${confidenceTone(detail?.confidence || 0)}`}>{percent(detail?.confidence)}</span>
  </div>;
}

export function EntityMappingCard({ mapping, focused = false }: { mapping: SemanticEntityMapping; focused?: boolean }) {
  const sources = new Set(Object.values(mapping.fieldMappings).map((item) => item.source));
  const source = sources.size > 1 ? "mixed" : mapping.mappingSource;
  return <article className={`entity-card ${focused ? "focused" : ""}`} id={`entity-${mapping.entity}`}>
    <header><div><h3>{mapping.entity}</h3><p>→ <code>{mapping.table}</code></p></div><div><span className={`confidence ${confidenceTone(mapping.confidence)}`}>{percent(mapping.confidence)}</span><small>{source}</small></div></header>
    <div className="field-mapping-list">{Object.keys(mapping.fields).map((field) => <FieldMappingRow key={field} semanticField={field} mapping={mapping} />)}</div>
    {mapping.unresolvedFields.length > 0 && <footer><strong>未识别字段</strong><span>{mapping.unresolvedFields.join(" · ")}</span></footer>}
  </article>;
}

export function JoinPathCard({ path, candidate = false }: { path: JoinPathDefinition; candidate?: boolean }) {
  return <article className={`join-card ${path.validated ? "validated" : "candidate"}`}>
    <header><div><span className="join-node">{path.leftEntity}</span><b>↓</b><span className="join-node">{path.rightEntity}</span></div><span className={`validation-pill ${path.validated ? "passed" : "pending"}`}>{path.validated ? "Validated" : "Candidate · Not validated"}</span></header>
    <div className="join-field-pairs">{path.fields.map((pair, index) => <div key={`${pair.leftField}-${pair.rightField}-${index}`}><code>{pair.leftField}</code><span>=</span><code>{pair.rightField}</code></div>)}</div>
    <footer><span>Source <strong>{path.source}</strong></span><span>Confidence <strong>{percent(path.confidence)}</strong></span><span>Match Rate <strong>{percent(path.validation?.matchRate)}</strong></span><span>Right Unique <strong>{percent(path.validation?.rightUniqueRate)}</strong></span></footer>
    {candidate && path.validation?.errors?.length ? <ul className="validation-errors">{path.validation.errors.map((error) => <li key={error}>{error}</li>)}</ul> : null}
  </article>;
}

export function MappingValidationPanel({ mapping }: { mapping: SchemaMappingResponse }) {
  return <div className="validation-panel">
    <section><header><h3>Schema Validation</h3><span className={mapping.mappingValidation.valid ? "passed" : "failed"}>{mapping.mappingValidation.valid ? "Passed" : "Failed"}</span></header>
      {mapping.mappingValidation.valid ? <ul className="check-list"><li>✓ 数据表存在</li><li>✓ 已映射字段存在</li><li>✓ Mapping Registry 与当前 Schema 一致</li></ul> : <ul className="validation-errors">{mapping.mappingValidation.errors.map((error) => <li key={error}>✕ {error}</li>)}</ul>}
    </section>
    {mapping.joinPaths.map((path) => <section key={path.id}><header><h3>{path.leftEntity} → {path.rightEntity}</h3><span className="passed">Passed</span></header><ul className="check-list"><li>✓ Join 字段存在</li><li>✓ 类型兼容</li><li>✓ Match Rate {percent(path.validation?.matchRate)}</li><li>✓ Right Unique Rate {percent(path.validation?.rightUniqueRate)}</li></ul></section>)}
    {(mapping.joinCandidates || []).map((path) => <section key={path.id}><header><h3>{path.leftEntity} → {path.rightEntity}</h3><span className="failed">Not validated</span></header><ul className="validation-errors">{path.validation?.errors?.map((error) => <li key={error}>⚠ {error}</li>) || <li>⚠ 尚未完成真实性校验</li>}</ul></section>)}
    {mapping.mappingSamples.length > 0 && <section><header><h3>Mapping Samples</h3><span>最多 20 个去重样本</span></header><div className="sample-grid">{mapping.mappingSamples.map((sample) => <div key={`${sample.entity}-${sample.field}`}><code>{sample.entity}.{sample.field}</code><span>{sample.values.join(" · ") || "无样本"}</span></div>)}</div></section>}
  </div>;
}
