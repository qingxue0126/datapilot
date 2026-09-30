import type { Express, Request } from "express";
import type { RequestContext } from "../core/types.js";
import { SessionStoreError, type SessionStore } from "./session-store.js";

export function installSessionRoutes(
  app: Express,
  store: SessionStore,
  resolveIdentity: (request: Request) => RequestContext,
  validateDatasource?: (context: RequestContext, datasourceId: string) => void,
) {
  app.get("/api/sessions", (request, response) => {
    try { response.json({ items: store.list(resolveIdentity(request)) }); }
    catch (error) { sessionError(response, error); }
  });

  app.post("/api/sessions", (request, response) => {
    try {
      const title = request.body?.title === undefined ? undefined : String(request.body.title);
      const datasourceId = request.body?.datasourceId === undefined ? undefined : String(request.body.datasourceId);
      const context = resolveIdentity(request);
      if (datasourceId) validateDatasource?.(context, datasourceId);
      response.status(201).json({ session: store.create(context, { title, datasourceId }) });
    } catch (error) { sessionError(response, error); }
  });

  app.get("/api/sessions/:id", (request, response) => {
    try { response.json(store.get(resolveIdentity(request), request.params.id)); }
    catch (error) { sessionError(response, error); }
  });

  app.patch("/api/sessions/:id", (request, response) => {
    try {
      const input: { title?: string; datasourceId?: string | null; pinned?: boolean } = {};
      if (request.body?.title !== undefined) input.title = String(request.body.title);
      if (request.body?.datasourceId !== undefined) input.datasourceId = request.body.datasourceId === null ? null : String(request.body.datasourceId);
      if (request.body?.pinned !== undefined) {
        if (typeof request.body.pinned !== "boolean") throw new SessionStoreError("pinned 必须是布尔值");
        input.pinned = request.body.pinned;
      }
      if (input.title === undefined && input.datasourceId === undefined && input.pinned === undefined) throw new SessionStoreError("没有可更新的字段");
      const context = resolveIdentity(request);
      if (input.datasourceId) validateDatasource?.(context, input.datasourceId);
      response.json({ session: store.update(context, request.params.id, input) });
    } catch (error) { sessionError(response, error); }
  });

  app.post("/api/sessions/:id/exchanges", (request, response) => {
    try {
      const question = typeof request.body?.question === "string" ? request.body.question.trim() : "";
      const answer = typeof request.body?.answer === "string" ? request.body.answer.trim() : "";
      const datasourceId = typeof request.body?.datasourceId === "string" ? request.body.datasourceId.trim() : undefined;
      if (!question) throw new SessionStoreError("问题不能为空");
      if (!answer) throw new SessionStoreError("回答不能为空");
      const context = resolveIdentity(request);
      if (datasourceId) validateDatasource?.(context, datasourceId);
      const result = request.body?.result && typeof request.body.result === "object" && !Array.isArray(request.body.result)
        ? request.body.result as Record<string, unknown>
        : {};
      response.status(201).json(store.appendExchange(context, request.params.id, {
        question, answer, datasourceId, result: { ...result, question },
      }));
    } catch (error) { sessionError(response, error); }
  });

  app.delete("/api/sessions/:id", (request, response) => {
    try { store.delete(resolveIdentity(request), request.params.id); response.status(204).end(); }
    catch (error) { sessionError(response, error); }
  });
}

function sessionError(response: { status: (code: number) => { json: (value: unknown) => unknown } }, error: unknown) {
  const status = error instanceof SessionStoreError ? error.status : 400;
  response.status(status).json({ error: error instanceof Error ? error.message : "会话操作失败" });
}
