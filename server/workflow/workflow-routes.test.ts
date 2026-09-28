import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express, { type Request } from "express";
import type { RequestContext } from "../core/types.js";
import type { WorkflowEngine } from "./workflow-engine.js";
import { installWorkflowRoutes } from "./workflow-routes.js";
import { WorkflowStore } from "./workflow-store.js";

test("RAGFlow import API creates a tenant-scoped editable workflow", async () => {
  const store = new WorkflowStore(":memory:");
  const app = express(); app.use(express.json({ limit: "6mb" }));
  installWorkflowRoutes(app, store, {} as WorkflowEngine, (request: Request) => ({
    tenantId: String(request.header("x-tenant") || "tenant-a"), accountSetId: "books", userId: String(request.header("x-user") || "alice"), role: "tenant_admin", sessionId: "s",
  } satisfies RequestContext));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${base}/api/agents/import`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        name: "客服 V4", defaultModelId: "model-1", definition: { graph: {
          nodes: [
            { id: "begin", type: "beginNode", data: { label: "Begin", name: "开始", form: {} } },
            { id: "Agent:One", type: "agentNode", data: { label: "Agent", name: "回答", form: { prompts: [{ role: "user", content: "{sys.query}" }] } } },
            { id: "Message:One", type: "messageNode", data: { label: "Message", name: "结束", form: { content: ["{Agent:One@content}"] } } },
          ], edges: [{ source: "begin", target: "Agent:One" }, { source: "Agent:One", target: "Message:One" }],
        } },
      }),
    });
    assert.equal(response.status, 201);
    const imported = await response.json() as { agent: { id: string; name: string }; workflow: { definition: { nodes: { type: string }[] } }; report: { importedNodes: number } };
    assert.equal(imported.agent.name, "客服 V4");
    assert.equal(imported.report.importedNodes, 3);
    assert.deepEqual(imported.workflow.definition.nodes.map((node) => node.type), ["start", "llm", "end"]);
    assert.equal((await fetch(`${base}/api/agents/${imported.agent.id}`, { headers: { "x-user": "bob" } })).status, 404);
  } finally { server.close(); await once(server, "close"); }
});
