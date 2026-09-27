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
