/** finance_analyst is retained only so old serialized data and API clients can be read during migration. */
export type Role = "tenant_owner" | "tenant_admin" | "finance_viewer" | "finance_analyst";
export type PlatformRole = "platform_admin";

export type RequestContext = {
  tenantId: string;
  accountSetId: string;
  userId: string;
  role: Role;
  platformAdmin?: boolean;
  sessionId: string;
};

export type AgentTraceEvent = {
  step: string;
  status: "started" | "succeeded" | "failed";
  detail?: string;
  durationMs?: number;
};

export type ChatTurn = {
  question: string;
  answer: string;
  sql?: string;
  createdAt: number;
};

export type RowScope = {
  table: string;
  column: string;
  allowedValues: string[];
};

export type PermissionPolicy = {
  capabilities: string[];
  allowedTables: "*" | string[];
  deniedColumns: string[];
  rowScopes: RowScope[];
};
