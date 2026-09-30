import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
const logs = readFileSync(new URL("../../components/datapilot/conversation-logs.tsx", import.meta.url), "utf8");
const icons = readFileSync(new URL("../../components/datapilot/icons.tsx", import.meta.url), "utf8");

test("sidebar exposes the conversation log page", () => {
  assert.match(page, /<ConversationLogIcon \/><\/span>日志<\/button>/);
  assert.match(page, /view === "logs" && <ConversationLogs/);
  assert.match(logs, />会话查询<\/h2>/);
  assert.match(logs, /开始时间/);
  assert.match(logs, /结束时间/);
  assert.match(logs, /会话名称、创建人/);
});

test("conversation outputs expose copy and trace actions", () => {
  assert.match(logs, /aria-label="复制输出"/);
  assert.match(logs, /aria-label="查看执行日志"/);
  assert.match(logs, /api\/workflow-runs\/\$\{encodeURIComponent\(runId\)\}/);
  assert.match(logs, /智能体/);
  assert.match(logs, /大模型/);
  assert.match(logs, /nodeRuns/);
  assert.match(icons, /export function CopyOutputIcon/);
  assert.match(icons, /export function TraceLogIcon/);
});

test("agent answers persist their workflow run metadata for later trace inspection", () => {
  assert.match(page, /agentId: selectedAgentId, runId: completed\.id, durationMs: completed\.durationMs, status: completed\.status/);
});
