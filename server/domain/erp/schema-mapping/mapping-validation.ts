import { createHash } from "node:crypto";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { withDatabase, type DatabaseConfig, type SchemaTable } from "../../../database.js";
import type {
  ErpEntityName, ErpSchemaMappingConfig, JoinFieldPair, JoinPathDefinition, MappingSample,
  MappingValidationSummary, SemanticEntityMapping,
} from "./types.js";

export type DatabaseForeignKey = {
  id: string;
  leftTable: string;
  rightTable: string;
  fields: { leftColumn: string; rightColumn: string }[];
};

export interface MappingProbe {
  foreignKeys(): Promise<DatabaseForeignKey[]>;
  uniqueness(table: string, columns: string[], sampleSize: number): Promise<number | undefined>;
  joinMatchRate(leftTable: string, rightTable: string, fields: { leftColumn: string; rightColumn: string }[], sampleSize: number): Promise<number | undefined>;
  sampleValues(table: string, column: string, limit: number): Promise<string[]>;
}

const inferredRelations: [ErpEntityName, ErpEntityName, JoinFieldPair[]][] = [
  ["VoucherEntry", "Voucher", [{ leftField: "voucherId", rightField: "id" }]],
  ["VoucherEntry", "Account", [{ leftField: "accountId", rightField: "id" }]],
  ["VoucherEntry", "Account", [{ leftField: "accountCode", rightField: "code" }]],
  ["VoucherEntry", "Customer", [{ leftField: "customerId", rightField: "id" }]],
  ["VoucherEntry", "Supplier", [{ leftField: "supplierId", rightField: "id" }]],
  ["VoucherEntry", "Department", [{ leftField: "departmentId", rightField: "id" }]],
  ["VoucherEntry", "Organization", [{ leftField: "organizationId", rightField: "id" }]],
  ["Receivable", "Customer", [{ leftField: "customerId", rightField: "id" }]],
  ["Payable", "Supplier", [{ leftField: "supplierId", rightField: "id" }]],
  ["Department", "Organization", [{ leftField: "organizationId", rightField: "id" }]],
];

export async function buildValidatedMapping(input: {
  schema: SchemaTable[];
  mappings: SemanticEntityMapping[];
  config?: ErpSchemaMappingConfig;
  adapterCandidates: JoinPathDefinition[];
  probe: MappingProbe;
  sampleSize?: number;
}) {
  const mappingValidation = validateMappings(input.schema, input.mappings, input.config);
  const foreignKeys = await input.probe.foreignKeys().catch(() => []);
  const candidates = discoverJoinCandidates(input.mappings, input.config, foreignKeys, input.adapterCandidates);
  const checked = await validateJoinCandidates(input.schema, input.mappings, candidates, input.probe, input.sampleSize || 200);
  const mappingSamples = await collectMappingSamples(input.mappings, input.probe);
  return {
    mappingValidation,
    joinPaths: checked.filter((path) => path.validated),
    rejectedJoinPaths: checked.filter((path) => !path.validated),
    mappingSamples,
  };
}

