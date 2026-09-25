export type Role = "tenant_admin" | "finance_analyst" | "finance_viewer";

export type RequestContext = {
  tenantId: string;
  accountSetId: string;
  userId: string;
  role: Role;
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
