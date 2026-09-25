import { getSchema, type SchemaTable } from "../database.js";
import { PermissionService } from "../auth/permission-service.js";
import { mapErpSchema } from "../domain/erp/schema-mapping/adapters.js";
import { createErpAdapter } from "../domain/erp/schema-mapping/adapters.js";
import { loadErpSchemaMappingConfig } from "../domain/erp/schema-mapping/config.js";
import { MappingRegistryStore, mappingFingerprint, registryMatchesSchema } from "../domain/erp/schema-mapping/mapping-registry.js";
import { buildValidatedMapping, withMySqlMappingProbe } from "../domain/erp/schema-mapping/mapping-validation.js";
import type { SchemaSearchResult } from "../domain/erp/schema-mapping/types.js";
import type { AgentTool, ToolContext } from "./tool-registry.js";

export class SchemaSearchTool implements AgentTool<{ question: string }, SchemaSearchResult> {
  name = "schema.search";
  description = "检索当前租户账套中与问题相关且有权限访问的表和字段";
  constructor(private readonly permissions: PermissionService, private readonly registry = new MappingRegistryStore()) {}
  async execute(input: { question: string }, context: ToolContext) {
    this.permissions.require(context.request, "database:read");
    const schema = this.permissions.filterSchema(context.request, await getSchema(context.connection));
    const tokens = input.question.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
    const rawSchema = schema.map((table) => ({ table, score: score(table, tokens) })).sort((a, b) => b.score - a.score).slice(0, 30).map((item) => item.table);
    const config = await loadErpSchemaMappingConfig(context.connection.database);
    const mapped = mapErpSchema(schema, config);
    const fingerprint = mappingFingerprint(schema, config);
    const registryKey = {
      tenantId: context.request.tenantId,
      accountSetId: context.request.accountSetId,
      datasourceId: context.datasourceId,
      database: context.connection.database,
      erpType: mapped.erpType,
    };
    const cached = this.registry.get(registryKey);
    if (cached && registryMatchesSchema(cached, schema, fingerprint)) {
      return summarize({ ...mapped, rawSchema, semanticSchema: cached.entities, joinPaths: cached.joinPaths, registryVersion: cached.version });
    }
    const adapter = createErpAdapter(mapped.erpType);
    const validation = await withMySqlMappingProbe(context.connection, (probe) => buildValidatedMapping({
      schema,
      mappings: mapped.semanticSchema,
      config,
      adapterCandidates: adapter.joinCandidates(mapped.semanticSchema),
      probe,
    }));
    const result = summarize({ ...mapped, rawSchema, ...validation });
    if (!validation.mappingValidation.valid) return result;
    const saved = this.registry.save({ ...registryKey, entities: mapped.semanticSchema, joinPaths: validation.joinPaths, schemaFingerprint: fingerprint });
    return { ...result, registryVersion: saved.version };
  }
}

function summarize(result: SchemaSearchResult): SchemaSearchResult {
  const sources = new Set(result.semanticSchema.map((item) => item.mappingSource));
  return {
    ...result,
    mappingConfidence: round(result.semanticSchema.length ? result.semanticSchema.reduce((sum, item) => sum + item.confidence, 0) / result.semanticSchema.length : 0),
    mappingSource: sources.size > 1 ? "mixed" : sources.values().next().value || "auto",
    unresolvedFields: result.semanticSchema.flatMap((mapping) => mapping.unresolvedFields.map((field) => `${mapping.entity}.${field}`)),
  };
}

function score(table: SchemaTable, tokens: string[]) {
  const text = `${table.name} ${table.columns.map((column) => `${column.name} ${column.comment}`).join(" ")}`.toLowerCase();
  return tokens.reduce((total, token) => total + (text.includes(token) ? 1 : 0), 0);
}
function round(value: number) { return Math.round(value * 100) / 100; }
