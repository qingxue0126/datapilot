import { errorMessage } from "../../shared/errors/error-message.js";
import { type Request } from "express";
import { randomUUID } from "node:crypto";
import { executeSql, getSchema, prepareSql, testDatabase, validateConfig } from "../../infrastructure/database/mysql.js";
import { assertAgentSql } from "../../infrastructure/security/sql-policy.js";
import type { RequestContext } from "../../shared/types/context.js";
import { PermissionService, ResourcePermissionStore } from "../auth/index.js";
import { saveConnections, type StoredConnection } from "./connection-store.js";
import { MappingRegistryStore } from "./schema-mapping/mapping-registry.js";
import { MappingReviewService, type MappingDraftInput } from "./schema-mapping/mapping-review-service.js";
import type { SchemaSearchResult } from "./schema-mapping/types.js";


export type DatasourceRouteDependencies = {
  connections: Map<string, StoredConnection>;
  permissions: PermissionService;
  resourcePermissions: ResourcePermissionStore;
  mappingRegistry: MappingRegistryStore;
  mappingReview: MappingReviewService;
  tools: { call<I, O>(name: string, input: I, context: { request: RequestContext; datasourceId: string; connection: import("../../shared/types/database.js").DatabaseConfig }): Promise<O> };
  identity: (request: Request) => RequestContext;
};

export function createDatasourceAccess(connections: Map<string, StoredConnection>, resourcePermissions: ResourcePermissionStore) {
  return { getConnectionItem, belongsTo };
  function belongsTo(connectionId: string, item: StoredConnection, context: RequestContext) {
    return item.tenantId === context.tenantId && item.accountSetId === context.accountSetId && (!item.ownerId || item.ownerId === context.userId || item.permission === "tenant" || Boolean(resourcePermissions.access(context, "datasource", connectionId, item.ownerId, "private")));
  }
  function getConnectionItem(id: string, context: RequestContext) {
    const item = connections.get(id);
    if (!item || !belongsTo(id, item, context)) throw new Error("数据源不存在或无权访问");
    return item;
  }

}

