import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseConfig } from "./database.js";

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
    const envelope = JSON.parse(readFileSync(storePath, "utf8")) as { iv: string; tag: string; data: string };
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
    for (const item of JSON.parse(plain) as { id: string; value: Partial<StoredConnection> & Pick<StoredConnection, "config" | "createdAt" | "details"> }[]) {
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
  mkdirSync(dirname(storePath), { recursive: true });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const plain = JSON.stringify([...connections.entries()].map(([id, value]) => ({ id, value })));
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const envelope = JSON.stringify({ iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") });
  const tempPath = `${storePath}.tmp`;
  writeFileSync(tempPath, envelope, { encoding: "utf8", mode: 0o600 });
  renameSync(tempPath, storePath);
}

function encryptionKey() {
  const configured = process.env.CONNECTION_ENCRYPTION_KEY?.trim();
  if (configured) return createHash("sha256").update(configured).digest();
  mkdirSync(dirname(keyPath), { recursive: true });
  if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32).toString("base64"), { encoding: "utf8", mode: 0o600 });
  return Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
}
