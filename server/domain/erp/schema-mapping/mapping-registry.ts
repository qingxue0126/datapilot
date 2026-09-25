import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SchemaTable } from "../../../database.js";
import type {
  ErpMappingRegistry, ErpSchemaMappingConfig, JoinPathDefinition, MappingAuditRecord,
  MappingRegistryVersion, MappingValidationSummary, MappingVersionDiff, SemanticEntityMapping,
} from "./types.js";

export type MappingRegistryKey = Pick<ErpMappingRegistry,
  "tenantId" | "accountSetId" | "datasourceId" | "database" | "erpType"
>;

type RegistryFile = {
  autoMappings: ErpMappingRegistry[];
  versions: MappingRegistryVersion[];
  audits: MappingAuditRecord[];
};

type VersionContent = {
  entities: SemanticEntityMapping[];
  joinPaths: JoinPathDefinition[];
  joinCandidates?: JoinPathDefinition[];
  schemaFingerprint: string;
  validation?: MappingValidationSummary;
  changeSummary?: string;
};

export class MappingRegistryStore {
  private readonly autoMappings = new Map<string, ErpMappingRegistry>();
  private versions: MappingRegistryVersion[] = [];
  private audits: MappingAuditRecord[] = [];

  constructor(private readonly filePath = resolve(process.cwd(), ".data", "erp-mapping-registry.json")) { this.load(); }

  /** Automatic mappings are a compatibility cache, not production versions. */
  get(key: MappingRegistryKey) { return this.autoMappings.get(registryKey(key)); }
  save(input: MappingRegistryKey & VersionContent) {
    const key = registryKey(input); const previous = this.autoMappings.get(key);
    const record: ErpMappingRegistry = {
      ...input, joinCandidates: input.joinCandidates || [],
      version: (previous?.version || 0) + 1, updatedAt: new Date().toISOString(),
    };
    this.autoMappings.set(key, record); this.flush(); return record;
  }

  getPublished(key: MappingRegistryKey) { return this.matchingVersions(key).find((item) => item.status === "published"); }
  resolveForQuery(key: MappingRegistryKey) {
    const published = this.getPublished(key);
    return published ? { status: "published" as const, record: published } : { status: "unpublished" as const, record: this.get(key) };
  }
  getDraft(key: MappingRegistryKey) { return this.matchingVersions(key).find((item) => item.status === "draft"); }
  getVersion(key: MappingRegistryKey, version: number) { return this.matchingVersions(key).find((item) => item.version === version); }
  listVersions(key: MappingRegistryKey) { return this.matchingVersions(key).sort((a, b) => b.version - a.version); }
  listAudits(key: MappingRegistryKey) { return this.audits.filter((item) => sameRegistry(item, key)).sort((a, b) => b.timestamp.localeCompare(a.timestamp)); }

  saveDraft(key: MappingRegistryKey, content: VersionContent, operator: string) {
    const now = new Date().toISOString(); const existing = this.getDraft(key);
    const draft: MappingRegistryVersion = existing ? {
      ...existing, ...cloneContent(content), status: "draft", updatedAt: now,
      changeSummary: content.changeSummary,
    } : {
      id: randomUUID(), ...key, ...cloneContent(content), version: this.nextVersion(key), status: "draft",
      validation: content.validation || { valid: false, errors: ["草稿尚未执行完整校验"] },
      createdAt: now, updatedAt: now, createdBy: operator, changeSummary: content.changeSummary,
    };
    this.versions = this.versions.filter((item) => item.id !== draft.id).concat(draft);
    this.audit(key, draft.version, "draft_saved", operator, content.changeSummary); this.flush(); return structuredClone(draft);
  }

  updateDraftValidation(key: MappingRegistryKey, validation: MappingValidationSummary, joinPaths: JoinPathDefinition[], joinCandidates: JoinPathDefinition[]) {
    const draft = this.getDraft(key); if (!draft) throw new Error("当前数据源没有可校验的 Mapping 草稿");
    const updated = { ...draft, validation, joinPaths: structuredClone(joinPaths), joinCandidates: structuredClone(joinCandidates), updatedAt: new Date().toISOString() };
    this.versions = this.versions.filter((item) => item.id !== draft.id).concat(updated); this.flush(); return structuredClone(updated);
  }

  publishDraft(key: MappingRegistryKey, operator: string) {
    const draft = this.getDraft(key); if (!draft) throw new Error("当前数据源没有可发布的 Mapping 草稿");
    if (!draft.validation.valid) throw new Error(`无法发布 Mapping：${draft.validation.errors.join("；")}`);
    if (draft.joinPaths.some((path) => !path.validated)) throw new Error("无法发布 Mapping：草稿包含未通过验证的 Join Path");
    const now = new Date().toISOString();
    this.versions = this.versions.map((item) => sameRegistry(item, key) && item.status === "published"
      ? { ...item, status: "archived" as const, updatedAt: now }
      : item.id === draft.id ? { ...item, status: "published" as const, publishedAt: now, publishedBy: operator, updatedAt: now } : item);
    const published = this.getPublished(key)!;
    this.audit(key, published.version, "published", operator, published.changeSummary); this.flush(); return structuredClone(published);
  }