export function installDatasourceRoutes(app: import("express").Express, dependencies: DatasourceRouteDependencies) {
  const { connections, permissions, resourcePermissions, mappingRegistry, mappingReview, tools, identity } = dependencies;
  const { getConnectionItem, belongsTo } = createDatasourceAccess(connections, resourcePermissions);
  app.get("/api/connections", (request, response) => {
    try {
      const context = identity(request);
      permissions.require(context, "database:read");
      const items = [...connections.entries()]
        .filter(([connectionId, item]) => belongsTo(connectionId, item, context))
        .map(([connectionId, item]) => publicConnection(connectionId, item));
      response.json({ items });
    } catch (error) { response.status(403).json({ error: errorMessage(error) }); }
  });

  app.post("/api/connections", async (request, response) => {
    try {
      const context = identity(request);
      permissions.require(context, "connection:manage");
      const config = validateConfig(request.body);
      const details = await testDatabase(config);
      const connectionId = randomUUID();
      connections.set(connectionId, {
        tenantId: context.tenantId,
        accountSetId: context.accountSetId,
        ownerId: context.userId,
        permission: request.body?.permission === "tenant" ? "tenant" : "private",
        config,
        createdAt: Date.now(),
        details: { version: details.version, tables: details.tables, latencyMs: details.latencyMs },
      });
      saveConnections(connections);
      response.json({ ok: true, connectionId, name: config.name, engine: config.engine, host: config.host, port: config.port, sshEnabled: !!config.ssh?.enabled, ...details });
    } catch (error) { response.status(400).json({ ok: false, error: errorMessage(error) }); }
  });

  app.post("/api/connections/:id/test", async (request, response) => {
    try {
      const context = identity(request);
      permissions.require(context, "connection:manage");
      const item = getConnectionItem(request.params.id, context);
      const details = await testDatabase(item.config);
      item.details = { version: details.version, tables: details.tables, latencyMs: details.latencyMs };
      saveConnections(connections);
      response.json({ ok: true, ...details });
    } catch (error) { response.status(400).json({ ok: false, error: errorMessage(error) }); }
  });

  app.delete("/api/connections/:id", (request, response) => {
    try {
      const context = identity(request);
      permissions.require(context, "connection:manage");
      getConnectionItem(request.params.id, context);
      connections.delete(request.params.id);
      saveConnections(connections);
      response.status(204).end();
    } catch (error) { response.status(403).json({ error: errorMessage(error) }); }
  });

  app.get("/api/connections/:id/permissions", (request, response) => {
    try {
      const context = identity(request); const item = getConnectionItem(request.params.id, context);
      response.json({ items: resourcePermissions.list(context, "datasource", request.params.id, item.ownerId || context.userId) });
    } catch (error) { response.status(403).json({ error: errorMessage(error) }); }
  });

  app.put("/api/connections/:id/permissions/:userId", (request, response) => {
    try {
      const context = identity(request); const item = getConnectionItem(request.params.id, context);
      response.json({ items: resourcePermissions.set(context, "datasource", request.params.id, item.ownerId || context.userId, request.params.userId, request.body?.access === null ? null : request.body?.access) });
    } catch (error) { response.status(403).json({ error: errorMessage(error) }); }
  });

  app.get("/api/database/schema", async (request, response) => {
    try {
      const context = identity(request);
      permissions.require(context, "database:read");
      const schema = await getSchema(getConnectionItem(String(request.query.connectionId || ""), context).config);
      response.json({ tables: permissions.filterSchema(context, schema) });
    } catch (error) { response.status(400).json({ error: errorMessage(error) }); }
  });

  /** Read-only ERP semantic mapping snapshot for the datasource detail UI. */
  app.get("/api/datasources/:id/schema-mapping", async (request, response) => {
    try {
      const context = identity(request);
      permissions.require(context, "database:read");
      const item = getConnectionItem(request.params.id, context);
      const mapping = await tools.call<{ question: string; includeSamples: boolean }, SchemaSearchResult>("schema.search", {
        question: "",
        includeSamples: request.query.samples === "1",
      }, { request: context, datasourceId: request.params.id, connection: item.config });
      const key = mappingReview.key(context, request.params.id, item.config.database, mapping.erpType);
      response.json({
        datasource: publicConnection(request.params.id, item), ...mapping,
        review: {
          publishedVersion: mappingRegistry.getPublished(key),
          draftVersion: mappingRegistry.getDraft(key),
          capabilities: permissions.policy(context).capabilities.filter((item) => item.startsWith("schema_mapping:")),
        },
      });
    } catch (error) { response.status(400).json({ error: errorMessage(error) }); }
  });

  app.get("/api/datasources/:id/schema-mapping/versions", async (request, response) => {
    try {
      const context = identity(request); permissions.require(context, "schema_mapping:read");
      const item = getConnectionItem(request.params.id, context); const erpType = String(request.query.erpType || "generic");
      const key = mappingReview.key(context, request.params.id, item.config.database, erpType);
      response.json({ items: mappingRegistry.listVersions(key), audits: mappingRegistry.listAudits(key) });
    } catch (error) { response.status(400).json({ error: errorMessage(error) }); }
  });

  app.get("/api/datasources/:id/schema-mapping/versions/:version", async (request, response) => {
    try {
      const context = identity(request); permissions.require(context, "schema_mapping:read");
      const item = getConnectionItem(request.params.id, context); const erpType = String(request.query.erpType || "generic");
      const key = mappingReview.key(context, request.params.id, item.config.database, erpType); const version = Number(request.params.version);
      const record = mappingRegistry.getVersion(key, version); if (!record) throw new Error(`Mapping 版本 v${version} 不存在`);
      response.json({ version: record, diff: mappingRegistry.diff(key, version) });
    } catch (error) { response.status(400).json({ error: errorMessage(error) }); }
  });

  app.post("/api/datasources/:id/schema-mapping/draft", async (request, response) => {
    try {
      const context = identity(request); const item = getConnectionItem(request.params.id, context);
      const draft = request.body as MappingDraftInput;
      response.json(await mappingReview.saveDraft({ context, datasourceId: request.params.id, connection: item.config, draft }));
    } catch (error) { response.status(400).json({ error: errorMessage(error) }); }
  });

  app.post("/api/datasources/:id/schema-mapping/validate", async (request, response) => {
    try {
      const context = identity(request); const item = getConnectionItem(request.params.id, context); const erpType = String(request.body?.erpType || "generic");
      response.json(await mappingReview.validateDraft({ context, datasourceId: request.params.id, connection: item.config, erpType, draft: request.body?.entities ? request.body as MappingDraftInput : undefined }));
    } catch (error) { response.status(400).json({ error: errorMessage(error) }); }
  });

  app.post("/api/datasources/:id/schema-mapping/publish", async (request, response) => {
    try {
      const context = identity(request); const item = getConnectionItem(request.params.id, context); const erpType = String(request.body?.erpType || "generic");
      response.json(await mappingReview.publish({ context, datasourceId: request.params.id, connection: item.config, erpType }));
    } catch (error) { response.status(400).json({ error: errorMessage(error) }); }
  });

  app.post("/api/datasources/:id/schema-mapping/rollback/:version", async (request, response) => {
    try {
      const context = identity(request); const item = getConnectionItem(request.params.id, context); const erpType = String(request.body?.erpType || "generic");
      response.json(await mappingReview.rollback({ context, datasourceId: request.params.id, connection: item.config, erpType, version: Number(request.params.version), changeSummary: request.body?.changeSummary }));
    } catch (error) { response.status(400).json({ error: errorMessage(error) }); }
  });

  /** Database workbench: writes require database:write and still use the existing confirmation gate. */
  app.post("/api/database/query", async (request, response) => {
    try {
      const context = identity(request);
      const requestedSql = String(request.body?.sql || "");
      const operation = prepareSql(requestedSql);
      permissions.require(context, operation.isWrite ? "database:write" : "database:read");
      const item = getConnectionItem(String(request.body?.connectionId || ""), context);
      const sql = !operation.isWrite && context.role !== "tenant_admin" && context.role !== "tenant_owner"
        ? assertAgentSql(requestedSql, permissions.policy(context))
        : requestedSql;
      response.json(await executeSql(item.config, sql, request.body?.confirm === true));
    } catch (error) { response.status(400).json({ error: errorMessage(error) }); }
  });

}

function publicConnection(connectionId: string, item: StoredConnection) {
  return { connectionId, name: item.config.name, engine: item.config.engine, host: item.config.host, port: item.config.port, database: item.config.database, sshEnabled: !!item.config.ssh?.enabled, version: item.details.version, tables: item.details.tables, permission: item.permission || "tenant", createdAt: item.createdAt };
}
