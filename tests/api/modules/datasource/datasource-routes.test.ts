import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { PermissionService, ResourcePermissionStore } from "../../../../server/modules/auth/index.js";
import { createDatasourceAccess, installDatasourceRoutes, MappingRegistryStore, MappingReviewService, type StoredConnection } from "../../../../server/modules/datasource/index.js";
import type { RequestContext } from "../../../../server/shared/types/context.js";

test("extracted datasource API preserves tenant isolation, public fields and error responses", async () => {
  const directory = mkdtempSync(join(tmpdir(), "datapilot-datasource-api-"));
  const permissions = new PermissionService();
  const resourcePermissions = new ResourcePermissionStore(":memory:");
  const mappingRegistry = new MappingRegistryStore(join(directory, "mapping.json"));
  const context: RequestContext = { tenantId: "tenant-a", accountSetId: "book-a", userId: "owner", role: "tenant_owner", sessionId: "session" };
  const connection: StoredConnection = { tenantId: context.tenantId, accountSetId: context.accountSetId, ownerId: context.userId, permission: "private", createdAt: 123,
    config: { name: "private", engine: "mysql", host: "127.0.0.1", port: 3306, database: "fixture", user: "fixture", password: "secret" }, details: { version: "8", tables: 2 } };
  const connections = new Map([["owned", connection], ["other-tenant", { ...connection, tenantId: "tenant-b" }]]);
  const app = express(); app.use(express.json());
  installDatasourceRoutes(app, { connections, permissions, resourcePermissions, mappingRegistry, mappingReview: new MappingReviewService(mappingRegistry, permissions), identity: () => context,
    tools: { async call() { throw new Error("Unexpected external tool call"); } } });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${base}/api/connections`); assert.equal(response.status, 200);
    const { items } = await response.json(); assert.equal(items.length, 1); assert.equal(items[0].connectionId, "owned");
    assert.equal("password" in items[0], false); assert.equal("user" in items[0], false);
    const denied = await fetch(`${base}/api/connections/other-tenant/permissions`);
    assert.equal(denied.status, 403); assert.deepEqual(await denied.json(), { error: "数据源不存在或无权访问" });
    const missing = await fetch(`${base}/api/database/schema?connectionId=missing`);
    assert.equal(missing.status, 400); assert.deepEqual(await missing.json(), { error: "数据源不存在或无权访问" });
    const invalid = await fetch(`${base}/api/connections`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ engine: "unsupported" }) });
    assert.equal(invalid.status, 400); assert.equal((await invalid.json()).ok, false);
    const access = createDatasourceAccess(connections, resourcePermissions);
    assert.equal(access.getConnectionItem("owned", context), connection);
    assert.throws(() => access.getConnectionItem("owned", { ...context, accountSetId: "other" }));
  } finally {
    server.close(); await once(server, "close");
    rmSync(directory, { recursive: true, force: true });
  }
});
