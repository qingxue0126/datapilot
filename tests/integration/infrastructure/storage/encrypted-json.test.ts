import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readEncryptedJson, writeEncryptedJson } from "../../../../server/infrastructure/storage/encrypted-json.js";

test("encrypted storage reads legacy envelopes and writes envelopes readable by the legacy reader", () => {
  const directory = mkdtempSync(join(tmpdir(), "datapilot-encrypted-json-"));
  const file = join(directory, "connections.enc.json"), keyFile = join(directory, "connection.key");
  const secret = "regression-encryption-key", key = createHash("sha256").update(secret).digest();
  const value = [{ id: "datasource", value: { tenantId: "tenant", config: { password: "private" } } }];
  try {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    writeFileSync(file, JSON.stringify({ iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }));
    assert.deepEqual(readEncryptedJson(file, keyFile, secret), value);
    writeEncryptedJson(file, keyFile, value, secret);
    const envelope = JSON.parse(readFileSync(file, "utf8"));
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8")), value);
    assert.throws(() => readEncryptedJson(file, keyFile, "wrong-key"));
    writeEncryptedJson(file, keyFile, value);
    assert.deepEqual(readEncryptedJson(file, keyFile), value);
    assert.equal(Buffer.from(readFileSync(keyFile, "utf8"), "base64").length, 32);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
