import type { Express, Request, Response } from "express";
import type { RequestContext } from "../core/types.js";
import type { WorkflowEngine } from "./workflow-engine.js";
import { validateAndSort } from "./workflow-engine.js";
import { importRagflowWorkflow } from "./ragflow-importer.js";
import { WorkflowStore, WorkflowStoreError } from "./workflow-store.js";
import type { WorkflowDefinition } from "./workflow-types.js";
import { closeSse, openSse, sseAbortSignal, writeSse } from "../http/sse.js";

export function installWorkflowRoutes(app: Express, store: WorkflowStore, engine: WorkflowEngine, identity: (request: Request) => RequestContext) {
  app.get("/api/agents", (request, response) => handle(response, () => ({ items: store.listAgents(identity(request)) })));
  app.post("/api/agents", (request, response) => handle(response, () => store.createAgent(identity(request), { name: String(request.body?.name || ""), description: request.body?.description }), 201));
  app.post("/api/agents/import", (request, response) => handle(response, () => {
    const context = identity(request);
    const imported = importRagflowWorkflow(request.body?.definition, { defaultModelId: String(request.body?.defaultModelId || "") });
    validateAndSort(imported.definition);
    const created = store.createAgent(context, {
      name: String(request.body?.name || "RAGFlow 智能体"),
      description: String(request.body?.description || "从 RAGFlow JSON 导入"),
    });
    try {
      const workflow = store.saveWorkflow(context, created.agent.id, imported.definition);
      return { agent: store.getAgent(context, created.agent.id), workflow, report: imported.report };
    } catch (error) {
      store.deleteAgent(context, created.agent.id);
      throw error;
    }
  }, 201));
  app.get("/api/agents/:id", (request, response) => handle(response, () => { const context = identity(request); store.requireEdit(context, request.params.id); return { agent: store.getAgent(context, request.params.id), workflow: store.getWorkflow(context, request.params.id), runs: store.listRuns(context, request.params.id) }; }));
  app.patch("/api/agents/:id", (request, response) => handle(response, () => ({ agent: store.updateAgent(identity(request), request.params.id, request.body || {}) })));
  app.delete("/api/agents/:id", (request, response) => handle(response, () => { store.deleteAgent(identity(request), request.params.id); return undefined; }, 204));
  app.post("/api/agents/:id/copy", (request, response) => handle(response, () => store.copyAgent(identity(request), request.params.id), 201));
  app.post("/api/agents/:id/publish", (request, response) => handle(response, () => store.publish(identity(request), request.params.id, request.body?.enabled !== false, request.body?.permission)));
  app.get("/api/agents/:id/member-permissions", (request, response) => handle(response, () => ({ items: store.listMemberPermissions(identity(request), request.params.id) })));
  app.put("/api/agents/:id/member-permissions/:userId", (request, response) => handle(response, () => ({ items: store.setMemberPermission(identity(request), request.params.id, request.params.userId, request.body?.access === null ? null : request.body?.access) })));
  app.get("/api/agents/:id/versions", (request, response) => handle(response, () => ({ items: store.listVersions(identity(request), request.params.id) })));
  app.get("/api/agents/:id/versions/:version", (request, response) => handle(response, () => ({ version: store.getVersion(identity(request), request.params.id, versionNumber(request.params.version)) })));
  app.post("/api/agents/:id/versions/:version/restore", (request, response) => handle(response, () => ({ workflow: store.restoreVersion(identity(request), request.params.id, versionNumber(request.params.version)), agent: store.getAgent(identity(request), request.params.id) })));
  app.get("/api/agents/:id/runs", (request, response) => handle(response, () => ({ items: store.listRuns(identity(request), request.params.id) })));
  app.get("/api/agents/:id/export", (request, response) => {
    try {
      const context = identity(request); const agent = store.getAgent(context, request.params.id); const workflow = store.getWorkflow(context, request.params.id);
      response.setHeader("Content-Disposition", `attachment; filename="datapilot-agent-${agent.id}.json"`);
      response.json({ format: "datapilot-agent", schemaVersion: 1, exportedAt: new Date().toISOString(), agent: { name: agent.name, description: agent.description, permission: agent.permission }, workflow: workflow.definition });
    } catch (error) { workflowError(response, error); }
  });
  app.put("/api/agents/:id/workflow", (request, response) => handle(response, () => {
    const definition = request.body?.definition as WorkflowDefinition;
    validateAndSort(definition);
    return { workflow: store.saveWorkflow(identity(request), request.params.id, definition) };
  }));
  app.post("/api/agents/:id/run", (request, response) => {
    try { response.status(202).json({ run: engine.start(identity(request), request.params.id, cleanInput(request.body?.input)) }); }
    catch (error) { workflowError(response, error); }
  });
  app.post("/api/agents/:id/run/stream", async (request, response) => {
    let streamRunId = "";
    try {
      const context = identity(request);
      const input = cleanInput(request.body?.input);
      openSse(response);
      const signal = sseAbortSignal(response);
      const run = await engine.run(context, request.params.id, input, {
        signal,
        onStart: (started) => { streamRunId = started.id; writeSse(response, "start", { runId: started.id }); },
        onDelta: (event) => writeSse(response, "delta", event),
      });
      if (!signal.aborted) writeSse(response, "done", { runId: run.id, result: run });
      closeSse(response);
    } catch (error) {
      if (response.headersSent) {
        writeSse(response, "error", { runId: streamRunId || undefined, message: error instanceof Error ? error.message : "工作流运行失败" });
        return closeSse(response);
      }
      return workflowError(response, error);
    }
  });
  app.get("/api/workflow-runs/:id", (request, response) => handle(response, () => ({ run: store.getRun(identity(request), request.params.id) })));
}

function handle(response: Response, operation: () => unknown, status = 200) {
  try { const value = operation(); if (status === 204) return response.status(204).end(); return response.status(status).json(value); }
  catch (error) { return workflowError(response, error); }
}
function workflowError(response: Response, error: unknown) { const status = error instanceof WorkflowStoreError ? error.status : 400; return response.status(status).json({ error: error instanceof Error ? error.message : "工作流操作失败" }); }
function cleanInput(value: unknown) { if (value === undefined || value === null) return {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkflowStoreError("运行输入必须是 JSON 对象"); return value as Record<string, unknown>; }
function versionNumber(value: string) { const version = Number(value); if (!Number.isInteger(version) || version < 1) throw new WorkflowStoreError("无效的版本号"); return version; }
