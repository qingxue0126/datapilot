import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RequestContext } from "../core/types.js";
import { modelProviders, modelTasks, type ModelConfig, type ModelConfigInput, type ModelRoute, type ModelTask, type RuntimeModelConfig } from "./model-types.js";

type ModelRow = Record<string, unknown>;
type RouteRow = Record<string, unknown>;

export class ModelStoreError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export class ModelStore {
  private readonly database: DatabaseSync;
  private readonly encryptionKey: Buffer;

  constructor(databasePath = process.env.MODEL_DB_PATH || resolve(".data", "models.sqlite"), encryptionKey?: Buffer) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.encryptionKey = encryptionKey || loadEncryptionKey();
    this.database.exec("PRAGMA foreign_keys = ON");
    if (databasePath !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  list(context: RequestContext): ModelConfig[] {
    this.ensureLegacyModel(context);
    return this.database.prepare(`${selectModels} WHERE tenant_id=? AND account_set_id=? AND user_id=? ORDER BY created_at ASC`)
      .all(context.tenantId, context.accountSetId, context.userId).map((row) => publicModel(row as ModelRow, this.encryptionKey));
  }

  get(context: RequestContext, id: string): ModelConfig {
    return publicModel(this.getRow(context, id), this.encryptionKey);
  }

  runtime(context: RequestContext, id: string): RuntimeModelConfig {
    const row = this.getRow(context, id);
    return { ...publicModel(row, this.encryptionKey), apiKey: decryptSecret(String(row.api_key_encrypted || ""), this.encryptionKey) };
  }

  create(context: RequestContext, input: ModelConfigInput): ModelConfig {
    const value = validateModelInput(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO model_configs (
      id,tenant_id,account_set_id,user_id,name,provider,model_id,base_url,api_key_encrypted,context_window,timeout,max_retries,temperature,
      supports_tools,supports_structured_output,supports_vision,enabled,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, context.tenantId, context.accountSetId, context.userId, value.name, value.provider, value.modelId, value.baseUrl,
      encryptSecret(value.apiKey || "", this.encryptionKey), value.contextWindow, value.timeout, value.maxRetries, value.temperature,
      flag(value.supportsTools), flag(value.supportsStructuredOutput), flag(value.supportsVision), flag(value.enabled), now, now,
    );
    return this.get(context, id);
  }

  update(context: RequestContext, id: string, input: Partial<ModelConfigInput> & { clearApiKey?: boolean }): ModelConfig {
    const current = this.getRow(context, id);
    const merged = validateModelInput({
      name: input.name ?? String(current.name), provider: input.provider ?? String(current.provider) as ModelConfigInput["provider"],
      modelId: input.modelId ?? String(current.model_id), baseUrl: input.baseUrl ?? String(current.base_url),
      apiKey: input.apiKey || decryptSecret(String(current.api_key_encrypted || ""), this.encryptionKey),
      contextWindow: input.contextWindow ?? Number(current.context_window), timeout: input.timeout ?? Number(current.timeout),
      maxRetries: input.maxRetries ?? Number(current.max_retries), temperature: input.temperature ?? Number(current.temperature),
      supportsTools: input.supportsTools ?? Boolean(current.supports_tools),
      supportsStructuredOutput: input.supportsStructuredOutput ?? Boolean(current.supports_structured_output),
      supportsVision: input.supportsVision ?? Boolean(current.supports_vision), enabled: input.enabled ?? Boolean(current.enabled),
    });
    const secret = input.clearApiKey ? "" : (input.apiKey?.trim() ? input.apiKey.trim() : decryptSecret(String(current.api_key_encrypted || ""), this.encryptionKey));
    const now = new Date().toISOString();
    this.database.prepare(`UPDATE model_configs SET name=?,provider=?,model_id=?,base_url=?,api_key_encrypted=?,context_window=?,timeout=?,max_retries=?,temperature=?,supports_tools=?,supports_structured_output=?,supports_vision=?,enabled=?,updated_at=? WHERE id=? AND tenant_id=? AND account_set_id=? AND user_id=?`).run(
      merged.name, merged.provider, merged.modelId, merged.baseUrl, encryptSecret(secret, this.encryptionKey), merged.contextWindow, merged.timeout,
      merged.maxRetries, merged.temperature, flag(merged.supportsTools), flag(merged.supportsStructuredOutput), flag(merged.supportsVision), flag(merged.enabled), now,
      id, context.tenantId, context.accountSetId, context.userId,
    );
    return this.get(context, id);
  }

  delete(context: RequestContext, id: string) {
    this.getRow(context, id);
    this.database.prepare("DELETE FROM model_configs WHERE id=? AND tenant_id=? AND account_set_id=? AND user_id=?")
      .run(id, context.tenantId, context.accountSetId, context.userId);
  }

  setTestResult(context: RequestContext, id: string, result: { success: boolean; latencyMs: number; error?: string }) {
    this.getRow(context, id);
    this.database.prepare("UPDATE model_configs SET last_test_status=?,last_test_latency_ms=?,last_test_error=?,last_tested_at=?,updated_at=? WHERE id=? AND tenant_id=? AND account_set_id=? AND user_id=?")
      .run(result.success ? "success" : "failed", result.latencyMs, result.error?.slice(0, 500) || null, new Date().toISOString(), new Date().toISOString(), id, context.tenantId, context.accountSetId, context.userId);
  }

  listRoutes(context: RequestContext): ModelRoute[] {
    const rows = this.database.prepare("SELECT * FROM model_routes WHERE tenant_id=? AND account_set_id=? AND user_id=?")
      .all(context.tenantId, context.accountSetId, context.userId) as RouteRow[];
    const indexed = new Map(rows.map((row) => [String(row.task), routeFromRow(row)]));
    return modelTasks.map((task) => indexed.get(task) || defaultRoute(task));
  }

  saveRoute(context: RequestContext, task: ModelTask, input: Partial<Omit<ModelRoute, "task" | "updatedAt">>): ModelRoute {
    if (!modelTasks.includes(task)) throw new ModelStoreError("不支持的模型路由任务");
    const current = this.listRoutes(context).find((item) => item.task === task) || defaultRoute(task);
    const route = validateRoute({ ...current, ...input, task });
    for (const id of [route.primaryModelId, route.fallbackModelId]) if (id) this.get(context, id);
    if (route.primaryModelId && route.primaryModelId === route.fallbackModelId) throw new ModelStoreError("主模型和备用模型不能相同");
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO model_routes (tenant_id,account_set_id,user_id,task,primary_model_id,fallback_model_id,temperature,timeout,max_retries,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,account_set_id,user_id,task) DO UPDATE SET primary_model_id=excluded.primary_model_id,fallback_model_id=excluded.fallback_model_id,temperature=excluded.temperature,timeout=excluded.timeout,max_retries=excluded.max_retries,updated_at=excluded.updated_at`)
      .run(context.tenantId, context.accountSetId, context.userId, task, route.primaryModelId, route.fallbackModelId, route.temperature, route.timeout, route.maxRetries, now);
    return { ...route, updatedAt: now };
  }

  private getRow(context: RequestContext, id: string): ModelRow {
    const row = this.database.prepare(`${selectModels} WHERE id=? AND tenant_id=? AND account_set_id=? AND user_id=?`)
      .get(id, context.tenantId, context.accountSetId, context.userId) as ModelRow | undefined;
    if (!row) throw new ModelStoreError("模型不存在或无权访问", 404);
    return row;
  }

  private ensureLegacyModel(context: RequestContext) {
    const count = this.database.prepare("SELECT COUNT(*) AS count FROM model_configs WHERE tenant_id=? AND account_set_id=? AND user_id=?")
      .get(context.tenantId, context.accountSetId, context.userId) as { count: number };
    if (Number(count.count)) return;
    this.create(context, {
      name: "DeepSeek Chat", provider: "deepseek", modelId: process.env.DEEPSEEK_MODEL || "deepseek-chat",
      baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com", apiKey: process.env.DEEPSEEK_API_KEY || "",
      contextWindow: 64_000, timeout: 60_000, maxRetries: 2, temperature: 0,
      supportsTools: true, supportsStructuredOutput: true, supportsVision: false, enabled: true,
    });
  }

  private migrate() {
    this.database.exec(`CREATE TABLE IF NOT EXISTS model_configs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, account_set_id TEXT NOT NULL, user_id TEXT NOT NULL,
      name TEXT NOT NULL, provider TEXT NOT NULL, model_id TEXT NOT NULL, base_url TEXT NOT NULL, api_key_encrypted TEXT NOT NULL,
      context_window INTEGER NOT NULL, timeout INTEGER NOT NULL, max_retries INTEGER NOT NULL, temperature REAL NOT NULL,
      supports_tools INTEGER NOT NULL DEFAULT 0, supports_structured_output INTEGER NOT NULL DEFAULT 0, supports_vision INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1, last_test_status TEXT, last_test_latency_ms INTEGER, last_test_error TEXT, last_tested_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_models_owner ON model_configs(tenant_id,account_set_id,user_id);
    CREATE TABLE IF NOT EXISTS model_routes (
      tenant_id TEXT NOT NULL, account_set_id TEXT NOT NULL, user_id TEXT NOT NULL, task TEXT NOT NULL,
      primary_model_id TEXT, fallback_model_id TEXT, temperature REAL NOT NULL, timeout INTEGER NOT NULL, max_retries INTEGER NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id,account_set_id,user_id,task),
      FOREIGN KEY(primary_model_id) REFERENCES model_configs(id) ON DELETE SET NULL,
      FOREIGN KEY(fallback_model_id) REFERENCES model_configs(id) ON DELETE SET NULL
    );`);
  }
}

const selectModels = "SELECT * FROM model_configs";
function flag(value: boolean) { return value ? 1 : 0; }
function clean(value: unknown, field: string) { const text = String(value || "").trim(); if (!text) throw new ModelStoreError(`${field} 不能为空`); return text; }
function numeric(value: unknown, field: string, min: number, max: number) { const number = Number(value); if (!Number.isFinite(number) || number < min || number > max) throw new ModelStoreError(`${field} 必须在 ${min}-${max} 之间`); return number; }
function validateModelInput(input: ModelConfigInput): ModelConfigInput {
  const provider = clean(input.provider, "provider") as ModelConfigInput["provider"];
  if (!modelProviders.includes(provider)) throw new ModelStoreError("不支持的 Provider");
  const baseUrl = clean(input.baseUrl, "baseUrl").replace(/\/$/, "");
  try { new URL(baseUrl); } catch { throw new ModelStoreError("baseUrl 必须是有效 URL"); }
  return { ...input, name: clean(input.name, "name").slice(0, 100), provider, modelId: clean(input.modelId, "modelId").slice(0, 200), baseUrl,
    apiKey: input.apiKey?.trim() || "", contextWindow: Math.floor(numeric(input.contextWindow, "contextWindow", 1, 10_000_000)),
    timeout: Math.floor(numeric(input.timeout, "timeout", 1000, 600_000)), maxRetries: Math.floor(numeric(input.maxRetries, "maxRetries", 0, 10)),
    temperature: numeric(input.temperature, "temperature", 0, 2), supportsTools: Boolean(input.supportsTools),
    supportsStructuredOutput: Boolean(input.supportsStructuredOutput), supportsVision: Boolean(input.supportsVision), enabled: Boolean(input.enabled) };
}
function publicModel(row: ModelRow, key: Buffer): ModelConfig {
  const secret = String(row.api_key_encrypted || "");
  const apiKey = secret ? decryptSecret(secret, key) : "";
  return { id: String(row.id), name: String(row.name), provider: String(row.provider) as ModelConfig["provider"], modelId: String(row.model_id), baseUrl: String(row.base_url),
    apiKeyMasked: maskSecret(apiKey), apiKeyConfigured: Boolean(apiKey),
    contextWindow: Number(row.context_window), timeout: Number(row.timeout), maxRetries: Number(row.max_retries), temperature: Number(row.temperature),
    supportsTools: Boolean(row.supports_tools), supportsStructuredOutput: Boolean(row.supports_structured_output), supportsVision: Boolean(row.supports_vision), enabled: Boolean(row.enabled),
    lastTestStatus: row.last_test_status as ModelConfig["lastTestStatus"] || null, lastTestLatencyMs: row.last_test_latency_ms == null ? null : Number(row.last_test_latency_ms),
    lastTestError: row.last_test_error == null ? null : String(row.last_test_error), lastTestedAt: row.last_tested_at == null ? null : String(row.last_tested_at),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

function routeFromRow(row: RouteRow): ModelRoute {
  return { task: String(row.task) as ModelTask, primaryModelId: row.primary_model_id ? String(row.primary_model_id) : null,
    fallbackModelId: row.fallback_model_id ? String(row.fallback_model_id) : null, temperature: Number(row.temperature),
    timeout: Number(row.timeout), maxRetries: Number(row.max_retries), updatedAt: String(row.updated_at) };
}
function defaultRoute(task: ModelTask): ModelRoute {
  return { task, primaryModelId: null, fallbackModelId: null, temperature: 0, timeout: 60_000, maxRetries: 2, updatedAt: "" };
}
function validateRoute(route: ModelRoute): ModelRoute {
  return { ...route, primaryModelId: route.primaryModelId || null, fallbackModelId: route.fallbackModelId || null,
    temperature: numeric(route.temperature, "temperature", 0, 2), timeout: Math.floor(numeric(route.timeout, "timeout", 1000, 600_000)),
    maxRetries: Math.floor(numeric(route.maxRetries, "maxRetries", 0, 10)) };
}
function maskSecret(secret: string) {
  if (!secret) return "";
  const prefix = secret.slice(0, Math.min(secret.startsWith("sk-") ? 3 : 2, secret.length));
  return `${prefix}****${secret.slice(-4)}`;
}
function encryptSecret(secret: string, key: Buffer) {
  if (!secret) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((item) => item.toString("base64")).join(":");
}
function decryptSecret(value: string, key: Buffer) {
  if (!value) return "";
  try {
    const [iv, tag, encrypted] = value.split(":").map((item) => Buffer.from(item, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch { throw new ModelStoreError("模型密钥无法解密，请检查 MODEL_ENCRYPTION_KEY", 500); }
}
function loadEncryptionKey() {
  const configured = process.env.MODEL_ENCRYPTION_KEY?.trim();
  if (configured) return createHash("sha256").update(configured).digest();
  const path = resolve(".data", "model.key");
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) return Buffer.from(readFileSync(path, "utf8").trim(), "base64");
  const key = randomBytes(32);
  writeFileSync(path, key.toString("base64"), { mode: 0o600 });
  return key;
}
