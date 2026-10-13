import { readFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { ERP_ENTITY_NAMES, type ErpSchemaMappingConfig, type ManualJoinDefinition } from "./types.js";

export async function loadErpSchemaMappingConfig(database?: string, filePath = resolve(process.cwd(), "config", "erp-schema-mapping.json")) {
  const extension = extname(filePath);
  const databasePath = database
    ? resolve(dirname(filePath), `${basename(filePath, extension)}.${safeDatabaseName(database)}${extension}`)
    : undefined;
  if (databasePath) {
    const specific = await readConfig(databasePath, database);
    if (specific) return specific;
  }
  return readConfig(filePath, database);
}

async function readConfig(filePath: string, database?: string) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<ErpSchemaMappingConfig>;
    if (!parsed || !["generic", "yongyou", "kingdee", "qiqi"].includes(String(parsed.erpType))) return undefined;
    if (parsed.database && database && parsed.database !== database) return undefined;
    const mappings = Object.fromEntries(Object.entries(parsed.mappings || {}).filter(([entity, mapping]) =>
      ERP_ENTITY_NAMES.includes(entity as typeof ERP_ENTITY_NAMES[number]) && mapping && typeof mapping === "object" && typeof (mapping as { table?: unknown }).table === "string"));
    const joins = (Array.isArray(parsed.joins) ? parsed.joins : []).filter(isManualJoin);
    return { erpType: parsed.erpType!, database: parsed.database, mappings, joins } as ErpSchemaMappingConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`ERP Schema Mapping 配置无效：${error instanceof Error ? error.message : "无法读取配置"}`);
  }
}

function safeDatabaseName(database: string) { return database.replace(/[^a-zA-Z0-9_-]/g, "_"); }

function isManualJoin(value: unknown): value is ManualJoinDefinition {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ManualJoinDefinition>;
  return ERP_ENTITY_NAMES.includes(item.leftEntity!) && ERP_ENTITY_NAMES.includes(item.rightEntity!)
    && Array.isArray(item.fields) && item.fields.length > 0
    && item.fields.every((pair) => pair && typeof pair.leftField === "string" && typeof pair.rightField === "string");
}
