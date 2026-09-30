import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { PermissionService } from "../auth/permission-service.js";
import type { SessionStore } from "../context/session-store.js";
import { SessionStoreError } from "../context/session-store.js";
import type { RequestContext } from "../core/types.js";
import type { DatabaseConfig } from "../database.js";
import { closeSse, openSse, sseAbortSignal, writeSse } from "../http/sse.js";
import type { DataAgent } from "./data-agent.js";

type QueryDependencies = {
  identity: (request: Request) => RequestContext;
  permissions: Pick<PermissionService, "require">;
  sessions: SessionStore;
  agent: Pick<DataAgent, "run">;
  connection: (id: string, context: RequestContext) => DatabaseConfig;
};

export function installQueryRoutes(app: Express, dependencies: QueryDependencies) {
  app.post("/api/query", (request, response) => handleQuery(request, response, dependencies, false));
  app.post("/api/query/stream", (request, response) => handleQueryStream(request, response, dependencies, false));
  app.post("/api/v1/query", (request, response) => handleQuery(request, response, dependencies, true));
}

async function handleQuery(request: Request, response: Response, dependencies: QueryDependencies, external: boolean) {
  const requestId = randomUUID();
  try {
    const context = dependencies.identity(request);
    const prepared = prepareQuery(request, context, dependencies, external);
    const result = await dependencies.agent.run({
      question: prepared.question, context, sessionId: prepared.sessionId, datasourceId: prepared.datasourceId,
      connection: prepared.connection, preferredModelId: prepared.preferredModelId,
    });
    return response.json({ ...result, sessionId: prepared.sessionId, requestId });
  } catch (error) {
    return response.status(queryErrorStatus(error)).json({ error: errorMessage(error), requestId });
  }
}

async function handleQueryStream(request: Request, response: Response, dependencies: QueryDependencies, external: boolean) {
  let streamRunId = "";
  try {
    const context = dependencies.identity(request);
    const prepared = prepareQuery(request, context, dependencies, external);
    streamRunId = randomUUID();
    openSse(response);
    const signal = sseAbortSignal(response);
    writeSse(response, "start", { runId: streamRunId, sessionId: prepared.sessionId });
    const result = await dependencies.agent.run({
      question: prepared.question, context, sessionId: prepared.sessionId, datasourceId: prepared.datasourceId,
      connection: prepared.connection, preferredModelId: prepared.preferredModelId, runId: streamRunId, signal,
      onToken: (delta) => writeSse(response, "delta", { runId: streamRunId, delta }),
    });
    if (!signal.aborted) writeSse(response, "done", { runId: streamRunId, sessionId: prepared.sessionId, result });
    closeSse(response);
  } catch (error) {
    if (response.headersSent) {
      writeSse(response, "error", { runId: streamRunId || undefined, message: errorMessage(error) });
      return closeSse(response);
    }
    return response.status(queryErrorStatus(error)).json({ error: errorMessage(error) });
  }
}

function prepareQuery(request: Request, context: RequestContext, dependencies: QueryDependencies, external: boolean) {
  dependencies.permissions.require(context, "agent:query");
  const question = String(request.body?.question || "").trim().slice(0, 500);
  if (!question) throw new QueryRequestError("请输入问题", 400);
  const datasourceId = String(request.body?.connectionId || request.body?.datasourceId || request.body?.datasource_id || "").trim();
  if (!datasourceId) throw new QueryRequestError("请选择数据源", 400);
  const connection = dependencies.connection(datasourceId, context);
  let sessionId = String(request.body?.sessionId || request.body?.session_id || "").trim();
  if (!sessionId && external) sessionId = dependencies.sessions.create(context, { title: question, datasourceId }).id;
  if (!sessionId) throw new QueryRequestError("请先创建或选择一个分析", 400);
  dependencies.sessions.get(context, sessionId);
  const preferredModelId = String(request.body?.model || request.body?.modelId || request.body?.model_id || "").trim() || undefined;
  return { question, datasourceId, connection, sessionId, preferredModelId };
}

class QueryRequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
function queryErrorStatus(error: unknown) {
  if (error instanceof QueryRequestError || error instanceof SessionStoreError) return error.status;
  return error instanceof Error && /无权|forbidden/i.test(error.message) ? 403 : 400;
}
function errorMessage(error: unknown) { return (error instanceof Error ? error.message : "问数服务异常").slice(0, 300); }