export function validateMappings(schema: SchemaTable[], mappings: SemanticEntityMapping[], config?: ErpSchemaMappingConfig): MappingValidationSummary {
  const errors: string[] = [];
  for (const [entity, configured] of Object.entries(config?.mappings || {})) {
    if (!configured) continue;
    const table = findTable(schema, configured.table);
    if (!table) { errors.push(`${entity} 配置的表 ${configured.table} 不存在`); continue; }
    for (const [field, column] of Object.entries(configured.fields || {})) {
      if (!findColumn(table, column)) errors.push(`${entity}.${field} 配置的字段 ${configured.table}.${column} 不存在`);
    }
  }
  for (const mapping of mappings) {
    const table = findTable(schema, mapping.table);
    if (!table) { errors.push(`${mapping.entity} 映射表 ${mapping.table} 不存在`); continue; }
    for (const [field, column] of Object.entries(mapping.fields)) {
      if (!findColumn(table, column)) errors.push(`${mapping.entity}.${field} 映射字段 ${mapping.table}.${column} 不存在`);
    }
  }
  for (const join of config?.joins || []) {
    const left = entity(mappings, join.leftEntity); const right = entity(mappings, join.rightEntity);
    if (!left) errors.push(`人工 Join 的实体 ${join.leftEntity} 未映射`);
    if (!right) errors.push(`人工 Join 的实体 ${join.rightEntity} 未映射`);
    for (const pair of join.fields) {
      if (left && !left.fields[pair.leftField]) errors.push(`人工 Join 字段 ${join.leftEntity}.${pair.leftField} 未映射`);
      if (right && !right.fields[pair.rightField]) errors.push(`人工 Join 字段 ${join.rightEntity}.${pair.rightField} 未映射`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function discoverJoinCandidates(
  mappings: SemanticEntityMapping[],
  config: ErpSchemaMappingConfig | undefined,
  foreignKeys: DatabaseForeignKey[],
  adapterCandidates: JoinPathDefinition[],
) {
  const candidates: JoinPathDefinition[] = [];
  for (const join of config?.joins || []) {
    const left = entity(mappings, join.leftEntity); const right = entity(mappings, join.rightEntity);
    if (!left || !right) continue;
    candidates.push({
      id: join.id || joinId("manual", join.leftEntity, join.rightEntity, join.fields),
      leftEntity: join.leftEntity, rightEntity: join.rightEntity, leftTable: left.table, rightTable: right.table,
      fields: join.fields, joinType: join.joinType || "left", confidence: 1, source: "manual",
      requiredContextFields: join.requiredContextFields, validated: false,
    });
  }
  for (const foreignKey of foreignKeys) {
    const leftMappings = mappings.filter((item) => same(item.table, foreignKey.leftTable));
    const rightMappings = mappings.filter((item) => same(item.table, foreignKey.rightTable));
    for (const left of leftMappings) for (const right of rightMappings) {
      const fields = foreignKey.fields.map((pair) => ({ leftField: semanticField(left, pair.leftColumn), rightField: semanticField(right, pair.rightColumn) }));
      if (fields.some((pair) => !pair.leftField || !pair.rightField)) continue;
      const pairs = fields as JoinFieldPair[];
      candidates.push({ id: `fk:${foreignKey.id}`, leftEntity: left.entity, rightEntity: right.entity, leftTable: left.table, rightTable: right.table, fields: pairs, joinType: "left", confidence: 0.98, source: "database_fk", validated: false });
    }
  }
  candidates.push(...adapterCandidates);
  for (const [leftEntity, rightEntity, fields] of inferredRelations) {
    const left = entity(mappings, leftEntity); const right = entity(mappings, rightEntity);
    if (!left || !right || same(left.table, right.table) || !fields.every((pair) => left.fields[pair.leftField] && right.fields[pair.rightField])) continue;
    candidates.push({ id: joinId("inferred", leftEntity, rightEntity, fields), leftEntity, rightEntity, leftTable: left.table, rightTable: right.table, fields, joinType: "left", confidence: 0.65, source: "inferred", validated: false });
  }
  return deduplicateByPriority(candidates);
}

export async function validateJoinCandidates(schema: SchemaTable[], mappings: SemanticEntityMapping[], candidates: JoinPathDefinition[], probe: MappingProbe, sampleSize = 200) {
  const results: JoinPathDefinition[] = [];
  for (const candidate of candidates.slice(0, 20)) {
    const errors: string[] = [];
    const left = entity(mappings, candidate.leftEntity); const right = entity(mappings, candidate.rightEntity);
    const leftTable = left && findTable(schema, left.table); const rightTable = right && findTable(schema, right.table);
    if (!left || !leftTable) errors.push(`左实体 ${candidate.leftEntity} 的表不存在`);
    if (!right || !rightTable) errors.push(`右实体 ${candidate.rightEntity} 的表不存在`);
    const actualFields: { leftColumn: string; rightColumn: string }[] = [];
    if (left && right && leftTable && rightTable) {
      for (const pair of candidate.fields) {
        const leftColumn = left.fields[pair.leftField]; const rightColumn = right.fields[pair.rightField];
        if (!leftColumn || !findColumn(leftTable, leftColumn)) errors.push(`字段 ${candidate.leftEntity}.${pair.leftField} 不存在`);
        if (!rightColumn || !findColumn(rightTable, rightColumn)) errors.push(`字段 ${candidate.rightEntity}.${pair.rightField} 不存在`);
        if (leftColumn && rightColumn) {
          const leftType = findColumn(leftTable, leftColumn)?.type; const rightType = findColumn(rightTable, rightColumn)?.type;
          if (leftType && rightType && !typesCompatible(leftType, rightType)) errors.push(`类型不兼容：${leftTable.name}.${leftColumn}(${leftType}) ↔ ${rightTable.name}.${rightColumn}(${rightType})`);
          actualFields.push({ leftColumn, rightColumn });
        }
      }
    }
    let leftUniqueRate: number | undefined; let rightUniqueRate: number | undefined; let matchRate: number | undefined;
    if (!errors.length && left && right) {
      try {
        leftUniqueRate = await probe.uniqueness(left.table, actualFields.map((item) => item.leftColumn), sampleSize);
        rightUniqueRate = await probe.uniqueness(right.table, actualFields.map((item) => item.rightColumn), sampleSize);
        matchRate = await probe.joinMatchRate(left.table, right.table, actualFields, sampleSize);
        if (matchRate === undefined) errors.push("无法取得 Join 命中率样本");
        else if (matchRate < 0.8) errors.push(`Join 命中率过低：${round(matchRate)}`);
        if (rightUniqueRate === undefined) errors.push("无法取得右侧唯一率样本");
        else if (rightUniqueRate < 0.9) errors.push(`右侧关联键唯一率过低：${round(rightUniqueRate)}`);
      } catch (error) { errors.push(`Join 探测失败：${error instanceof Error ? error.message : "未知错误"}`); }
    }
    const evidence = 0.6 + 0.25 * (matchRate || 0) + 0.15 * (rightUniqueRate || 0);
    results.push({
      ...candidate,
      confidence: round(candidate.confidence * evidence),
      validated: errors.length === 0,
      validation: { checked: true, matchRate, leftUniqueRate, rightUniqueRate, errors: errors.length ? errors : undefined },
    });
  }
  return results;
}

async function collectMappingSamples(mappings: SemanticEntityMapping[], probe: MappingProbe) {
  const samples: MappingSample[] = [];
  const interesting = new Set(["status", "currency", "accountCode", "organizationId"]);
  for (const mapping of mappings) for (const [field, column] of Object.entries(mapping.fields)) {
    if (!interesting.has(field) || samples.length >= 12) continue;
    const values = await probe.sampleValues(mapping.table, column, 20).catch(() => []);
    samples.push({ entity: mapping.entity, field, table: mapping.table, column, values });
  }
  return samples;
}

export async function withMySqlMappingProbe<T>(config: DatabaseConfig, action: (probe: MappingProbe) => Promise<T>) {
  return withDatabase(config, async (connection) => action(new MySqlMappingProbe(connection)));
}

class MySqlMappingProbe implements MappingProbe {
  constructor(private readonly connection: Connection) {}

  async foreignKeys() {
    const [rows] = await this.connection.query<RowDataPacket[]>(`
      SELECT CONSTRAINT_NAME, TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, ORDINAL_POSITION
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`);
    const grouped = new Map<string, DatabaseForeignKey>();
    for (const row of rows) {
      const key = `${row.CONSTRAINT_NAME}:${row.TABLE_NAME}:${row.REFERENCED_TABLE_NAME}`;
      if (!grouped.has(key)) grouped.set(key, { id: key, leftTable: row.TABLE_NAME, rightTable: row.REFERENCED_TABLE_NAME, fields: [] });
      grouped.get(key)!.fields.push({ leftColumn: row.COLUMN_NAME, rightColumn: row.REFERENCED_COLUMN_NAME });
    }
    return [...grouped.values()];
  }

  async uniqueness(table: string, columns: string[], sampleSize: number) {
    const selected = columns.map(quote).join(", "); const nonNull = columns.map((column) => `${quote(column)} IS NOT NULL`).join(" AND ");
    const key = concatKey(columns);
    const [rows] = await this.connection.query<RowDataPacket[]>(`SELECT COUNT(*) total, COUNT(DISTINCT ${key}) distinct_count FROM (SELECT ${selected} FROM ${quote(table)} WHERE ${nonNull} LIMIT ${limit(sampleSize)}) sampled`);
    const total = Number(rows[0]?.total || 0); return total ? Number(rows[0]?.distinct_count || 0) / total : undefined;
  }

  async joinMatchRate(leftTable: string, rightTable: string, fields: { leftColumn: string; rightColumn: string }[], sampleSize: number) {
    const leftSelect = fields.map((pair, index) => `${quote(pair.leftColumn)} AS ${quote(`k${index}`)}`).join(", ");
    const nonNull = fields.map((pair) => `${quote(pair.leftColumn)} IS NOT NULL`).join(" AND ");
    const conditions = fields.map((pair, index) => `b.${quote(pair.rightColumn)} = a.${quote(`k${index}`)}`).join(" AND ");
    const [rows] = await this.connection.query<RowDataPacket[]>(`SELECT COUNT(*) total, COALESCE(SUM(EXISTS(SELECT 1 FROM ${quote(rightTable)} b WHERE ${conditions} LIMIT 1)), 0) matched FROM (SELECT ${leftSelect} FROM ${quote(leftTable)} WHERE ${nonNull} LIMIT ${limit(sampleSize)}) a`);
    const total = Number(rows[0]?.total || 0); return total ? Number(rows[0]?.matched || 0) / total : undefined;
  }

  async sampleValues(table: string, column: string, rowLimit: number) {
    const [rows] = await this.connection.query<RowDataPacket[]>(`SELECT DISTINCT ${quote(column)} value FROM ${quote(table)} WHERE ${quote(column)} IS NOT NULL LIMIT ${limit(rowLimit)}`);
    return rows.map((row) => String(row.value).slice(0, 200));
  }
}

function deduplicateByPriority(candidates: JoinPathDefinition[]) {
  const priority = { manual: 4, database_fk: 3, profile: 2, inferred: 1 } as const;
  const pairPriority = new Map<string, number>();
  for (const candidate of candidates) {
    const pair = `${candidate.leftEntity}|${candidate.rightEntity}`;
    pairPriority.set(pair, Math.max(pairPriority.get(pair) || 0, priority[candidate.source]));
  }
  const selected = new Map<string, JoinPathDefinition>();
  for (const candidate of candidates) {
    const pair = `${candidate.leftEntity}|${candidate.rightEntity}`;
    if (priority[candidate.source] < (pairPriority.get(pair) || 0)) continue;
    const key = `${candidate.leftEntity}|${candidate.rightEntity}|${candidate.fields.map((pair) => `${pair.leftField}=${pair.rightField}`).join("+")}`;
    const current = selected.get(key);
    if (!current || priority[candidate.source] > priority[current.source]) selected.set(key, candidate);
  }
  return [...selected.values()];
}
function typesCompatible(left: string, right: string) { const a = typeFamily(left); const b = typeFamily(right); return a === b || (a === "numeric" && b === "numeric"); }
function typeFamily(type: string) { const value = type.toLowerCase(); if (/int|decimal|numeric|float|double|real|bit/.test(value)) return "numeric"; if (/char|text|enum|set|json/.test(value)) return "text"; if (/date|time|year/.test(value)) return "temporal"; if (/binary|blob/.test(value)) return "binary"; return value.replace(/\(.*/, ""); }
function entity(mappings: SemanticEntityMapping[], name: ErpEntityName) { return mappings.find((item) => item.entity === name); }
function semanticField(mapping: SemanticEntityMapping, column: string) { return Object.entries(mapping.fields).find(([, actual]) => same(actual, column))?.[0] || ""; }
function findTable(schema: SchemaTable[], name: string) { return schema.find((table) => same(table.name, name)); }
function findColumn(table: SchemaTable, name: string) { return table.columns.find((column) => same(column.name, name)); }
function same(left: string, right: string) { return left.toLowerCase() === right.toLowerCase(); }
function joinId(source: string, left: string, right: string, fields: JoinFieldPair[]) { return `${source}:${createHash("sha1").update(`${left}:${right}:${JSON.stringify(fields)}`).digest("hex").slice(0, 12)}`; }
function quote(identifier: string) { return `\`${identifier.replaceAll("`", "``")}\``; }
function concatKey(columns: string[]) { return `CONCAT_WS(CHAR(31), ${columns.map((column) => `COALESCE(CAST(${quote(column)} AS CHAR), '<NULL>')`).join(", ")})`; }
function limit(value: number) { return Math.min(1000, Math.max(1, Math.trunc(value))); }
function round(value: number) { return Math.round(value * 10000) / 10000; }
