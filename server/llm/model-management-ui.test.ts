import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(new URL("../../components/datapilot/model-management.tsx", import.meta.url), "utf8");

test("model management UI exposes CRUD, safe key handling and connection testing", () => {
  for (const label of ["新增模型", "编辑模型", "测试连接", "删除", "API Key", "apiKeyMasked", "supportsTools", "supportsStructuredOutput", "supportsVision"]) {
    assert.match(component, new RegExp(label));
  }
  assert.match(component, /type="password"/);
  assert.doesNotMatch(component, /defaultValue=\{model\?\.apiKey\}/);
});

test("model management UI configures all required task routes", () => {
  for (const task of ["intent", "text2sql", "sqlRepair", "agent", "answer", "schemaMapping"]) assert.match(component, new RegExp(task));
  for (const field of ["primaryModelId", "fallbackModelId", "temperature", "timeout", "maxRetries"]) assert.match(component, new RegExp(field));
  assert.match(component, /按任务路由/);
});

test("model management UI exposes seven types, capabilities and type-specific fields", () => {
  for (const type of ["llm", "embedding", "rerank", "vision", "multimodal_llm", "multimodal_embedding", "multimodal_rerank"]) assert.match(component, new RegExp(type));
  for (const field of ["capabilities", "embeddingDimension", "maxInputTokens", "topN"]) assert.match(component, new RegExp(field));
  assert.match(component, /按模型类型筛选/);
  assert.match(component, /showsContext/);
  assert.match(component, /showsEmbedding/);
  assert.match(component, /showsRerank/);
});

test("model route bootstrap handles an unavailable API", () => {
  assert.match(component, /async function loadRoutes\(\) \{[\s\S]*?catch \(error\)/);
  assert.match(component, /无法连接 DataPilot API/);
});
