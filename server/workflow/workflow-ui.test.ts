import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync("app/page.tsx", "utf8");
const studio = readFileSync("components/datapilot/agent-studio.tsx", "utf8");

test("sidebar places the agent module between smart Q&A and datasource navigation", () => {
  const smartQa = page.indexOf("智能问答");
  const agent = page.indexOf(">智能体</button>");
  const datasource = page.indexOf(">数据源</button>");
  assert.ok(smartQa >= 0 && agent > smartQa && datasource > agent);
  assert.match(page, /!chatHasConversation && view !== "agents"/);
});

test("agent studio exposes all V1 nodes, workflow controls, and execution inspection", () => {
  for (const label of ["开始", "LLM", "Agent", "知识库检索", "SQL 查询", "HTTP 请求", "代码", "条件分支", "变量赋值", "结束"]) assert.match(studio, new RegExp(label));
  for (const section of ["用户输入（支持变量引用）", "系统提示词", "用户提示词", "Tools", "最大迭代次数", "响应超时", "流式输出", "上下文 / Memory", "高级设置 · 模型参数"]) assert.match(studio, new RegExp(section));
  for (const control of ["保存", "运行", "Input", "Output", "Error", "Duration"]) assert.match(studio, new RegExp(control));
  assert.match(studio, /导入 JSON 文件/);
  assert.match(studio, /accept="\.json,application\/json"/);
  assert.match(studio, /createRunInputTemplate/);
  assert.match(studio, /请在右侧运行面板补充字段/);
  for (const mode of ["对话", "任务", "网络钩子"]) assert.match(studio, new RegExp(mode));
  for (const setting of ["开场白开关", "开场白文案", "Webhook URL", "Security", "Response"]) assert.match(studio, new RegExp(setting));
  assert.match(studio, /ReactFlow/);
  assert.match(studio, /application\/datapilot-node/);
  assert.match(studio, /targetHandle === "tools"/);
  assert.match(studio, /id="tools" type="target"/);
  assert.match(studio, /workflow-agent-input/);
  assert.match(studio, /workflow-agent-output/);
  assert.match(studio, /connectionRadius=\{36\}/);
  assert.match(studio, /connectionMode=\{ConnectionMode\.Loose\}/);
  assert.match(studio, /id="input" type="target"[^>]+isConnectableStart=\{false\}[^>]+isConnectableEnd/);
  assert.match(studio, /id="output" type="source"[^>]+isConnectableStart[^>]+isConnectableEnd=\{false\}/);
  assert.match(studio, /MarkerType\.ArrowClosed/);
  assert.match(studio, /animated: false/);
  assert.match(studio, /onNodeDoubleClick/);
  assert.doesNotMatch(studio, /onNodeClick=/);
  assert.match(studio, /aria-label="关闭设置"/);
  for (const setting of ["推理模型", "系统提示词", "工具列表", "用户输入", "最大迭代", "流式输出"]) assert.match(studio, new RegExp(setting));
  for (const setting of ["Metadata Filters", "检索方式", "Score Threshold", "重排模型", "重排 Top K"]) assert.match(studio, new RegExp(setting));
  for (const setting of ["添加 ELSEIF", "满足全部 AND", "满足任一 OR", "嵌套组", "其他所有情况"]) assert.match(studio, new RegExp(setting));
  assert.match(studio, /conditionBranches\.map/);
  assert.match(studio, /className="agent-palette-group" open/);
  assert.match(studio, /输入\/输出/);
  assert.match(studio, /inputOutputNodes\.map/);
  assert.match(studio, /<span>AI<\/span>/);
  assert.match(studio, /aiNodes\.map/);
  assert.match(studio, /KnowledgeCylinderIcon/);
  assert.match(studio, /<span>工具<\/span>/);
  assert.match(studio, /toolNodes\.map/);
  assert.match(studio, /<span>逻辑<\/span>/);
  assert.match(studio, /logicNodes\.map/);
  assert.match(studio, /CodeTerminalIcon/);
  assert.match(studio, /PaletteChevronIcon/);
});

test("workflow run opens a mode-aware side panel instead of a top JSON input", () => {
  assert.doesNotMatch(studio, /className="agent-run-input"/);
  assert.match(studio, /setRunnerOpen\(true\)/);
  assert.match(studio, /agent-runner-shell/);
  assert.match(studio, /对话调试/);
  assert.match(studio, /任务运行/);
  assert.match(studio, /执行日志/);
  assert.match(studio, /请输入消息/);
  assert.match(studio, /extractConversationInput\(query, inputs, conversationValues\)/);
  assert.match(studio, /execute\(\{ \.\.\.nextInput, __conversationHistory: history \}\)/);
  assert.match(studio, /customerFacingRunReply\(result, nodes\)/);
  assert.match(studio, /const reply = result \?[^\n]+: customerFacingRunError\(null\)/);
  assert.doesNotMatch(studio, /return pretty\(value\)/);
});

test("agent editor exposes publish, version history, logs, export, settings, and permissions", () => {
  for (const control of ["确认发布", "历史版本", "运行日志", "导出", "智能体设置", "仅自己", "当前团队", "回退到此版本"]) assert.match(studio, new RegExp(control));
  assert.match(studio, /\/versions\/\$\{version\}\/restore/);
  assert.match(studio, /\/workflow-runs\/\$\{id\}/);
  assert.match(studio, /URL\.createObjectURL/);
});
