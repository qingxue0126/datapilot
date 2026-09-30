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
  rateLimit?: number;
  now?: () => number;
  log?: (entry: QueryAuditEntry) => void;
};

export type QueryAuditEntry = {
  requestId: string; path: string; userId?: string; tenantId?: string; accountSetId?: string;
  credential: "api-key" | "session" | "unknown"; sessionId?: string; status: number; durationMs: number; ip?: string;
};

export function installQueryRoutes(app: Express, dependencies: QueryDependencies) {
  const limiter = new FixedWindowRateLimiter(dependencies.rateLimit ?? configuredRateLimit(), 60_000, dependencies.now);
  app.post("/api/query", (request, response) => handleQuery(request, response, dependencies, limiter, false));
  app.post("/api/query/stream", (request, response) => handleQueryStream(request, response, dependencies, false));
  app.post("/api/v1/query", (request, response) => handleQuery(request, response, dependencies, limiter, true));
}

async function handleQuery(request: Request, response: Response, dependencies: QueryDependencies, limiter: FixedWindowRateLimiter, external: boolean) {
  const started = Date.now();
  const requestId = randomUUID();
  let context: RequestContext | undefined;
  let status = 200;
  let analysisSessionId: string | undefined;
  try {
    context = dependencies.identity(request);
    if (external && context.sessionId.startsWith("api-key:")) {
      const decision = limiter.consume(context.sessionId);
      response.setHeader("X-RateLimit-Limit", String(decision.limit));
      response.setHeader("X-RateLimit-Remaining", String(decision.remaining));
      if (!decision.allowed) {
        response.setHeader("Retry-After", String(decision.retryAfterSeconds));
        status = 429;
        return response.status(status).json({ error: "API Key 请求过于频繁，请稍后重试", requestId });
      }
    }
    const prepared = prepareQuery(request, context, dependencies, external);
    analysisSessionId = prepared.sessionId;
    const result = await dependencies.agent.run({
      question: prepared.question, context, sessionId: prepared.sessionId, datasourceId: prepared.datasourceId,
      connection: prepared.connection, preferredModelId: prepared.preferredModelId,
    });
    return response.json({ ...result, sessionId: prepared.sessionId, requestId });
  } catch (error) {
    status = queryErrorStatus(error);
    return response.status(status).json({ error: errorMessage(error), requestId });
  } finally {
    audit(dependencies, request, { requestId, context, status, sessionId: analysisSessionId, started });
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

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();
  constructor(private readonly limit: number, private readonly windowMs = 60_000, private readonly now = () => Date.now()) {}
  consume(key: string) {
    const current = this.now();
    let window = this.windows.get(key);
    if (!window || current - window.startedAt >= this.windowMs) {
      window = { startedAt: current, count: 0 };
      this.windows.set(key, window);
    }
    window.count += 1;
    return {
      allowed: window.count <= this.limit, limit: this.limit, remaining: Math.max(0, this.limit - window.count),
      retryAfterSeconds: Math.max(1, Math.ceil((window.startedAt + this.windowMs - current) / 1000)),
    };
  }
}

class QueryRequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
function configuredRateLimit() {
  const value = Number(process.env.API_KEY_QUERY_RATE_LIMIT_PER_MINUTE || 60);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 60;
}
function queryErrorStatus(error: unknown) {
  if (error instanceof QueryRequestError || error instanceof SessionStoreError) return error.status;
  return error instanceof Error && /无权|forbidden/i.test(error.message) ? 403 : 400;
}
function errorMessage(error: unknown) { return (error instanceof Error ? error.message : "问数服务异常").slice(0, 300); }
function audit(dependencies: QueryDependencies, request: Request, input: { requestId: string; context?: RequestContext; status: number; sessionId?: string; started: number }) {
  const entry: QueryAuditEntry = {
    requestId: input.requestId, path: request.path, userId: input.context?.userId, tenantId: input.context?.tenantId,
    accountSetId: input.context?.accountSetId, credential: input.context?.sessionId.startsWith("api-key:") ? "api-key" : input.context ? "session" : "unknown",
    sessionId: input.sessionId, status: input.status, durationMs: Date.now() - input.started, ip: request.ip,
  };
  (dependencies.log || ((value) => console.info(JSON.stringify({ event: "query_api", ...value }))))(entry);
}
