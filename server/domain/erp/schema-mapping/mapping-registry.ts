import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SchemaTable } from "../../../database.js";
import type { ErpMappingRegistry, ErpSchemaMappingConfig, JoinPathDefinition, SemanticEntityMapping } from "./types.js";

export type MappingRegistryKey = Pick<ErpMappingRegistry,
  "tenantId" | "accountSetId" | "datasourceId" | "database" | "erpType"
>;

export class MappingRegistryStore {
  private readonly records = new Map<string, ErpMappingRegistry>();

  constructor(private readonly filePath = resolve(process.cwd(), ".data", "erp-mapping-registry.json")) {
    this.load();
  }

  get(key: MappingRegistryKey) { return this.records.get(registryKey(key)); }

  save(input: MappingRegistryKey & { entities: SemanticEntityMapping[]; joinPaths: JoinPathDefinition[]; schemaFingerprint: string }) {
    const key = registryKey(input);
    const previous = this.records.get(key);
    const record: ErpMappingRegistry = {
      ...input,
      version: (previous?.version || 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(key, record);
    this.flush();
    return record;
  }

  private load() {
    if (!existsSync(this.filePath)) return;
    try {
      const items = JSON.parse(readFileSync(this.filePath, "utf8")) as ErpMappingRegistry[];
      for (const item of Array.isArray(items) ? items : []) this.records.set(registryKey(item), item);
    } catch (error) {
      console.error("无法读取 ERP Mapping Registry：", error instanceof Error ? error.message : "未知错误");
    }
  }

  private flush() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify([...this.records.values()], null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, this.filePath);
  }
}

export function mappingFingerprint(schema: SchemaTable[], config?: ErpSchemaMappingConfig) {
  const stableSchema = schema.map((table) => ({ name: table.name, columns: table.columns.map(({ name, type, comment }) => ({ name, type, comment })) }));
  return createHash("sha256").update(JSON.stringify({ mappingEngineVersion: 2, schema: stableSchema, config: config || null })).digest("hex");
}

export function registryMatchesSchema(record: ErpMappingRegistry, schema: SchemaTable[], fingerprint: string) {
  if (record.schemaFingerprint !== fingerprint) return false;
  return record.entities.every((mapping) => {
    const table = schema.find((item) => same(item.name, mapping.table));
    return Boolean(table && Object.values(mapping.fields).every((column) => table.columns.some((item) => same(item.name, column))));
  }) && record.joinPaths.every((path) => path.validated && path.validation?.checked);
}

function registryKey(key: MappingRegistryKey) {
  return [key.tenantId, key.accountSetId, key.datasourceId, key.database, key.erpType].map((value) => encodeURIComponent(value)).join("|");
}
function same(left: string, right: string) { return left.toLowerCase() === right.toLowerCase(); }
