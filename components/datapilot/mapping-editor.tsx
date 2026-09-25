import { ERP_ENTITY_DEFINITIONS } from "../../server/domain/erp/schema-mapping/entities";
import type { JoinPathDefinition, SemanticEntityMapping } from "./types";

type RawSchema = { name: string; columns: { name: string; type: string; comment: string }[] }[];

export function MappingEditor({ entities, rawSchema, onChange }: { entities: SemanticEntityMapping[]; rawSchema: RawSchema; onChange: (entities: SemanticEntityMapping[]) => void }) {
  const available = ERP_ENTITY_DEFINITIONS.filter((definition) => !entities.some((item) => item.entity === definition.entity));
  function update(index: number, next: SemanticEntityMapping) { onChange(entities.map((item, itemIndex) => itemIndex === index ? next : item)); }
  function add(entity: string) {
    const definition = ERP_ENTITY_DEFINITIONS.find((item) => item.entity === entity); if (!definition) return;
    onChange([...entities, { entity: definition.entity, table: rawSchema[0]?.name || "", confidence: 1, fields: {}, fieldMappings: {}, mappingSource: "manual", matchReasons: ["人工确认"], unresolvedFields: definition.fields.filter((field) => field.required).map((field) => field.name) }]);
  }
  return <div className="mapping-editor">
    <div className="editor-add-row"><label>添加 ERP 实体<select defaultValue="" onChange={(event) => { add(event.target.value); event.target.value = ""; }}><option value="" disabled>选择实体…</option>{available.map((item) => <option key={item.entity} value={item.entity}>{item.entity} · {item.description}</option>)}</select></label></div>
    {entities.map((mapping, index) => {
      const definition = ERP_ENTITY_DEFINITIONS.find((item) => item.entity === mapping.entity); const table = rawSchema.find((item) => item.name === mapping.table);
      return <article className="mapping-editor-card" key={mapping.entity}><header><div><h3>{mapping.entity}</h3><span className="manual-badge">{mapping.mappingSource} · confidence {Math.round(mapping.confidence * 100)}%</span></div><button onClick={() => onChange(entities.filter((_, itemIndex) => itemIndex !== index))}>移除实体</button></header>
        <label className="table-select">真实数据表<select value={mapping.table} onChange={(event) => update(index, { ...mapping, table: event.target.value, fields: {}, fieldMappings: {}, unresolvedFields: definition?.fields.filter((field) => field.required).map((field) => field.name) || [] })}>{rawSchema.map((item) => <option key={item.name} value={item.name}>{item.name} · {item.columns.length} 列</option>)}</select></label>
        <div className="field-editor-head"><span>业务字段</span><span>真实字段（来自 {mapping.table}）</span><span>字段信息</span></div>
        <div className="field-editor-list">{definition?.fields.map((field) => {
          const selected = mapping.fields[field.name] || ""; const column = table?.columns.find((item) => item.name === selected);
          return <div className="field-editor-row" key={field.name}><label><code>{field.name}</code>{field.required && <em>必需</em>}<small>{field.description}{mapping.fieldMappings[field.name] ? ` · confidence ${Math.round(mapping.fieldMappings[field.name].confidence * 100)}%` : ""}</small></label><select value={selected} onChange={(event) => {
            const fields = { ...mapping.fields }; if (event.target.value) fields[field.name] = event.target.value; else delete fields[field.name];
            update(index, { ...mapping, fields, unresolvedFields: definition.fields.filter((item) => item.required && !fields[item.name]).map((item) => item.name) });
          }}><option value="">未映射</option>{table?.columns.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select><span>{column ? <><code>{column.type}</code><small>{column.comment || "无字段注释"}</small></> : "—"}</span></div>;
        })}</div>
      </article>;
    })}
  </div>;
}

export function JoinPathEditor({ joins, entities, onChange }: { joins: JoinPathDefinition[]; entities: SemanticEntityMapping[]; onChange: (joins: JoinPathDefinition[]) => void }) {
  function update(index: number, next: JoinPathDefinition) { onChange(joins.map((item, itemIndex) => itemIndex === index ? next : item)); }
  function newJoin(): JoinPathDefinition { const left = entities[0]; const right = entities[1] || entities[0]; return { id: `draft-${Date.now()}`, leftEntity: left?.entity || "VoucherEntry", rightEntity: right?.entity || "Account", leftTable: left?.table || "", rightTable: right?.table || "", fields: [], joinType: "left", confidence: 1, source: "manual", validated: false }; }
  return <div className="join-editor"><div className="section-heading"><div><h3>Draft Join Paths</h3><p>字段只能从当前 Entity Mapping 的业务字段中选择，支持复合 Join。</p></div><button onClick={() => onChange([...joins, newJoin()])} disabled={entities.length < 2}>＋ 新增 Join</button></div>
    {joins.map((join, index) => {
      const left = entities.find((item) => item.entity === join.leftEntity); const right = entities.find((item) => item.entity === join.rightEntity);
      return <article className="join-editor-card" key={join.id}><header><select value={join.leftEntity} onChange={(event) => update(index, { ...join, leftEntity: event.target.value as typeof join.leftEntity, fields: [] })}>{entities.map((item) => <option key={item.entity} value={item.entity}>{item.entity}</option>)}</select><span>→</span><select value={join.rightEntity} onChange={(event) => update(index, { ...join, rightEntity: event.target.value as typeof join.rightEntity, fields: [] })}>{entities.map((item) => <option key={item.entity} value={item.entity}>{item.entity}</option>)}</select><select value={join.joinType} onChange={(event) => update(index, { ...join, joinType: event.target.value as "left" | "inner" })}><option value="left">LEFT JOIN</option><option value="inner">INNER JOIN</option></select><button onClick={() => onChange(joins.filter((_, itemIndex) => itemIndex !== index))}>删除</button></header>
        <div className="join-pair-editor">{join.fields.map((pair, pairIndex) => <div key={pairIndex}><select value={pair.leftField} onChange={(event) => update(index, { ...join, fields: join.fields.map((item, fieldIndex) => fieldIndex === pairIndex ? { ...item, leftField: event.target.value } : item) })}>{Object.keys(left?.fields || {}).map((field) => <option key={field}>{field}</option>)}</select><span>=</span><select value={pair.rightField} onChange={(event) => update(index, { ...join, fields: join.fields.map((item, fieldIndex) => fieldIndex === pairIndex ? { ...item, rightField: event.target.value } : item) })}>{Object.keys(right?.fields || {}).map((field) => <option key={field}>{field}</option>)}</select><button onClick={() => update(index, { ...join, fields: join.fields.filter((_, fieldIndex) => fieldIndex !== pairIndex) })}>×</button></div>)}<button onClick={() => { const leftField = Object.keys(left?.fields || {})[0]; const rightField = Object.keys(right?.fields || {})[0]; if (leftField && rightField) update(index, { ...join, fields: [...join.fields, { leftField, rightField }] }); }}>＋ 增加字段对</button></div>
      </article>;
    })}
  </div>;
}
