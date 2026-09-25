import { getSchema, type DatabaseConfig, type SchemaTable } from "../../../database.js";
import type { RequestContext } from "../../../core/types.js";
import type { PermissionService } from "../../../auth/permission-service.js";
import { ERP_ENTITY_DEFINITIONS } from "./entities.js";
import { mappingFingerprint, type MappingRegistryKey, MappingRegistryStore } from "./mapping-registry.js";
import { validateJoinCandidates, validateMappings, withMySqlMappingProbe } from "./mapping-validation.js";
import type { JoinPathDefinition, MappingRegistryVersion, MappingValidationSummary, SemanticEntityMapping } from "./types.js";

export type MappingDraftInput = {
  erpType: string;
  entities: SemanticEntityMapping[];
  joinPaths: JoinPathDefinition[];
  changeSummary?: string;
};

export class MappingReviewService {
  constructor(private readonly registry: MappingRegistryStore, private readonly permissions: PermissionService) {}

  key(context: RequestContext, datasourceId: string, database: string, erpType: string): MappingRegistryKey {
    return { tenantId: context.tenantId, accountSetId: context.accountSetId, datasourceId, database, erpType };
  }

  async saveDraft(input: { context: RequestContext; datasourceId: string; connection: DatabaseConfig; draft: MappingDraftInput }) {
    this.permissions.require(input.context, "schema_mapping:write");
    const schema = await this.schema(input.context, input.connection);
    const entities = normalizeEntities(input.draft.entities, schema);
    const joins = normalizeJoins(input.draft.joinPaths, entities);
    const validation = structuralValidation(schema, entities, joins);
    const key = this.key(input.context, input.datasourceId, input.connection.database, input.draft.erpType);
    return this.registry.saveDraft(key, {
      entities, joinPaths: joins, schemaFingerprint: mappingFingerprint(schema), validation,
      changeSummary: input.draft.changeSummary?.trim().slice(0, 300),
    }, input.context.userId);
  }

  async validateDraft(input: { context: RequestContext; datasourceId: string; connection: DatabaseConfig; erpType: string; draft?: MappingDraftInput }) {
    this.permissions.require(input.context, "schema_mapping:write");
    const key = this.key(input.context, input.datasourceId, input.connection.database, input.erpType);
    let version: MappingRegistryVersion | undefined;
    if (input.draft) version = await this.saveDraft({ ...input, draft: input.draft });
    else version = this.registry.getDraft(key);
    if (!version) throw new Error("当前数据源没有可校验的 Mapping 草稿");
    const result = await this.validateVersion(input.context, input.connection, version);
    return this.registry.updateDraftValidation(key, result.validation, result.joinPaths, result.joinCandidates);
  }

  async publish(input: { context: RequestContext; datasourceId: string; connection: DatabaseConfig; erpType: string }) {
    this.permissions.require(input.context, "schema_mapping:publish");
    const key = this.key(input.context, input.datasourceId, input.connection.database, input.erpType);
    const draft = this.registry.getDraft(key); if (!draft) throw new Error("当前数据源没有可发布的 Mapping 草稿");
    const checked = await this.validateVersion(input.context, input.connection, draft);
    this.registry.updateDraftValidation(key, checked.validation, checked.joinPaths, checked.joinCandidates);
    if (!checked.validation.valid) throw new Error(`无法发布 Mapping：${checked.validation.errors.join("；")}`);
    return this.registry.publishDraft(key, input.context.userId);
  }

  async rollback(input: { context: RequestContext; datasourceId: string; connection: DatabaseConfig; erpType: string; version: number; changeSummary?: string }) {
    this.permissions.require(input.context, "schema_mapping:publish");
    const key = this.key(input.context, input.datasourceId, input.connection.database, input.erpType);
    const historical = this.registry.getVersion(key, input.version); if (!historical) throw new Error(`Mapping 版本 v${input.version} 不存在`);
    const checked = await this.validateVersion(input.context, input.connection, historical);
    if (!checked.validation.valid) throw new Error(`无法回滚 Mapping：${checked.validation.errors.join("；")}`);
    return this.registry.rollback(key, input.version, checked.validation, input.context.userId, input.changeSummary);
  }

  async validateVersion(context: RequestContext, connection: DatabaseConfig, version: Pick<MappingRegistryVersion, "entities" | "joinPaths">) {
    const schema = await this.schema(context, connection);
    const structural = structuralValidation(schema, version.entities, version.joinPaths);
    if (!structural.valid) return { validation: structural, joinPaths: [], joinCandidates: version.joinPaths.map((path) => ({ ...path, validated: false, validation: { checked: true, errors: structural.errors } })) };
    const checked = await withMySqlMappingProbe(connection, (probe) => validateJoinCandidates(schema, version.entities, normalizeJoins(version.joinPaths, version.entities), probe));
    const validated = checked.filter((path) => path.validated); const rejected = checked.filter((path) => !path.validated);
    const errors = [...rejected.flatMap((path) => path.validation?.errors?.map((error) => `${path.leftEntity} → ${path.rightEntity}: ${error}`) || []), ...requiredJoinErrors(version.entities, validated)];
    return { validation: { valid: errors.length === 0, errors }, joinPaths: validated, joinCandidates: rejected };
  }

