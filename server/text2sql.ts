import type { SchemaTable } from "./database.js";

type LlmResponse = { choices?: { message?: { content?: string } }[] };

async function callDeepSeek(messages: { role: "system" | "user"; content: string }[]) {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error("缺少环境变量 DEEPSEEK_API_KEY");
  const baseUrl = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: process.env.DEEPSEEK_MODEL || "deepseek-chat", temperature: 0, max_tokens: 1200, response_format: { type: "json_object" }, messages }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`LLM 请求失败（${response.status}）：${safeMessage(body)}`);
  const parsed = JSON.parse(body) as LlmResponse;
  const content = parsed.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM 未返回有效内容");
  return JSON.parse(content) as Record<string, unknown>;
}

export async function generateSql(question: string, schema: SchemaTable[]) {
  const schemaText = schema.slice(0, 80).map((table) => `${table.name}(${table.columns.map((column) => `${column.name} ${column.type}${column.comment ? ` /*${column.comment}*/` : ""}`).join(", ")})`).join("\n");
  const result = await callDeepSeek([
    { role: "system", content: "你是资深 MySQL 8 数据库助手。只根据给定 schema 和用户意图生成一条 SQL。查询使用 SELECT；新增、修改、删除分别使用 INSERT、UPDATE、DELETE。禁止编造表或字段，禁止 DDL、存储过程、文件函数和延时函数；UPDATE 和 DELETE 必须包含明确的 WHERE 条件。适当使用中文别名。输出严格 JSON：{\"sql\":\"...\",\"title\":\"简短标题\"}。" },
    { role: "user", content: `数据库结构：\n${schemaText}\n\n用户问题：${question}` },
  ]);
  if (typeof result.sql !== "string") throw new Error("LLM 没有生成 SQL");
  return { sql: result.sql, title: typeof result.title === "string" ? result.title : "查询结果" };
}

export async function summarizeResult(question: string, sql: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return "查询已完成，但没有找到符合条件的数据。";
  const sample = JSON.stringify(rows.slice(0, 30));
  const result = await callDeepSeek([
    { role: "system", content: "你是严谨的中文数据分析师。根据查询结果写一句不超过80字的结论，只陈述数据支持的事实。输出严格 JSON：{\"summary\":\"...\"}。" },
    { role: "user", content: `问题：${question}\nSQL：${sql}\n结果样本：${sample}` },
  ]);
  return typeof result.summary === "string" ? result.summary : `查询返回 ${rows.length} 行数据。`;
}

function safeMessage(body: string) {
  try { const parsed = JSON.parse(body); return String(parsed.error?.message || parsed.message || "未知错误").slice(0, 240); }
  catch { return "未知错误"; }
}
