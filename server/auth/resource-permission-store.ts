import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RequestContext } from "../core/types.js";

export type ResourceKind = "model" | "knowledge_base" | "datasource";
export type ResourceAccess = "owner" | "edit" | "use";

/** Small shared ACL store. Resource stores remain the source of truth for ownership and visibility. */
export class ResourcePermissionStore {
  private readonly database: DatabaseSync;

  constructor(path = process.env.RESOURCE_PERMISSION_DB_PATH || resolve(".data", "resource-permissions.sqlite")) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    if (path !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec(`CREATE TABLE IF NOT EXISTS resource_permissions (
      kind TEXT NOT NULL, resource_id TEXT NOT NULL, tenant_id TEXT NOT NULL, account_set_id TEXT NOT NULL,
      user_id TEXT NOT NULL, access_level TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(kind, resource_id, user_id)
    ); CREATE INDEX IF NOT EXISTS resource_permissions_lookup ON resource_permissions(kind, resource_id, tenant_id, account_set_id);`);
  }

  access(context: RequestContext, kind: ResourceKind, resourceId: string, ownerId: string, visibility: "private" | "tenant" | "team" = "private"): ResourceAccess | null {
    if (context.userId === ownerId) return "owner";
    if (visibility === "tenant" || visibility === "team") return "use";
    const row = this.database.prepare("SELECT access_level FROM resource_permissions WHERE kind=? AND resource_id=? AND tenant_id=? AND account_set_id=? AND user_id=?")
      .get(kind, resourceId, context.tenantId, context.accountSetId, context.userId) as { access_level?: string } | undefined;
    return row?.access_level === "edit" || row?.access_level === "use" ? row.access_level : null;
  }

  list(context: RequestContext, kind: ResourceKind, resourceId: string, ownerId: string) {
    return (this.database.prepare("SELECT user_id,access_level,created_at,updated_at FROM resource_permissions WHERE kind=? AND resource_id=? AND tenant_id=? AND account_set_id=? ORDER BY updated_at DESC")
      .all(kind, resourceId, context.tenantId, context.accountSetId) as { user_id: string; access_level: ResourceAccess; created_at: string; updated_at: string }[])
      .map((row) => ({ userId: row.user_id, access: row.access_level, ownerId, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  set(context: RequestContext, kind: ResourceKind, resourceId: string, ownerId: string, userId: string, access: ResourceAccess | null) {
    if (context.userId !== ownerId && context.role !== "tenant_owner" && context.role !== "tenant_admin" && context.platformAdmin !== true) throw new Error("仅资源所有者或组织管理员可以管理成员权限");
    if (!userId || userId === ownerId) throw new Error("不能修改资源所有者权限");
    if (access !== null && access !== "edit" && access !== "use") throw new Error("资源权限仅支持 edit 或 use");
    if (!access) this.database.prepare("DELETE FROM resource_permissions WHERE kind=? AND resource_id=? AND tenant_id=? AND account_set_id=? AND user_id=?").run(kind, resourceId, context.tenantId, context.accountSetId, userId);
    else {
      const now = new Date().toISOString();
      this.database.prepare(`INSERT INTO resource_permissions (kind,resource_id,tenant_id,account_set_id,user_id,access_level,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(kind,resource_id,user_id) DO UPDATE SET access_level=excluded.access_level,updated_at=excluded.updated_at`)
        .run(kind, resourceId, context.tenantId, context.accountSetId, userId, access, now, now);
    }
    return this.list(context, kind, resourceId, ownerId);
  }
}
