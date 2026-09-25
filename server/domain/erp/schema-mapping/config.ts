import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ERP_ENTITY_NAMES, type ErpSchemaMappingConfig } from "./types.js";

export async function loadErpSchemaMappingConfig(database?: string, filePath = resolve(process.cwd(), "config", "erp-schema-mapping.json")) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<ErpSchemaMappingConfig>;
    if (!parsed || !["generic", "yongyou", "kingdee", "qiqi"].includes(String(parsed.erpType))) return undefined;
    if (parsed.database && database && parsed.database !== database) return undefined;
    const mappings = Object.fromEntries(Object.entries(parsed.mappings || {}).filter(([entity, mapping]) =>
      ERP_ENTITY_NAMES.includes(entity as typeof ERP_ENTITY_NAMES[number]) && mapping && typeof mapping === "object" && typeof (mapping as { table?: unknown }).table === "string"));
    return { erpType: parsed.erpType!, database: parsed.database, mappings } as ErpSchemaMappingConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`ERP Schema Mapping 配置无效：${error instanceof Error ? error.message : "无法读取配置"}`);
  }
}
