import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync("app/page.tsx", "utf8");
const studio = readFileSync("components/datapilot/agent-studio.tsx", "utf8");

test("sidebar places the agent module between new analysis and datasource navigation", () => {
  const newAnalysis = page.indexOf("新建分析");
  const agent = page.indexOf(">智能体</button>");
  const datasource = page.indexOf(">数据源</button>");
  assert.ok(newAnalysis >= 0 && agent > newAnalysis && datasource > agent);
});

test("agent studio exposes all V1 nodes, workflow controls, and execution inspection", () => {
  for (const label of ["开始", "LLM", "SQL 查询", "HTTP 请求", "代码", "条件分支", "变量赋值", "结束"]) assert.match(studio, new RegExp(label));
  for (const control of ["保存", "运行", "Input", "Output", "Error", "Duration"]) assert.match(studio, new RegExp(control));
  assert.match(studio, /导入 JSON 文件/);
  assert.match(studio, /accept="\.json,application\/json"/);
  assert.match(studio, /createRunInputTemplate/);
  assert.match(studio, /请在运行输入中填写/);
  assert.match(studio, /ReactFlow/);
  assert.match(studio, /application\/datapilot-node/);
});
