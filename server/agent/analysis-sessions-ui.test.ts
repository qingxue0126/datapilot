import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
const recent = readFileSync(new URL("../../components/datapilot/recent-analyses.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

test("new analysis creates a persistent server session", () => {
  assert.match(page, /apiFetch\("\/api\/sessions"[\s\S]*method: "POST"/);
  assert.match(page, /<span>智能问答<\/span>/);
  assert.match(page, /<h2>今天想了解什么？<\/h2>/);
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

test("refresh and login open a fresh smart Q&A landing without restoring the latest conversation", () => {
  assert.match(page, /async function restoreAnalyses\(\)[\s\S]*setAnalysisSessions\(items\);[\s\S]*setActiveSessionId\(""\); setMessages\(\[\]\); setQuestion\(""\); setResult\(null\); setError\(""\); setView\("chat"\)/);
  assert.doesNotMatch(page, /if \(items\[0\]\) await openAnalysis\(items\[0\]/);
  assert.doesNotMatch(page, /if \(!session && !result\) return/);
  assert.match(page, /async function ensureAnalysisSession\(\)[\s\S]*if \(activeSessionId\) return activeSessionId;[\s\S]*createAnalysis\(false\)/);
  assert.match(page, /if \(resetConversation\) \{ setMessages\(\[\]\); setQuestion\(""\); \}/);
});

test("empty new sessions stay out of the recent list until the first exchange is saved", () => {
  assert.match(recent, /!session\.pinned && session\.messageCount > 0/);
});

test("query requests carry the selected session id and render a message stream", () => {
  assert.match(page, /JSON\.stringify\(\{ sessionId, question: query, connectionId: activeSource\.connectionId, model: selectedModel, knowledgeBaseId:/);
  assert.match(page, /className="message-stream"/);
  assert.match(page, /item\.role === "user"/);
});

test("agent conversations are persisted and immediately added to recent analyses", () => {
  assert.match(page, /apiFetch\(`\/api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/exchanges`/);
  assert.match(page, /result: \{ channel: "agent", agentId: selectedAgentId \}/);
  assert.match(page, /setMessages\(\(items\) => \[\.\.\.items\.filter\(\(item\) => item\.id !== userMessage\.id && item\.id !== answerId\), \.\.\.persistedMessages\]\)/);
  assert.match(page, /setAnalysisSessions\(\(items\) => \[persistedSession, \.\.\.items\.filter\(\(item\) => item\.id !== persistedSession\.id\)\]\)/);
  assert.match(page, /metadata\?\.channel === "agent"[\s\S]*usableAgents\.some\(\(agent\) => agent\.id === savedAgentId\)[\s\S]*setChatTarget\("agent"\)/);
  assert.match(page, /isQueryResult\(item\.result\) \? <QueryResultCard/);
  assert.match(page, /typeof result\.summary === "string"[\s\S]*Array\.isArray\(result\.columns\)[\s\S]*Array\.isArray\(result\.rows\)/);
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
  assert.match(page, /items\.filter\(\(item\) => item\.id !== optimisticId && item\.id !== answerId\)/);
});

test("user messages render without an avatar", () => {
  assert.match(page, /<article className="user-message" key=\{item\.id\}><p>\{item\.content\}<\/p><\/article>/);
  assert.doesNotMatch(page, /className="user-message"[\s\S]{0,80}<span>你<\/span>/);
});

test("chat exposes model selection and model management navigation", () => {
  assert.match(page, />模型<select disabled=\{Boolean\(selectedAgentId\)\} value=\{showSelectedModel \? selectedModel : ""\}/);
  assert.match(page, />模型管理<\/button>/);
  assert.match(page, /<ModelManagement models=\{models\}/);
});

test("chat hides implicit defaults, uses the shared settings icon, and keeps message text sizes aligned", () => {
  assert.match(page, /showSelectedModel && selectedModel && <span>模型 ·/);
  assert.match(page, /showSelectedSource && activeSource && <span>数据源 ·/);
  assert.match(page, /value=\{showSelectedModel \? selectedModel : ""\}/);
  assert.match(page, /value=\{showSelectedSource \? activeSourceId : ""\}/);
  assert.match(page, /<SettingsGearIcon \/><span>配置<\/span>/);
  assert.match(styles, /\.user-message p \{[^}]*font-size: 16px;[^}]*line-height: 1\.55/);
  assert.match(styles, /\.assistant-message \{[^}]*font-size: 16px;[^}]*line-height: 1\.55/);
});

test("new conversation configuration opens below a vertically centered composer", () => {
  assert.match(styles, /\.analysis-workspace\.new-conversation \{[^}]*justify-content: center/);
  assert.match(styles, /\.analysis-workspace\.new-conversation \.chat-config-menu \{[^}]*top: calc\(100% \+ 9px\); bottom: auto/);
});
