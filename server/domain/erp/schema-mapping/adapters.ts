import type { SchemaTable } from "../../../database.js";
import { ERP_ENTITY_DEFINITIONS } from "./entities.js";
import type {
  ErpEntityDefinition, ErpEntityName, ErpSchemaMappingConfig, MappingSource,
  SchemaSearchResult, SemanticEntityMapping, SemanticFieldMapping, StandardFieldDefinition,
} from "./types.js";

type AdapterProfile = {
  tables?: Partial<Record<ErpEntityName, string[]>>;
  fields?: Partial<Record<ErpEntityName, Record<string, string[]>>>;
};

export interface ErpAdapter {
  readonly erpType: ErpSchemaMappingConfig["erpType"];
  map(schema: SchemaTable[], manualConfig?: ErpSchemaMappingConfig): Omit<SchemaSearchResult, "rawSchema">;
}

export class GenericErpAdapter implements ErpAdapter {
  readonly erpType: ErpSchemaMappingConfig["erpType"] = "generic";
  protected readonly profile: AdapterProfile = {};

  map(schema: SchemaTable[], manualConfig?: ErpSchemaMappingConfig): Omit<SchemaSearchResult, "rawSchema"> {
    const semanticSchema = ERP_ENTITY_DEFINITIONS
      .map((definition) => mapEntity(definition, schema, this.profile, manualConfig?.mappings[definition.entity]))
      .filter((mapping): mapping is SemanticEntityMapping => Boolean(mapping));
    const sources = new Set(semanticSchema.map((mapping) => mapping.mappingSource));
    return {
      semanticSchema,
      mappingConfidence: round(semanticSchema.length ? semanticSchema.reduce((sum, item) => sum + item.confidence, 0) / semanticSchema.length : 0),
      mappingSource: sources.size > 1 ? "mixed" : sources.values().next().value || "auto",
      unresolvedFields: semanticSchema.flatMap((mapping) => mapping.unresolvedFields.map((field) => `${mapping.entity}.${field}`)),
      erpType: this.erpType,
    };
  }
}

export class YongyouAdapter extends GenericErpAdapter {
  override readonly erpType = "yongyou" as const;
  protected override readonly profile: AdapterProfile = {
    tables: { Voucher: ["gl_accvouch"], VoucherEntry: ["gl_accvouch"], Account: ["code"], Customer: ["customer"], Supplier: ["vendor"], Department: ["department"] },
    fields: {
      Voucher: { id: ["iperiod", "ino_id"], voucherNo: ["ino_id"], voucherDate: ["dbill_date"], status: ["iflag", "cbill"] },
      VoucherEntry: { voucherId: ["ino_id"], voucherDate: ["dbill_date"], accountCode: ["ccode"], debitAmount: ["md"], creditAmount: ["mc"], customerId: ["ccus_id"], supplierId: ["csup_id"], departmentId: ["cdept_id"] },
      Account: { code: ["ccode"], name: ["ccode_name"], category: ["cclass"] },
    },
  };
}

export class KingdeeAdapter extends GenericErpAdapter {
  override readonly erpType = "kingdee" as const;
  protected override readonly profile: AdapterProfile = {
    tables: { Voucher: ["t_gl_voucher"], VoucherEntry: ["t_gl_voucherentry"], Account: ["t_bd_account"], Customer: ["t_bd_customer"], Supplier: ["t_bd_supplier"], Department: ["t_bd_department"] },
    fields: {
      Voucher: { id: ["fid"], voucherNo: ["fvoucherno", "fnumber"], voucherDate: ["fdate"], status: ["fdocumentstatus"], organizationId: ["faccountbookid"] },
      VoucherEntry: { voucherId: ["fbillid"], accountCode: ["faccountid"], debitAmount: ["fdebit"], creditAmount: ["fcredit"], currency: ["fcurrencyid"], customerId: ["fcustomerid"], supplierId: ["fsupplierid"], departmentId: ["fdeptid"] },
    },
  };
}

export class QiqiAdapter extends GenericErpAdapter {
  override readonly erpType = "qiqi" as const;
  protected override readonly profile: AdapterProfile = {
    tables: { Voucher: ["accounting_voucher"], VoucherEntry: ["accounting_voucher_detail", "voucher_line"], Account: ["account_subject"], Receivable: ["receivable_bill"], Payable: ["payable_bill"] },
  };
}

export function createErpAdapter(erpType: string): ErpAdapter {
  if (erpType === "yongyou") return new YongyouAdapter();
  if (erpType === "kingdee") return new KingdeeAdapter();
  if (erpType === "qiqi") return new QiqiAdapter();
  return new GenericErpAdapter();
}

export function mapErpSchema(schema: SchemaTable[], config?: ErpSchemaMappingConfig): SchemaSearchResult {
  const adapter = createErpAdapter(config?.erpType || "generic");
  return { rawSchema: schema, ...adapter.map(schema, config) };
}

