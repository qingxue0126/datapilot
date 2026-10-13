import sqlParser from "node-sql-parser";
import type { JoinPathDefinition, SchemaSearchResult, SemanticEntityMapping } from "./types.js";

const parser = new sqlParser.Parser();

export function assertSqlUsesValidatedJoinPaths(sql: string, schema: SchemaSearchResult) {
  const ast = parser.astify(sql, { database: "MySQL" }) as unknown;
  for (const statement of Array.isArray(ast) ? ast : [ast]) validateSelect(statement as SqlNode, schema);
  return sql;
}

type SqlNode = {
  type?: string;
  from?: FromItem[];
  with?: { stmt?: { ast?: SqlNode } }[];
};
type FromItem = { table?: string; as?: string; join?: string; on?: Expression; expr?: { ast?: SqlNode } };
type Expression = { type?: string; operator?: string; left?: Expression; right?: Expression; table?: string; column?: string };

function validateSelect(node: SqlNode | undefined, schema: SchemaSearchResult) {
  if (!node || typeof node !== "object") return;
  for (const item of node.with || []) validateSelect(item.stmt?.ast, schema);
  const from = node.from || [];
  const aliases = new Map<string, string>();
  for (let index = 0; index < from.length; index += 1) {
    const item = from[index];
    if (item.expr?.ast) validateSelect(item.expr.ast, schema);
    if (!item.table) {
      if (item.join) throw new Error("Schema 映射不足：子查询之间的 JOIN 尚未纳入 Join Path Registry");
      continue;
    }
    const rightAlias = normalize(item.as || item.table);
    if (index === 0) { aliases.set(rightAlias, item.table); continue; }
    if (!item.join || !item.on) throw new Error("Schema 映射不足：多表查询不允许没有 Join Path 的笛卡尔关联");
    const equalities = equalityPairs(item.on);
    const possibleLeftAliases = new Set(equalities.flatMap((pair) => [pair.left.table, pair.right.table]).filter((alias) => alias && alias !== rightAlias));
    const rightTable = item.table;
    const matched = [...possibleLeftAliases].some((leftAlias) => {
      const leftTable = aliases.get(leftAlias);
      return Boolean(leftTable && schema.joinPaths.some((path) => path.validated && pathMatches(path, leftTable, rightTable, leftAlias, rightAlias, equalities, schema.semanticSchema, item.join!)));
    });
    if (!matched) throw new Error(`Schema 映射不足：表 ${[...possibleLeftAliases].map((alias) => aliases.get(alias) || alias).join("/")} 与 ${rightTable} 之间没有被 SQL 正确使用的已验证 Join Path`);
    aliases.set(rightAlias, rightTable);
  }
}

function pathMatches(path: JoinPathDefinition, leftTable: string, rightTable: string, leftAlias: string, rightAlias: string, equalities: Equality[], mappings: SemanticEntityMapping[], sqlJoin: string) {
  const direct = same(path.leftTable, leftTable) && same(path.rightTable, rightTable);
  const reverse = same(path.leftTable, rightTable) && same(path.rightTable, leftTable);
  if (!direct && !reverse) return false;
  if (path.joinType === "left" && !/left/i.test(sqlJoin)) return false;
  if (path.joinType === "inner" && /left|right|full/i.test(sqlJoin)) return false;
  const leftMapping = mappings.find((item) => item.entity === path.leftEntity);
  const rightMapping = mappings.find((item) => item.entity === path.rightEntity);
  if (!leftMapping || !rightMapping) return false;
  return path.fields.every((field) => {
    const pathLeftColumn = leftMapping.fields[field.leftField]; const pathRightColumn = rightMapping.fields[field.rightField];
    if (!pathLeftColumn || !pathRightColumn) return false;
    const expectedLeftAlias = direct ? leftAlias : rightAlias; const expectedRightAlias = direct ? rightAlias : leftAlias;
    const expectedLeftColumn = direct ? pathLeftColumn : pathRightColumn; const expectedRightColumn = direct ? pathRightColumn : pathLeftColumn;
    return equalities.some((pair) => columnPairMatches(pair, expectedLeftAlias, expectedLeftColumn, expectedRightAlias, expectedRightColumn));
  });
}

type Column = { table: string; column: string };
type Equality = { left: Column; right: Column };
function equalityPairs(expression: Expression): Equality[] {
  if (expression.type === "binary_expr" && String(expression.operator).toUpperCase() === "AND") return [...equalityPairs(expression.left!), ...equalityPairs(expression.right!)];
  if (expression.type !== "binary_expr" || expression.operator !== "=") return [];
  const left = column(expression.left); const right = column(expression.right);
  return left && right ? [{ left, right }] : [];
}
function column(expression?: Expression): Column | undefined {
  if (expression?.type !== "column_ref" || !expression.table || !expression.column) return undefined;
  return { table: normalize(expression.table), column: normalize(expression.column) };
}
function columnPairMatches(pair: Equality, leftAlias: string, leftColumn: string, rightAlias: string, rightColumn: string) {
  const direct = pair.left.table === normalize(leftAlias) && pair.left.column === normalize(leftColumn) && pair.right.table === normalize(rightAlias) && pair.right.column === normalize(rightColumn);
  const reverse = pair.right.table === normalize(leftAlias) && pair.right.column === normalize(leftColumn) && pair.left.table === normalize(rightAlias) && pair.left.column === normalize(rightColumn);
  return direct || reverse;
}
function normalize(value: string) { return String(value || "").replaceAll("`", "").toLowerCase(); }
function same(left: string, right: string) { return normalize(left) === normalize(right); }
