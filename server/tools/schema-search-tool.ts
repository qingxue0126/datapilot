import { getSchema, type SchemaTable } from "../database.js";
import { PermissionService } from "../auth/permission-service.js";
import type { AgentTool, ToolContext } from "./tool-registry.js";

export class SchemaSearchTool implements AgentTool<{ question: string }, SchemaTable[]> {
  name = "schema.search";
  description = "检索当前租户账套中与问题相关且有权限访问的表和字段";
  constructor(private readonly permissions: PermissionService) {}
  async execute(input: { question: string }, context: ToolContext) {
    this.permissions.require(context.request, "database:read");
    const schema = this.permissions.filterSchema(context.request, await getSchema(context.connection));
    const tokens = input.question.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
    return schema.map((table) => ({ table, score: score(table, tokens) })).sort((a, b) => b.score - a.score).slice(0, 30).map((item) => item.table);
  }
}

function score(table: SchemaTable, tokens: string[]) {
  const text = `${table.name} ${table.columns.map((column) => `${column.name} ${column.comment}`).join(" ")}`.toLowerCase();
  return tokens.reduce((total, token) => total + (text.includes(token) ? 1 : 0), 0);
}