function mapEntity(
  definition: ErpEntityDefinition,
  schema: SchemaTable[],
  profile: AdapterProfile,
  manual?: { table: string; fields?: Record<string, string> },
): SemanticEntityMapping | undefined {
  const aliases = [...definition.tableAliases, ...(profile.tables?.[definition.entity] || [])];
  const manualTable = manual && findTable(schema, manual.table);
  const candidates = manualTable ? [{ table: manualTable, tableScore: 1, tableReason: "人工配置指定表" }] : schema.map((table) => {
    const match = bestTextMatch(table.name, aliases, "table");
    return { table, tableScore: match.score, tableReason: match.reason };
  });

  let best: SemanticEntityMapping | undefined;
  for (const candidate of candidates) {
    const mapped = mapFields(definition, candidate.table, profile.fields?.[definition.entity] || {}, manual?.fields || {});
    const required = definition.fields.filter((item) => item.required);
    const requiredCoverage = required.length ? required.filter((item) => mapped.fields[item.name]).length / required.length : 0;
    const signature = definition.signatureFields || [];
    const hasSignature = signature.length > 0 && signature.every((name) => (mapped.fieldMappings[name]?.confidence || 0) >= 0.8);
    if (!manualTable && candidate.tableScore < 0.65 && !hasSignature) continue;
    const confidence = manualTable
      ? round((1 + average(Object.values(mapped.fieldMappings).map((item) => item.confidence))) / 2)
      : round(Math.min(0.99, Math.max(candidate.tableScore, 0.5 + requiredCoverage * 0.35 + (hasSignature ? 0.12 : 0))));
    if (!manualTable && confidence < 0.72) continue;
    const mappingSource: MappingSource = manualTable || Object.values(mapped.fieldMappings).some((item) => item.source === "manual") ? "manual" : "auto";
    const result: SemanticEntityMapping = {
      entity: definition.entity,
      table: candidate.table.name,
      confidence,
      fields: mapped.fields,
      fieldMappings: mapped.fieldMappings,
      mappingSource,
      matchReasons: [candidate.tableReason, ...mapped.reasons].filter(Boolean).slice(0, 8),
      unresolvedFields: required.filter((item) => !mapped.fields[item.name]).map((item) => item.name),
    };
    if (!best || result.confidence > best.confidence) best = result;
  }
  return best;
}

function mapFields(definition: ErpEntityDefinition, table: SchemaTable, profileFields: Record<string, string[]>, manualFields: Record<string, string>) {
  const fields: Record<string, string> = {};
  const fieldMappings: Record<string, SemanticFieldMapping> = {};
  const reasons: string[] = [];
  const used = new Set<string>();
  const ordered = [...definition.fields].sort((a, b) => Number(b.required) - Number(a.required));

  for (const standard of ordered) {
    const manualColumn = manualFields[standard.name];
    const exactManual = manualColumn && table.columns.find((column) => normalize(column.name) === normalize(manualColumn));
    if (exactManual && !used.has(exactManual.name)) {
      assign(standard.name, exactManual.name, 1, "manual", "人工配置指定字段");
      continue;
    }
    const aliases = [...standard.aliases, ...(profileFields[standard.name] || [])];
    const ranked = table.columns
      .filter((column) => !used.has(column.name))
      .map((column) => ({ column, match: matchColumn(column, standard, aliases) }))
      .sort((a, b) => b.match.score - a.match.score);
    const winner = ranked[0];
    if (winner && winner.match.score >= 0.74) assign(standard.name, winner.column.name, winner.match.score, "auto", winner.match.reason);
  }
  return { fields, fieldMappings, reasons };

  function assign(name: string, column: string, confidence: number, source: MappingSource, reason: string) {
    fields[name] = column;
    fieldMappings[name] = { column, confidence: round(confidence), source, reason };
    used.add(column);
    reasons.push(`${name}→${column}：${reason}`);
  }
}

function matchColumn(column: SchemaTable["columns"][number], fieldDefinition: StandardFieldDefinition, aliases: string[]) {
  const comment = normalize(column.comment);
  const commentAliases = [...fieldDefinition.commentAliases, fieldDefinition.description].map(normalize).filter(Boolean);
  if (comment) {
    if (commentAliases.some((alias) => comment === alias)) return { score: 0.96, reason: `字段注释“${column.comment}”精确匹配` };
    if (commentAliases.some((alias) => comment.includes(alias))) return { score: 0.92, reason: `字段注释“${column.comment}”语义匹配` };
  }
  return bestTextMatch(column.name, aliases, "field");
}

function bestTextMatch(value: string, aliases: string[], kind: "table" | "field") {
  const normalized = normalize(value);
  let best = { score: 0, reason: "" };
  for (const aliasValue of aliases) {
    const alias = normalize(aliasValue);
    if (!alias) continue;
    if (normalized === alias) return { score: kind === "table" ? 0.92 : 0.9, reason: `标准别名“${aliasValue}”精确匹配` };
    const lengthRatio = Math.min(normalized.length, alias.length) / Math.max(normalized.length, alias.length);
    if (Math.min(normalized.length, alias.length) >= 3 && lengthRatio >= 0.65 && (normalized.includes(alias) || alias.includes(normalized))) {
      if (0.82 > best.score) best = { score: 0.82, reason: `标准别名“${aliasValue}”包含匹配` };
    }
    const similarity = dice(normalized, alias);
    const score = similarity >= 0.72 ? 0.62 + similarity * 0.2 : 0;
    if (score > best.score) best = { score, reason: `名称与“${aliasValue}”相似` };
  }
  return best;
}

function findTable(schema: SchemaTable[], name: string) { return schema.find((table) => normalize(table.name) === normalize(name)); }
function normalize(value: string) { return String(value || "").toLowerCase().replace(/[^a-z0-9\p{Script=Han}]+/gu, ""); }
function dice(left: string, right: string) {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const pairs = new Map<string, number>();
  for (let index = 0; index < left.length - 1; index += 1) pairs.set(left.slice(index, index + 2), (pairs.get(left.slice(index, index + 2)) || 0) + 1);
  let overlap = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const pair = right.slice(index, index + 2); const count = pairs.get(pair) || 0;
    if (count) { overlap += 1; pairs.set(pair, count - 1); }
  }
  return (2 * overlap) / (left.length + right.length - 2);
}
function average(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function round(value: number) { return Math.round(value * 100) / 100; }
