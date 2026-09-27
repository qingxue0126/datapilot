import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { PermissionService } from "../auth/permission-service.js";
import type { RequestContext } from "../core/types.js";
import { installModelRoutes } from "./model-routes.js";
import { ModelRouter } from "./model-router.js";
import { ModelService } from "./model-service.js";
import { ModelStore } from "./model-store.js";

test("model API provides scoped CRUD and never returns a plaintext API key", async () => {
  const store = new ModelStore(":memory:", Buffer.alloc(32, 6));
  const service = new ModelService(store, new ModelRouter(store)); const permissions = new PermissionService();
  const app = express(); app.use(express.json());
  installModelRoutes(app, service, permissions, (request) => ({ tenantId: String(request.header("x-tenant") || "tenant-a"), accountSetId: "books-a",
    userId: String(request.header("x-user") || "alice"), role: (request.header("x-role") || "tenant_admin") as RequestContext["role"], sessionId: "s" }));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const payload = { name: "Test", provider: "openai-compatible", modelId: "model-a", baseUrl: "https://example.test/v1", apiKey: "sk-private-abcd",
      contextWindow: 8000, timeout: 30000, maxRetries: 1, temperature: 0, supportsTools: true, supportsStructuredOutput: true, supportsVision: false, enabled: true };
    const createdResponse = await fetch(`${base}/api/models`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as Record<string, unknown>;
    assert.equal(created.apiKeyMasked, "sk-****abcd"); assert.equal("apiKey" in created, false); assert.doesNotMatch(JSON.stringify(created), /sk-private-abcd/);
    const id = String(created.id);
    const listed = await fetch(`${base}/api/models`).then((response) => response.text());
    assert.match(listed, /sk-\*\*\*\*abcd/); assert.doesNotMatch(listed, /sk-private-abcd/);
    assert.equal((await fetch(`${base}/api/models/${id}`, { headers: { "x-user": "bob" } })).status, 404);
    assert.equal((await fetch(`${base}/api/models`, { method: "POST", headers: { "Content-Type": "application/json", "x-role": "finance_analyst" }, body: JSON.stringify(payload) })).status, 403);
  } finally { server.close(); await once(server, "close"); }
});
