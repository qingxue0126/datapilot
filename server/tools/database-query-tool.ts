import { executeSql } from "../database.js";
import { PermissionService } from "../auth/permission-service.js";
import { assertAgentSql } from "../security/sql-policy.js";
import type { AgentTool, ToolContext } from "./tool-registry.js";

export class DatabaseQueryTool implements AgentTool<{ sql: string }, Awaited<ReturnType<typeof executeSql>>> {
  name = "database.query";
  description = "在权限与 SQL 安全策略校验后，对当前租户账套执行只读 SQL";
  constructor(private readonly permissions: PermissionService) {}
  async execute(input: { sql: string }, context: ToolContext) {
    this.permissions.require(context.request, "database:read");
    const sql = assertAgentSql(input.sql, this.permissions.policy(context.request));
    return executeSql(context.connection, sql, false);
  }
}
