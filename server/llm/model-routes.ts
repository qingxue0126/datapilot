import type { Express, Request, Response } from "express";
import type { PermissionService } from "../auth/permission-service.js";
import type { RequestContext } from "../core/types.js";
import type { ModelService } from "./model-service.js";
import { ModelStoreError } from "./model-store.js";
import { modelTasks, type ModelTask } from "./model-types.js";

export function installModelRoutes(app: Express, service: ModelService, permissions: PermissionService, identity: (request: Request) => RequestContext) {
  app.get("/api/models", (request, response) => handle(response, () => {
    const context = identity(request); permissions.require(context, "model:read"); const items = service.list(context);
    return { items, defaultModel: items.find((item) => item.enabled && item.modelType === "chat")?.id || null };
  }));
  app.post("/api/models", (request, response) => handle(response, () => {
    const context = identity(request); permissions.require(context, "model:manage"); return service.create(context, request.body);
  }, 201));
  app.get("/api/models/:id", (request, response) => handle(response, () => {
    const context = identity(request); permissions.require(context, "model:read"); return service.get(context, request.params.id);
  }));
  app.patch("/api/models/:id", (request, response) => handle(response, () => {
    const context = identity(request); permissions.require(context, "model:manage"); return service.update(context, request.params.id, request.body);
  }));
  app.delete("/api/models/:id", (request, response) => handle(response, () => {
    const context = identity(request); permissions.require(context, "model:manage"); service.delete(context, request.params.id); return null;
  }, 204));
  app.post("/api/models/:id/test", async (request, response) => {
    try { const context = identity(request); permissions.require(context, "model:manage"); response.json(await service.testConnection(context, request.params.id)); }
    catch (error) { sendError(response, error); }
  });
  app.get("/api/model-routes", (request, response) => handle(response, () => {
    const context = identity(request); permissions.require(context, "model:read"); return { items: service.routes(context) };
  }));
  app.put("/api/model-routes/:task", (request, response) => handle(response, () => {
    const context = identity(request); permissions.require(context, "model:manage"); const task = request.params.task as ModelTask;
    if (!modelTasks.includes(task)) throw new ModelStoreError("不支持的模型路由任务");
    return service.saveRoute(context, task, request.body);
  }));
}

function handle(response: Response, fn: () => unknown, success = 200) {
  try { const result = fn(); if (success === 204) response.status(204).end(); else response.status(success).json(result); }
  catch (error) { sendError(response, error); }
}
function sendError(response: Response, error: unknown) {
  const status = error instanceof ModelStoreError ? error.status : /无权/.test(error instanceof Error ? error.message : "") ? 403 : 400;
  response.status(status).json({ error: (error instanceof Error ? error.message : "未知错误").slice(0, 500) });
}
