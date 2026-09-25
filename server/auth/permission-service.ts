import type { PermissionPolicy, RequestContext, Role } from "../core/types.js";
import type { SchemaTable } from "../database.js";

const policies: Record<Role, PermissionPolicy> = {
  tenant_admin: { capabilities: ["database:read", "database:write", "connection:manage", "agent:query", "schema_mapping:read", "schema_mapping:write", "schema_mapping:publish"], allowedTables: "*", deniedColumns: ["password", "passwd", "secret", "token", "private_key"], rowScopes: [] },
  finance_analyst: { capabilities: ["database:read", "agent:query", "schema_mapping:read", "schema_mapping:write"], allowedTables: "*", deniedColumns: ["password", "passwd", "secret", "token", "private_key", "id_card", "bank_account"], rowScopes: [] },
  finance_viewer: { capabilities: ["database:read", "agent:query", "schema_mapping:read"], allowedTables: "*", deniedColumns: ["password", "passwd", "secret", "token", "private_key", "id_card", "bank_account"], rowScopes: [] },
};

type PolicyRule = { tenantId: string; accountSetId: string; role: Role; policy: Partial<PermissionPolicy> };

export class PermissionService {
  private readonly rules = loadRules();
  policy(context: RequestContext) {
    const base = policies[context.role];
    const override = this.rules.find((rule) => rule.tenantId === context.tenantId && rule.accountSetId === context.accountSetId && rule.role === context.role)?.policy;
    return override ? { ...base, ...override } : base;
  }
  require(context: RequestContext, capability: string) {
    if (!this.policy(context).capabilities.includes(capability)) throw new Error(`角色 ${context.role} 无权执行 ${capability}`);
  }
  filterSchema(context: RequestContext, schema: SchemaTable[]) {
    const policy = this.policy(context);
    const allowed = policy.allowedTables === "*" ? schema : schema.filter((table) => policy.allowedTables.includes(table.name));
    return allowed.map((table) => ({ ...table, columns: table.columns.filter((column) => !policy.deniedColumns.includes(column.name.toLowerCase())) }));
  }
}

function loadRules(): PolicyRule[] {
  const raw = process.env.DATAPILOT_PERMISSION_RULES_JSON?.trim();
  if (!raw) return [];
  try {
    const rules = JSON.parse(raw) as PolicyRule[];
    if (!Array.isArray(rules)) throw new Error("必须是数组");
    return rules;
  } catch (error) {
    throw new Error(`DATAPILOT_PERMISSION_RULES_JSON 无效：${error instanceof Error ? error.message : "未知错误"}`);
  }
}
