import "dotenv/config";
import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type Request } from "express";
import { DataAgent } from "./agent/data-agent.js";
import { installQueryRoutes } from "./agent/query-routes.js";
import { AccountStore } from "./auth/account-store.js";
import { createApiKeyGuard } from "./auth/api-key-guard.js";
import { installAuthRoutes } from "./auth/auth-routes.js";
import { EnvironmentIdentityProvider } from "./auth/identity-provider.js";
import { PermissionService } from "./auth/permission-service.js";
import { ResourcePermissionStore } from "./auth/resource-permission-store.js";
import { loadConnections, saveConnections, type StoredConnection } from "./connection-store.js";
import { installSessionRoutes } from "./context/session-routes.js";
import { SqliteSessionStore } from "./context/session-store.js";
import type { RequestContext } from "./core/types.js";
import { executeSql, getSchema, prepareSql, testDatabase, validateConfig } from "./database.js";
import { ErpQueryService } from "./domain/erp/erp-query-service.js";
import { MappingRegistryStore } from "./domain/erp/schema-mapping/mapping-registry.js";
import { MappingReviewService, type MappingDraftInput } from "./domain/erp/schema-mapping/mapping-review-service.js";
import type { SchemaSearchResult } from "./domain/erp/schema-mapping/types.js";
import { installModelRoutes } from "./llm/model-routes.js";
import { ModelRouter } from "./llm/model-router.js";
import { ModelService } from "./llm/model-service.js";
import { ModelStore } from "./llm/model-store.js";
import { installKnowledgeRoutes } from "./knowledge/knowledge-routes.js";
import { KnowledgeStore } from "./knowledge/knowledge-store.js";
import { ManagedEmbeddingProvider } from "./knowledge/embedding.js";
import { createVectorStore } from "./knowledge/vector-store.js";
import { KnowledgeRetrievalService } from "./knowledge/retrieval-service.js";
import { assertAgentSql } from "./security/sql-policy.js";
import { DatabaseQueryTool } from "./tools/database-query-tool.js";
import { MetricSearchTool } from "./tools/metric-search-tool.js";
import { SchemaSearchTool } from "./tools/schema-search-tool.js";
import { ToolRegistry } from "./tools/tool-registry.js";
import { WorkflowEngine } from "./workflow/workflow-engine.js";
import { installWorkflowRoutes } from "./workflow/workflow-routes.js";
import { WorkflowStore } from "./workflow/workflow-store.js";
import { createCorsOptions } from "./http/cors-policy.js";

const app = express();
const port = Number(process.env.API_PORT || 3001);
const connections = loadConnections();
const accounts = new AccountStore();
const identities = new EnvironmentIdentityProvider(accounts);
const permissions = new PermissionService();
const resourcePermissions = new ResourcePermissionStore();
const sessions = new SqliteSessionStore();
const modelStore = new ModelStore(undefined, undefined, resourcePermissions);
const modelRouter = new ModelRouter(modelStore);
const model = new ModelService(modelStore, modelRouter);
const mappingRegistry = new MappingRegistryStore();
const mappingReview = new MappingReviewService(mappingRegistry, permissions);
const knowledge = new KnowledgeStore(undefined, resourcePermissions);
const vectors = createVectorStore();
const embeddings = new ManagedEmbeddingProvider(model);
const knowledgeRetrieval = new KnowledgeRetrievalService(knowledge, vectors, embeddings, model);
const tools = new ToolRegistry()
  .register(new MetricSearchTool())
  .register(new SchemaSearchTool(permissions, mappingRegistry))
  .register(new DatabaseQueryTool(permissions));
const agent = new DataAgent(tools, permissions, sessions, new ErpQueryService(model));
const workflows = new WorkflowStore();
const workflowEngine = new WorkflowEngine({
  store: workflows,
  models: model,
  knowledgeRetrieval,
  permissions,
  connection: (context, id) => getConnectionItem(id, context).config,
});

app.use(cors(createCorsOptions()));
app.use(express.json({ limit: "2mb" }));
installAuthRoutes(app, accounts);

app.get("/api/health", (_request, response) => response.json({ ok: true, service: "datapilot-api" }));
app.use("/api", createApiKeyGuard(identity));
app.use("/api", (request, response, next) => {
  try { identity(request); next(); }
  catch { response.status(401).json({ error: "请先登录" }); }
});
app.get("/api/me", (request, response) => {
  try {
    const context = identity(request);
    response.json({ ...context, capabilities: permissions.policy(context).capabilities });
  } catch (error) { response.status(401).json({ error: errorMessage(error) }); }
});

installSessionRoutes(app, sessions, identity, (context, datasourceId) => { getConnectionItem(datasourceId, context); });
installKnowledgeRoutes(app, knowledge, vectors, embeddings, identity, model, knowledgeRetrieval);
installModelRoutes(app, model, permissions, identity);
installWorkflowRoutes(app, workflows, workflowEngine, identity, (context, agentId, type, resourceId) => {
  const ownerContext = workflows.executionContext(context, agentId, type);
  if (type === "datasource") { getConnectionItem(resourceId, context); return; }
  if (type === "knowledge_base") { knowledge.get(ownerContext, resourceId); return; }
  model.get(ownerContext, resourceId);
});
installQueryRoutes(app, { identity, permissions, sessions, agent, connection: (id, context) => getConnectionItem(id, context).config });

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

app.listen(port, "0.0.0.0", () => console.log(`DataPilot API: http://0.0.0.0:${port}`));

function identity(request: Request) { return identities.resolve(request); }
function belongsTo(connectionId: string, item: StoredConnection, context: RequestContext) {
  return item.tenantId === context.tenantId && item.accountSetId === context.accountSetId && (!item.ownerId || item.ownerId === context.userId || item.permission === "tenant" || Boolean(resourcePermissions.access(context, "datasource", connectionId, item.ownerId, "private")));
}
function getConnectionItem(id: string, context: RequestContext) {
  const item = connections.get(id);
  if (!item || !belongsTo(id, item, context)) throw new Error("数据源不存在或无权访问");
  return item;
}
function publicConnection(connectionId: string, item: StoredConnection) {
  return { connectionId, name: item.config.name, engine: item.config.engine, host: item.config.host, port: item.config.port, database: item.config.database, sshEnabled: !!item.config.ssh?.enabled, version: item.details.version, tables: item.details.tables, permission: item.permission || "tenant", createdAt: item.createdAt };
}
function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "未知错误";
  if (/access denied/i.test(message)) return "数据库用户名或密码错误";
  if (/private key|Cannot parse/i.test(message)) return "SSH 私钥无效或需要正确的私钥口令";
  if (/ECONNREFUSED|Timed out|timeout|ENOTFOUND/i.test(message)) return "无法连接数据库或 SSH 服务器，请检查地址、端口和网络";
  return message.slice(0, 300);
}
