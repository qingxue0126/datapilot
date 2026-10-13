import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readEncryptedJson<T>(storePath: string, keyPath: string, configuredKey?: string): T {
  const envelope = JSON.parse(readFileSync(storePath, "utf8")) as { iv: string; tag: string; data: string };
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(keyPath, configuredKey), Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
  return JSON.parse(plain) as T;
}

export function writeEncryptedJson(storePath: string, keyPath: string, value: unknown, configuredKey?: string) {
  mkdirSync(dirname(storePath), { recursive: true });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(keyPath, configuredKey), iv);
  const plain = JSON.stringify(value);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const envelope = JSON.stringify({ iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") });
  const tempPath = `${storePath}.tmp`;
  writeFileSync(tempPath, envelope, { encoding: "utf8", mode: 0o600 });
  renameSync(tempPath, storePath);
}

function encryptionKey(keyPath: string, configuredValue?: string) {
  const configured = configuredValue?.trim();
  if (configured) return createHash("sha256").update(configured).digest();
  mkdirSync(dirname(keyPath), { recursive: true });
  if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32).toString("base64"), { encoding: "utf8", mode: 0o600 });
  return Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
}