  rollback(key: MappingRegistryKey, sourceVersion: number, validation: MappingValidationSummary, operator: string, changeSummary?: string) {
    const source = this.getVersion(key, sourceVersion);
    if (!source || source.status === "draft") throw new Error("只能回滚到已发布或已归档的历史版本");
    if (!validation.valid) throw new Error(`无法回滚 Mapping：${validation.errors.join("；")}`);
    const now = new Date().toISOString(); const nextVersion = this.nextVersion(key);
    const rolledBack: MappingRegistryVersion = {
      ...structuredClone(source), id: randomUUID(), version: nextVersion, status: "published",
      validation, createdAt: now, updatedAt: now, publishedAt: now, createdBy: operator, publishedBy: operator,
      changeSummary: changeSummary || `回滚到 v${sourceVersion}`, rollbackFromVersion: sourceVersion,
    };
    this.versions = this.versions.map((item) => sameRegistry(item, key) && item.status === "published" ? { ...item, status: "archived" as const, updatedAt: now } : item).concat(rolledBack);
    this.audit(key, nextVersion, "rolled_back", operator, rolledBack.changeSummary); this.flush(); return structuredClone(rolledBack);
  }

  diff(key: MappingRegistryKey, version: number, compareVersion?: number) {
    const current = this.getVersion(key, version); if (!current) throw new Error(`Mapping 版本 v${version} 不存在`);
    const previous = compareVersion === undefined
      ? this.listVersions(key).filter((item) => item.version < version && item.status !== "draft")[0]
      : this.getVersion(key, compareVersion);
    return diffVersions(previous, current);
  }

  private matchingVersions(key: MappingRegistryKey) { return this.versions.filter((item) => sameRegistry(item, key)).map((item) => structuredClone(item)); }
  private nextVersion(key: MappingRegistryKey) { return Math.max(0, ...this.matchingVersions(key).map((item) => item.version)) + 1; }
  private audit(key: MappingRegistryKey, version: number, action: MappingAuditRecord["action"], userId: string, changeSummary?: string) {
    this.audits.push({ id: randomUUID(), ...key, version, action, timestamp: new Date().toISOString(), userId, changeSummary });
  }

  private load() {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as RegistryFile | ErpMappingRegistry[];
      const data: RegistryFile = Array.isArray(parsed) ? { autoMappings: parsed, versions: [], audits: [] } : parsed;
      for (const item of data.autoMappings || []) this.autoMappings.set(registryKey(item), item);
      this.versions = Array.isArray(data.versions) ? data.versions : [];
      this.audits = Array.isArray(data.audits) ? data.audits : [];
    } catch (error) { console.error("无法读取 ERP Mapping Registry：", error instanceof Error ? error.message : "未知错误"); }
  }

  private flush() {
    mkdirSync(dirname(this.filePath), { recursive: true }); const tempPath = `${this.filePath}.tmp`;
    const data: RegistryFile = { autoMappings: [...this.autoMappings.values()], versions: this.versions, audits: this.audits };
    writeFileSync(tempPath, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 }); renameSync(tempPath, this.filePath);
  }
}

export function mappingFingerprint(schema: SchemaTable[], config?: ErpSchemaMappingConfig) {
  const stableSchema = schema.map((table) => ({ name: table.name, columns: table.columns.map(({ name, type, comment }) => ({ name, type, comment })) }));
  return createHash("sha256").update(JSON.stringify({ mappingEngineVersion: 3, schema: stableSchema, config: config || null })).digest("hex");
}

export function registryMatchesSchema(record: Pick<ErpMappingRegistry, "entities" | "joinPaths" | "schemaFingerprint">, schema: SchemaTable[], fingerprint: string) {
  if (record.schemaFingerprint !== fingerprint) return false;
  return record.entities.every((mapping) => {
    const table = schema.find((item) => same(item.name, mapping.table));
    return Boolean(table && Object.values(mapping.fields).every((column) => table.columns.some((item) => same(item.name, column))));
  }) && record.joinPaths.every((path) => path.validated && path.validation?.checked);
}

export function diffVersions(before: MappingRegistryVersion | undefined, after: MappingRegistryVersion): MappingVersionDiff {
  const oldFields = flattenFields(before?.entities || []); const newFields = flattenFields(after.entities);
  const addedMappings: string[] = []; const removedMappings: string[] = []; const changedMappings: MappingVersionDiff["changedMappings"] = [];
  for (const [field, column] of newFields) {
    if (!oldFields.has(field)) addedMappings.push(`${field} → ${column}`);
    else if (oldFields.get(field) !== column) changedMappings.push({ field, before: oldFields.get(field)!, after: column });
  }
  for (const [field, column] of oldFields) if (!newFields.has(field)) removedMappings.push(`${field} → ${column}`);
  const oldJoins = new Set((before?.joinPaths || []).map(joinSignature)); const newJoins = new Set(after.joinPaths.map(joinSignature));
  return { addedMappings, changedMappings, removedMappings, addedJoins: [...newJoins].filter((item) => !oldJoins.has(item)), removedJoins: [...oldJoins].filter((item) => !newJoins.has(item)) };
}

function flattenFields(entities: SemanticEntityMapping[]) { const result = new Map<string, string>(); for (const entity of entities) for (const [field, column] of Object.entries(entity.fields)) result.set(`${entity.entity}.${field}`, column); return result; }
function joinSignature(path: JoinPathDefinition) { return `${path.leftEntity} → ${path.rightEntity}: ${path.fields.map((item) => `${item.leftField}=${item.rightField}`).join(" + ")}`; }
function cloneContent(content: VersionContent) { return { entities: structuredClone(content.entities), joinPaths: structuredClone(content.joinPaths), joinCandidates: structuredClone(content.joinCandidates || []), schemaFingerprint: content.schemaFingerprint, validation: structuredClone(content.validation || { valid: false, errors: ["草稿尚未执行完整校验"] }) }; }
function registryKey(key: MappingRegistryKey) { return [key.tenantId, key.accountSetId, key.datasourceId, key.database, key.erpType].map((value) => encodeURIComponent(value)).join("|"); }
function sameRegistry(left: MappingRegistryKey, right: MappingRegistryKey) { return registryKey(left) === registryKey(right); }
function same(left: string, right: string) { return left.toLowerCase() === right.toLowerCase(); }
