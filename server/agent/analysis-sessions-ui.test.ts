import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
const recent = readFileSync(new URL("../../components/datapilot/recent-analyses.tsx", import.meta.url), "utf8");

test("new analysis creates a persistent server session", () => {
  assert.match(page, /apiFetch\("\/api\/sessions"[\s\S]*method: "POST"/);
  assert.match(page, /＋ 智能问答/);
  assert.doesNotMatch(page, /＋ 新建分析|＋ 新建对话/);
});

test("recent analyses can be opened, pinned, renamed, and deleted", () => {
  assert.match(page, /<RecentAnalyses[\s\S]*onOpen=[\s\S]*onPin=\{pinAnalysis\}[\s\S]*onRename=\{renameAnalysis\}[\s\S]*onDelete=\{async \(session\) => setPendingSessionDelete\(session\)\}/);
  assert.match(page, /<ConfirmDialog title="删除分析"[\s\S]*await deleteAnalysis\(session\)/);
  assert.match(recent, /session\.pinned \? "取消置顶" : "置顶"/);
  assert.match(recent, /group\("置顶"/);
  assert.match(recent, /group\("最近"/);
  assert.match(recent, /分析标题/);
  assert.match(recent, />重命名</);
  assert.match(recent, />删除</);
});

test("empty new sessions stay out of the recent list until the first exchange is saved", () => {
  assert.match(recent, /!session\.pinned && session\.messageCount > 0/);
});

test("query requests carry the selected session id and render a message stream", () => {
  assert.match(page, /JSON\.stringify\(\{ sessionId, question: query, connectionId: activeSource\.connectionId, model: selectedModel, knowledgeBaseId:/);
  assert.match(page, /className="message-stream"/);
  assert.match(page, /item\.role === "user"/);
});

test("the composer moves below the message stream after a conversation starts", () => {
  assert.match(page, /const hasConversation = messages\.length > 0/);
  assert.match(page, /<section className="message-stream"[\s\S]*\{hasConversation && <div className="conversation-composer">\{composer\}<\/div>\}/);
  assert.match(page, /!hasConversation && composer/);
});

test("the global top bar stays removed and conversation mode hides the landing hero", () => {
  assert.match(page, /const chatHasConversation = view === "chat" && messages\.length > 0/);
  assert.doesNotMatch(page, /className="topbar"/);
  assert.match(page, /\{!hasConversation && <section className="hero-copy">/);
});

test("sending a question immediately enters conversation mode before the answer returns", () => {
  assert.match(page, /const optimisticMessage: AnalysisMessage \| undefined/);
  assert.match(page, /setMessages\(\(items\) => \[\.\.\.items, optimisticMessage\]\); setView\("chat"\)/);
  assert.match(page, /items\.filter\(\(item\) => item\.id !== optimisticMessage\?\.id\)/);
});

test("user messages render without an avatar", () => {
  assert.match(page, /<article className="user-message" key=\{item\.id\}><p>\{item\.content\}<\/p><\/article>/);
  assert.doesNotMatch(page, /className="user-message"[\s\S]{0,80}<span>你<\/span>/);
});

test("chat exposes model selection and model management navigation", () => {
  assert.match(page, />模型<select disabled=\{Boolean\(selectedAgentId\)\} value=\{selectedModel\}/);
  assert.match(page, />模型管理<\/button>/);
  assert.match(page, /<ModelManagement models=\{models\}/);
});
