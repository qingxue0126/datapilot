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

