import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseConfig } from "../../shared/types/database.js";
import { readEncryptedJson, writeEncryptedJson } from "../../infrastructure/storage/encrypted-json.js";

export type StoredConnection = {
  tenantId: string;
  accountSetId: string;
  ownerId?: string;
  permission?: "private" | "tenant";
  config: DatabaseConfig;
  createdAt: number;
  details: { version: string; tables: number; latencyMs?: number };
};

const storePath = resolve(process.cwd(), ".data", "connections.enc.json");
const keyPath = resolve(process.cwd(), ".data", "connection.key");

export function loadConnections() {
  const map = new Map<string, StoredConnection>();
  if (!existsSync(storePath)) return map;
  try {
    for (const item of readEncryptedJson<{ id: string; value: Partial<StoredConnection> & Pick<StoredConnection, "config" | "createdAt" | "details"> }[]>(storePath, keyPath, process.env.CONNECTION_ENCRYPTION_KEY)) {
      map.set(item.id, {
        ...item.value,
        tenantId: item.value.tenantId || "demo-tenant",
        accountSetId: item.value.accountSetId || "default-account-set",
        permission: item.value.permission === "tenant" ? "tenant" : item.value.ownerId ? "private" : undefined,
      });
    }
  } catch (error) {
    console.error("无法读取已保存的数据源：", error instanceof Error ? error.message : "未知错误");
  }
  return map;
}

export function saveConnections(connections: Map<string, StoredConnection>) {
  writeEncryptedJson(storePath, keyPath, [...connections.entries()].map(([id, value]) => ({ id, value })), process.env.CONNECTION_ENCRYPTION_KEY);
}
