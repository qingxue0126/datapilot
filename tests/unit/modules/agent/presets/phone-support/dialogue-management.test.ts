import assert from "node:assert/strict";
import test from "node:test";
import { DialoguePolicy } from "../../../../../../server/modules/agent/presets/phone-support/dialogue-policy.js";
import { DialogueStateTracker, restoreDialogueState } from "../../../../../../server/modules/agent/presets/phone-support/dialogue-state-tracker.js";
import type { ContextDependency, DialogueUnderstandingResult } from "../../../../../../server/modules/agent/presets/phone-support/dialogue-understanding.js";
import { QueryRewriter } from "../../../../../../server/modules/agent/presets/phone-support/query-rewriter.js";

const tracker = new DialogueStateTracker();
const rewriter = new QueryRewriter();
const policy = new DialoguePolicy();

test("first-turn complete business questions are retrieved verbatim", () => {
  const understanding = understood("query", "start", "这个月的报表不对", "independent", { entities: ["报表"], timeExpressions: ["这个月"], symptoms: ["不对"], negations: ["不对"] });
  const tracked = tracker.update(undefined, understanding, "这个月的报表不对", { companyName: "企通", product: "U8" });
  const rewrite = rewriter.rewrite("这个月的报表不对", understanding, tracked.state, tracked.transition);
  assert.equal(rewrite.query, "这个月的报表不对");
  assert.equal(rewrite.mode, "direct");
  assert.doesNotMatch(rewrite.query, /如何.*异常/);
});

test("missing product retains the original question and retrieves it after slot completion", () => {
  const business = understood("query", "start", "订单可以按行关闭吗？", "independent", { action: "关闭", entities: ["订单"], conditions: ["按行关闭"] });
  const first = tracker.update(undefined, business, "订单可以按行关闭吗？", { companyName: "企通" });
  tracker.applyWaiting(first.state, "product");
  const slot = understood("clarify", "continue", first.state.currentTopic || null, "dependent");
  const second = tracker.update(first.state, slot, "U8");
  const rewrite = rewriter.rewrite("U8", slot, second.state, second.transition);
  assert.equal(rewrite.query, "订单可以按行关闭吗？");
  assert.equal(rewrite.reason, "resume_original_after_product");
  assert.equal(second.state.topics[0].originalQuery, "订单可以按行关闭吗？");
});

test("context-only rewriting resolves the entity without leaking the previous operation", () => {
  const firstUnderstanding = understood("consult", "start", "账套怎么备份", "independent", { action: "备份", entities: ["账套"] });
  const first = tracker.update(undefined, firstUnderstanding, "账套怎么备份", { companyName: "企通", product: "U8" });
  const follow = understood("delete", "switch", "账套怎么删除呢？", "dependent", { action: "删除", entities: ["账套"] });
  const second = tracker.update(first.state, follow, "那怎么删除呢？");
  const rewrite = rewriter.rewrite("那怎么删除呢？", follow, second.state, second.transition);
  assert.equal(rewrite.query, "账套怎么删除呢？");
  assert.equal(rewrite.mode, "contextual");
  assert.doesNotMatch(rewrite.query, /备份/);
});

test("state tracker supports A to B to A and preserves isolated topic frames", () => {
  const a = understood("create", "start", "如何新增部门？", "independent", { action: "新增", entities: ["部门"] });
  const first = tracker.update(undefined, a, "如何新增部门？", { companyName: "企通", product: "U8" });
  const b = understood("query", "switch", "会计科目怎么查询？", "independent", { action: "查询", entities: ["会计科目"], conditions: ["按编码筛选"] });
  const second = tracker.update(first.state, b, "会计科目怎么查询？");
  const resume = understood("consult", "resume", "如何新增部门？", "dependent", { entities: ["部门"] });
  const resumed = tracker.update(second.state, resume, "回到刚才的部门问题");
  assert.equal(resumed.state.currentTopic, "如何新增部门？");
  assert.equal(resumed.state.topics[0].slots.action, "新增");
  assert.equal(resumed.state.topics[1].slots.action, "查询");
  assert.equal(restoreDialogueState(JSON.parse(JSON.stringify(resumed.state)))?.currentTopic, "如何新增部门？");
});

test("policy clarifies ambiguity before asking slots and never retrieves acknowledgements", () => {
  const ambiguous = understood("clarify", "clarify", null, "ambiguous", {}, true);
  const tracked = tracker.update(undefined, ambiguous, "怎么弄？");
  const rewrite = rewriter.rewrite("怎么弄？", ambiguous, tracked.state, tracked.transition);
  assert.equal(policy.decide(ambiguous, tracked.state, rewrite, tracked.transition).action, "clarify");

  const confirm = understood("confirm", "continue", "账套怎么备份", "dependent");
  const state = tracker.update(undefined, understood("consult", "start", "账套怎么备份", "independent", { action: "备份", entities: ["账套"] }), "账套怎么备份", { companyName: "企通", product: "U8" });
  const confirmed = tracker.update(state.state, confirm, "好的");
  const confirmRewrite = rewriter.rewrite("好的", confirm, confirmed.state, confirmed.transition);
  assert.equal(policy.decide(confirm, confirmed.state, confirmRewrite, confirmed.transition).action, "respond");
});

function understood(
  intent: DialogueUnderstandingResult["intent"], topicAction: DialogueUnderstandingResult["topicAction"], targetTopic: string | null,
  contextDependency: ContextDependency, frame: Partial<DialogueUnderstandingResult["semanticFrame"]> = {}, needsClarification = false,
): DialogueUnderstandingResult {
  return {
    intent, topicAction, targetTopic, resolvedReferences: [], confidence: needsClarification ? 0.3 : 0.98, needsClarification, contextDependency,
    semanticFrame: { action: null, entities: [], timeExpressions: [], conditions: [], symptoms: [], negations: [], ...frame },
  };
}