  private async schema(context: RequestContext, connection: DatabaseConfig) {
    this.permissions.require(context, "schema_mapping:read");
    return this.permissions.filterSchema(context, await getSchema(connection));
  }
}

export function structuralValidation(schema: SchemaTable[], entities: SemanticEntityMapping[], joins: JoinPathDefinition[]): MappingValidationSummary {
  const base = validateMappings(schema, entities); const errors = [...base.errors];
  for (const mapping of entities) {
    const definition = ERP_ENTITY_DEFINITIONS.find((item) => item.entity === mapping.entity);
    const table = schema.find((item) => same(item.name, mapping.table));
    for (const field of definition?.fields.filter((item) => item.required) || []) if (!mapping.fields[field.name]) errors.push(`${mapping.entity} 缺少关键字段：${field.name}`);
    for (const [field, columnName] of Object.entries(mapping.fields)) {
      const column = table?.columns.find((item) => same(item.name, columnName));
      if (column && !semanticallyCompatible(field, column.name, column.comment, column.type)) errors.push(`${mapping.entity}.${field} 映射字段不满足当前业务语义要求：${mapping.table}.${column.name}`);
    }
  }
  for (const join of joins) {
    const left = entities.find((item) => item.entity === join.leftEntity); const right = entities.find((item) => item.entity === join.rightEntity);
    if (!left || !right) errors.push(`${join.leftEntity} → ${join.rightEntity} 的实体映射不存在`);
    if (!join.fields.length) errors.push(`${join.leftEntity} → ${join.rightEntity} 至少需要一个 Join 字段`);
    for (const pair of join.fields) {
      if (!left?.fields[pair.leftField]) errors.push(`${join.leftEntity}.${pair.leftField} 未映射`);
      if (!right?.fields[pair.rightField]) errors.push(`${join.rightEntity}.${pair.rightField} 未映射`);
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

function normalizeEntities(entities: SemanticEntityMapping[], schema: SchemaTable[]) {
  return entities.map((mapping) => {
    const table = schema.find((item) => same(item.name, mapping.table)); const fields: Record<string, string> = {}; const fieldMappings: SemanticEntityMapping["fieldMappings"] = {};
    for (const [field, column] of Object.entries(mapping.fields || {})) if (column) {
      fields[field] = column; fieldMappings[field] = { column, confidence: table?.columns.some((item) => same(item.name, column)) ? 1 : 0, source: "manual", reason: "人工确认" };
    }
    const definition = ERP_ENTITY_DEFINITIONS.find((item) => item.entity === mapping.entity);
    return { ...mapping, fields, fieldMappings, confidence: 1, mappingSource: "manual" as const, matchReasons: ["人工确认"], unresolvedFields: definition?.fields.filter((item) => item.required && !fields[item.name]).map((item) => item.name) || [] };
  });
}

function normalizeJoins(joins: JoinPathDefinition[], entities: SemanticEntityMapping[]) {
  return joins.map((path, index) => ({ ...path, id: path.id || `manual:${path.leftEntity}:${path.rightEntity}:${index}`, leftTable: entities.find((item) => item.entity === path.leftEntity)?.table || "", rightTable: entities.find((item) => item.entity === path.rightEntity)?.table || "", source: "manual" as const, confidence: 1, validated: false, validation: undefined }));
}

function requiredJoinErrors(entities: SemanticEntityMapping[], validated: JoinPathDefinition[]) {
  const pairs: [SemanticEntityMapping["entity"], SemanticEntityMapping["entity"]][] = [["VoucherEntry", "Account"], ["Receivable", "Customer"], ["Payable", "Supplier"]];
  return pairs.filter(([left, right]) => entities.some((item) => item.entity === left) && entities.some((item) => item.entity === right))
    .filter(([left, right]) => !validated.some((path) => (path.leftEntity === left && path.rightEntity === right) || (path.leftEntity === right && path.rightEntity === left)))
    .map(([left, right]) => `${left} → ${right} Join 未通过验证`);
}

function semanticallyCompatible(field: string, column: string, comment: string, type: string) {
  const text = `${column} ${comment}`.toLowerCase();
  if (/amount|balance/i.test(field) && !/(decimal|numeric|double|float|int|bigint)/i.test(type)) return false;
  if (/date$/i.test(field) && !/(date|time|year|char|text)/i.test(type)) return false;
  if (/code$/i.test(field) && /(name|名称)/i.test(text) && !/(code|编码|编号)/i.test(text)) return false;
  return true;
}
function same(left: string, right: string) { return left.toLowerCase() === right.toLowerCase(); }
