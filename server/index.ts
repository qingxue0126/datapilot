import { errorMessage } from "./shared/errors/error-message.js";
import cors from "cors";
import "dotenv/config";
import express, { type Request } from "express";
import { createCorsOptions } from "./http/cors-policy.js";
import { createVectorStore } from "./infrastructure/vector-store/vector-store.js";
import { DataAgent, installQueryRoutes, installWorkflowRoutes, PhoneSupportHarness, ToolRegistry, WorkflowEngine, WorkflowStore } from "./modules/agent/index.js";
import { AccountStore, createApiKeyGuard, EnvironmentIdentityProvider, installAuthRoutes, PermissionService, ResourcePermissionStore } from "./modules/auth/index.js";
import { installSessionRoutes, SqliteSessionStore } from "./modules/conversation/index.js";
import { createDatasourceAccess, installDatasourceRoutes, loadConnections, MappingRegistryStore, MappingReviewService, SchemaSearchTool } from "./modules/datasource/index.js";
import { installKnowledgeRoutes, KnowledgeRetrievalService, KnowledgeStore, ManagedEmbeddingProvider } from "./modules/knowledge/index.js";
import { installModelRoutes, ModelRouter, ModelService, ModelStore } from "./modules/model/index.js";
import { installOrganizationRoutes } from "./modules/organization/index.js";
import { DatabaseQueryTool, ErpQueryService, MetricSearchTool } from "./modules/text2sql/index.js";

const app = express();
const port = Number(process.env.API_PORT || 3001);
const connections = loadConnections();
const accounts = new AccountStore();
const identities = new EnvironmentIdentityProvider(accounts);
const permissions = new PermissionService();
const resourcePermissions = new ResourcePermissionStore();
const { getConnectionItem } = createDatasourceAccess(connections, resourcePermissions);
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
  phoneSupport: new PhoneSupportHarness({ sessions, models: model, retrieval: knowledgeRetrieval, workflows }),
});

app.use(cors(createCorsOptions()));
app.use(express.json({ limit: "2mb" }));
installAuthRoutes(app, accounts);
installOrganizationRoutes(app, accounts);

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

installDatasourceRoutes(app, { connections, permissions, resourcePermissions, mappingRegistry, mappingReview, tools, identity });

app.listen(port, "0.0.0.0", () => console.log(`DataPilot API: http://0.0.0.0:${port}`));

function identity(request: Request) { return identities.resolve(request); }
