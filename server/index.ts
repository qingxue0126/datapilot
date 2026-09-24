import "dotenv/config";
import { randomUUID } from "node:crypto";
import cors from "cors";
import express from "express";
import { executeReadOnly, getSchema, testDatabase, validateConfig, type DatabaseConfig } from "./database.js";
import { generateSql, summarizeResult } from "./text2sql.js";

const app = express();
const port = Number(process.env.API_PORT || 3001);
const connections = new Map<string, { config: DatabaseConfig; createdAt: number }>();
app.use(cors({ origin: process.env.WEB_ORIGIN || "http://localhost:3000" }));
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_request, response) => response.json({ ok: true, service: "datapilot-api" }));
app.post("/api/connections", async (request, response) => {
  try {
    const config = validateConfig(request.body);
    const details = await testDatabase(config);
    const connectionId = randomUUID();
    connections.set(connectionId, { config, createdAt: Date.now() });
    response.json({ ok: true, connectionId, name: config.name, engine: config.engine, host: config.host, port: config.port, sshEnabled: !!config.ssh?.enabled, ...details });
  } catch (error) { response.status(400).json({ ok: false, error: errorMessage(error) }); }
});
app.post("/api/connections/:id/test", async (request, response) => {
  try { response.json({ ok: true, ...(await testDatabase(getConnection(request.params.id))) }); }
  catch (error) { response.status(400).json({ ok: false, error: errorMessage(error) }); }
});
app.delete("/api/connections/:id", (request, response) => { connections.delete(request.params.id); response.status(204).end(); });
app.get("/api/database/schema", async (request, response) => {
  try { const tables = await getSchema(getConnection(String(request.query.connectionId || ""))); response.json({ tables }); }
  catch (error) { response.status(400).json({ error: errorMessage(error) }); }
});
app.post("/api/database/query", async (request, response) => {
  try { response.json(await executeReadOnly(getConnection(String(request.body?.connectionId || "")), String(request.body?.sql || ""))); }
  catch (error) { response.status(400).json({ error: errorMessage(error) }); }
});
app.post("/api/query", async (request, response) => {
  const started = Date.now();
  try {
    const question = String(request.body?.question || "").trim().slice(0, 500);
    if (!question) return response.status(400).json({ error: "请输入问题" });
    const config = getConnection(String(request.body?.connectionId || ""));
    const schema = await getSchema(config);
    if (!schema.length) return response.status(400).json({ error: "当前数据库没有可查询的业务表" });
    const generated = await generateSql(question, schema);
    const result = await executeReadOnly(config, generated.sql);
    const summary = await summarizeResult(question, result.sql, result.rows);
    return response.json({ question, summary, sql: result.sql, columns: result.columns, rows: result.rows, chart: buildChart(result.rows), executionMs: Date.now() - started, rowCount: result.rowCount });
  } catch (error) { return response.status(400).json({ error: errorMessage(error) }); }
});

app.listen(port, "127.0.0.1", () => console.log(`DataPilot API: http://localhost:${port}`));

function getConnection(id: string) {
  const item = connections.get(id);
  if (!item) throw new Error("连接会话不存在，请重新连接数据源");
  return item.config;
}
function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "未知错误";
  if (/access denied/i.test(message)) return "数据库用户名或密码错误";
  if (/private key|Cannot parse/i.test(message)) return "SSH 私钥无效或需要正确的私钥口令";
  if (/ECONNREFUSED|Timed out|timeout|ENOTFOUND/i.test(message)) return "无法连接数据库或 SSH 服务器，请检查地址、端口和网络";
  return message.slice(0, 300);
}
function buildChart(rows: Record<string, unknown>[]) {
  if (rows.length < 2 || rows.length > 20) return undefined;
  const keys = Object.keys(rows[0] || {}); const labelKey = keys.find((key) => typeof rows[0][key] === "string"); const valueKey = keys.find((key) => typeof rows[0][key] === "number");
  if (!labelKey || !valueKey) return undefined;
  return rows.map((row) => ({ label: String(row[labelKey]).slice(0, 12), value: Number(row[valueKey]) })).filter((item) => Number.isFinite(item.value));
}
