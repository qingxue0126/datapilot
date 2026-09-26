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
      const input: { title?: string; datasourceId?: string | null } = {};
      if (request.body?.title !== undefined) input.title = String(request.body.title);
      if (request.body?.datasourceId !== undefined) input.datasourceId = request.body.datasourceId === null ? null : String(request.body.datasourceId);
      if (input.title === undefined && input.datasourceId === undefined) throw new SessionStoreError("没有可更新的字段");
      const context = resolveIdentity(request);
      if (input.datasourceId) validateDatasource?.(context, input.datasourceId);
      response.json({ session: store.update(context, request.params.id, input) });
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
