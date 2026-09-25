import sqlParser from "node-sql-parser";
import type { PermissionPolicy } from "../core/types.js";

const parser = new sqlParser.Parser();
const forbiddenFunctions = /\b(sleep|benchmark|load_file|into\s+outfile|into\s+dumpfile)\b/i;

export function assertAgentSql(sql: string, policy: PermissionPolicy) {
  const normalized = sql.trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(normalized)) throw new Error("智能问数仅允许 SELECT 查询");
  if (normalized.includes(";") || /--|#|\/\*/.test(normalized)) throw new Error("SQL 不允许多语句或注释");
  if (forbiddenFunctions.test(normalized)) throw new Error("SQL 包含不允许的函数");
  if (policy.deniedColumns.length && /\bselect\s+(?:distinct\s+)?(?:[a-zA-Z0-9_$]+\s*\.\s*)?\*/i.test(normalized)) {
    throw new Error("存在字段权限限制时不允许 SELECT *，请明确列出字段");
  }
  parser.astify(normalized, { database: "MySQL" });

  const tableEntries = parser.tableList(normalized, { database: "MySQL" });
  for (const entry of tableEntries) {
    const [, database] = entry.split("::");
    if (database && database !== "null") throw new Error(`智能问数不允许跨数据库访问：${database}`);
  }
  const tables = tableEntries.map((entry) => entry.split("::").at(-1) || "");
  if (policy.allowedTables !== "*") {
    for (const table of tables) if (!policy.allowedTables.includes(table)) throw new Error(`无权访问表 ${table}`);
  }

  const columns = parser.columnList(normalized, { database: "MySQL" }).map((entry) => entry.split("::").at(-1)?.toLowerCase() || "");
  for (const column of columns) if (policy.deniedColumns.includes(column)) throw new Error(`无权访问字段 ${column}`);

  for (const scope of policy.rowScopes.filter((item) => tables.includes(item.table))) {
    if (/\(\s*select\b/i.test(normalized)) throw new Error("启用数据范围权限时不允许子查询");
    if (/\bor\b/i.test(normalized)) throw new Error("启用数据范围权限时不允许 OR 条件，请拆分查询");
    const column = `(?:\\b${escapeRegExp(scope.table)}\\b\\s*\\.\\s*)?\\b${escapeRegExp(scope.column)}\\b`;
    const values = scope.allowedValues.map((value) => `'${escapeRegExp(value.replaceAll("'", "''"))}'`).join("|");
    const equality = new RegExp(`${column}\\s*=\\s*(?:${values})`, "i");
    const inList = new RegExp(`${column}\\s+in\\s*\\((?:\\s*(?:${values})\\s*,?)+\\)`, "i");
    if (!values || (!equality.test(normalized) && !inList.test(normalized))) {
      throw new Error(`查询缺少 ${scope.table}.${scope.column} 数据范围约束`);
    }
  }
  return normalized;
}

function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
