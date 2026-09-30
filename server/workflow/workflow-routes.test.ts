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
    tenantId: String(request.header("x-tenant") || "tenant-a"), accountSetId: "books", userId: String(request.header("x-user") || "alice"), role: request.header("x-role") === "member" ? "finance_viewer" : "tenant_admin", sessionId: "s",
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
    const unpublishedVersions = await fetch(`${base}/api/agents/${imported.agent.id}/versions`);
    assert.deepEqual((await unpublishedVersions.json() as { items: unknown[] }).items, []);
    const publish = await fetch(`${base}/api/agents/${imported.agent.id}/publish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ permission: "tenant" }) });
    assert.equal(publish.status, 200);
    const published = await publish.json() as { agent: { permission: string }; version: { version: number } };
    assert.equal(published.agent.permission, "tenant"); assert.equal(published.version.version, 1);
    const versions = await fetch(`${base}/api/agents/${imported.agent.id}/versions`);
    assert.equal((await versions.json() as { items: unknown[] }).items.length, 1);
    const exported = await fetch(`${base}/api/agents/${imported.agent.id}/export`);
    assert.match(exported.headers.get("content-disposition") || "", /attachment/);
    assert.equal((await exported.json() as { format: string }).format, "datapilot-agent");
    assert.equal((await fetch(`${base}/api/agents/${imported.agent.id}`, { headers: { "x-user": "bob", "x-role": "member" } })).status, 403);
    const grant = await fetch(`${base}/api/agents/${imported.agent.id}/member-permissions/bob`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access: "use" }) });
    assert.equal(grant.status, 200);
    const bobList = await fetch(`${base}/api/agents`, { headers: { "x-user": "bob", "x-role": "member" } });
    assert.equal((await bobList.json() as { items: unknown[] }).items.length, 1);
    assert.equal((await fetch(`${base}/api/agents/${imported.agent.id}`, { headers: { "x-user": "bob", "x-role": "member" } })).status, 403);
    assert.equal((await fetch(`${base}/api/agents/${imported.agent.id}`, { headers: { "x-user": "bob", "x-tenant": "tenant-b", "x-role": "member" } })).status, 403);
  } finally { server.close(); await once(server, "close"); }
});

test("workflow streaming API emits start, node delta, and done events", async () => {
  const store = new WorkflowStore(":memory:");
  const app = express(); app.use(express.json());
  const result = { id: "run-1", status: "success", output: "你好", error: null, durationMs: 4, nodeRuns: [] };
  const engine = { run: async (_context: RequestContext, _id: string, _input: unknown, listener: { onStart?: (run: unknown) => void; onDelta?: (event: unknown) => void }) => {
    listener.onStart?.({ id: "run-1" });
    listener.onDelta?.({ runId: "run-1", nodeId: "llm", delta: "你", text: "你" });
    listener.onDelta?.({ runId: "run-1", nodeId: "llm", delta: "好", text: "你好" });
    return result;
  } } as unknown as WorkflowEngine;
  installWorkflowRoutes(app, store, engine, () => contextForTest());
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("测试服务未启动");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/agents/agent-1/run/stream`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: { query: "你好" } }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
    const body = await response.text();
    assert.match(body, /event: start\ndata: {"runId":"run-1"}/);
    assert.match(body, /event: delta\ndata: {"runId":"run-1","nodeId":"llm","delta":"你","text":"你"}/);
    assert.match(body, /event: done\ndata: {"runId":"run-1","result":/);
  } finally { server.close(); await once(server, "close"); }
});

function contextForTest(): RequestContext {
  return { tenantId: "tenant-a", accountSetId: "books", userId: "alice", role: "tenant_admin", sessionId: "s" };
}
