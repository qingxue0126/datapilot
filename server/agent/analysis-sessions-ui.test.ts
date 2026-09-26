import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
const recent = readFileSync(new URL("../../components/datapilot/recent-analyses.tsx", import.meta.url), "utf8");

test("new analysis creates a persistent server session", () => {
  assert.match(page, /apiFetch\("\/api\/sessions"[\s\S]*method: "POST"/);
  assert.match(page, /＋ 新建分析/);
  assert.doesNotMatch(page, /＋ 新建对话/);
});

test("recent analyses can be opened, pinned, renamed, and deleted", () => {
  assert.match(page, /<RecentAnalyses[\s\S]*onOpen=[\s\S]*onPin=\{pinAnalysis\}[\s\S]*onRename=\{renameAnalysis\}[\s\S]*onDelete=\{deleteAnalysis\}/);
  assert.match(recent, /session\.pinned \? "取消置顶" : "置顶"/);
  assert.match(recent, /group\("置顶"/);
  assert.match(recent, /group\("最近"/);
  assert.match(recent, /分析标题/);
  assert.match(recent, />重命名</);
  assert.match(recent, />删除</);
});

test("query requests carry the selected session id and render a message stream", () => {
  assert.match(page, /JSON\.stringify\(\{ sessionId, question: query, connectionId: activeSource\.connectionId \}\)/);
  assert.match(page, /className="message-stream"/);
  assert.match(page, /item\.role === "user"/);
});
