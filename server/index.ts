import "dotenv/config";
import cors from "cors";
import express from "express";
import { executeReadOnly, getSchema, testDatabase } from "./database.js";
import { generateSql, summarizeResult } from "./text2sql.js";

const app = express();
const port = Number(process.env.API_PORT || 3001);
app.use(cors({ origin: process.env.WEB_ORIGIN || "http://localhost:3000" }));
app.use(express.json({ limit: "512kb" }));

app.get("/api/health", (_request, response) => response.json({ ok: true, service: "datapilot-api" }));
app.post("/api/database/test", async (_request, response) => {
  try { response.json({ ok: true, ...(await testDatabase()) }); }
  catch (error) { response.status(400).json({ ok: false, error: errorMessage(error) }); }
});
app.get("/api/database/schema", async (_request, response) => {
  try { const tables = await getSchema(); response.json({ database: process.env.MYSQL_DATABASE, tables }); }
  catch (error) { response.status(400).json({ error: errorMessage(error) }); }
});
app.post("/api/database/query", async (request, response) => {
  try { response.json(await executeReadOnly(String(request.body?.sql || ""))); }
  catch (error) { response.status(400).json({ error: errorMessage(error) }); }
});
app.post("/api/query", async (request, response) => {
  const started = Date.now();
  try {
    const question = String(request.body?.question || "").trim().slice(0, 500);
    if (!question) return response.status(400).json({ error: "请输入问题" });
    const schema = await getSchema();
    if (!schema.length) return response.status(400).json({ error: "当前数据库没有可查询的业务表" });
    const generated = await generateSql(question, schema);
    const result = await executeReadOnly(generated.sql);
    const summary = await summarizeResult(question, result.sql, result.rows);
    const chart = buildChart(result.rows);
    return response.json({ question, summary, sql: result.sql, columns: result.columns, rows: result.rows, chart, executionMs: Date.now() - started, rowCount: result.rowCount });
  } catch (error) { return response.status(400).json({ error: errorMessage(error) }); }
});

app.listen(port, "127.0.0.1", () => console.log(`DataPilot API: http://localhost:${port}`));

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "未知错误";
  if (/access denied/i.test(message)) return "MySQL 用户名或密码错误";
  if (/private key|ENOENT/i.test(message)) return "SSH 私钥文件不存在或无法读取";
  if (/ECONNREFUSED|Timed out|timeout/i.test(message)) return "无法连接数据库或 SSH 服务器，请检查地址、端口和网络";
  return message.slice(0, 300);
}

function buildChart(rows: Record<string, unknown>[]) {
  if (rows.length < 2 || rows.length > 20) return undefined;
  const keys = Object.keys(rows[0] || {});
  const labelKey = keys.find((key) => typeof rows[0][key] === "string");
  const valueKey = keys.find((key) => typeof rows[0][key] === "number");
  if (!labelKey || !valueKey) return undefined;
  return rows.map((row) => ({ label: String(row[labelKey]).slice(0, 12), value: Number(row[valueKey]) })).filter((item) => Number.isFinite(item.value));
}
