import assert from "node:assert/strict";
import test from "node:test";
import { DialoguePolicy } from "../../../../../../server/modules/agent/presets/phone-support/dialogue-policy.js";
import { DialogueStateTracker, restoreDialogueState } from "../../../../../../server/modules/agent/presets/phone-support/dialogue-state-tracker.js";
import type { DialogueUnderstandingResult } from "../../../../../../server/modules/agent/presets/phone-support/dialogue-understanding.js";
import { QueryRewriter } from "../../../../../../server/modules/agent/presets/phone-support/query-rewriter.js";

const tracker = new DialogueStateTracker();
const rewriter = new QueryRewriter();
const policy = new DialoguePolicy();

test("state tracker supports A to B to A with isolated per-topic slots", () => {
  const first = tracker.update(undefined, understood("create", "start", "新增部门"), "如何新增部门", { companyName: "企通", product: "U8" });
  const second = tracker.update(first.state, understood("query", "switch", "查询会计科目"), "那科目怎么查询？");
  second.state.topics.find((item) => item.topic === "查询会计科目")!.slots.qualifiers.push("按编码");
  const resumed = tracker.update(second.state, understood("consult", "resume", "新增部门"), "回到新增部门，具体怎么做？");

  assert.equal(resumed.state.currentTopic, "新增部门");
  assert.deepEqual(resumed.state.topicHistory, ["新增部门", "查询会计科目"]);
  assert.deepEqual(resumed.state.topics.find((item) => item.topic === "新增部门")?.slots.qualifiers, []);
  assert.deepEqual(resumed.state.topics.find((item) => item.topic === "查询会计科目")?.slots.qualifiers, ["按编码"]);
  assert.equal(restoreDialogueState(JSON.parse(JSON.stringify(resumed.state)))?.currentTopic, "新增部门");
});

test("query rewriter switches to the new subject without leaking the old topic", () => {
  const first = tracker.update(undefined, understood("create", "start", "新增部门"), "如何新增部门", { companyName: "企通", product: "U8" });
  const second = tracker.update(first.state, understood("query", "switch", "查询会计科目"), "那科目怎么查询？");
  const rewrite = rewriter.rewrite("那科目怎么查询？", understood("query", "switch", "查询会计科目"), second.state, second.transition);

  assert.equal(rewrite.query, "U8软件如何查询会计科目？");
  assert.equal(rewrite.shouldRetrieve, true);
  assert.doesNotMatch(rewrite.query, /新增|部门/);
});

test("corrections override old product and topic values", () => {
  const first = tracker.update(undefined, understood("delete", "start", "删除凭证"), "如何删除凭证", { companyName: "企通", product: "U8" });
  const correctedProduct = tracker.update(first.state, understood("correct", "continue", "删除凭证"), "不是U8，改成T3");
  const correctedTopic = tracker.update(correctedProduct.state, understood("correct", "continue", "作废凭证"), "不是删除，是作废凭证");
  const rewrite = rewriter.rewrite("不是删除，是作废凭证", understood("correct", "continue", "作废凭证"), correctedTopic.state, correctedTopic.transition);

  assert.equal(correctedTopic.state.product, "T3");
  assert.equal(correctedTopic.state.currentTopic, "作废凭证");
  assert.equal(rewrite.query, "T3软件如何作废凭证？");
});

test("policy does not retrieve for product-only or ambiguous input", () => {
  const productOnly = tracker.update(undefined, understood("consult", "start", null), "U8", { product: "U8" });
  const productRewrite = rewriter.rewrite("U8", understood("consult", "start", null), productOnly.state, productOnly.transition);
  const productDecision = policy.decide(understood("consult", "start", null), productOnly.state, productRewrite, productOnly.transition);
  assert.equal(productDecision.action, "ask_company");
  tracker.applyWaiting(productOnly.state, "company");
  const afterCompany = tracker.update(productOnly.state, understood("clarify", "continue", null), "企通");
  const afterCompanyRewrite = rewriter.rewrite("企通", understood("clarify", "continue", null), afterCompany.state, afterCompany.transition);
  assert.equal(policy.decide(understood("clarify", "continue", null), afterCompany.state, afterCompanyRewrite, afterCompany.transition).action, "ask_query");

  const first = tracker.update(undefined, understood("create", "start", "新增部门"), "如何新增部门", { companyName: "企通", product: "U8" });
  const ambiguousUnderstanding = understood("update", "clarify", null, true);
  const ambiguous = tracker.update(first.state, ambiguousUnderstanding, "那个怎么改？");
  const rewrite = rewriter.rewrite("那个怎么改？", ambiguousUnderstanding, ambiguous.state, ambiguous.transition);
  assert.equal(rewrite.shouldRetrieve, false);
  assert.equal(policy.decide(ambiguousUnderstanding, ambiguous.state, rewrite, ambiguous.transition).action, "clarify");
});

test("policy leaves the greeting to the preset opening message", () => {
  const state = tracker.empty();
  state.turn = 2;
  const understanding = understood("chitchat", "chitchat", null);
  const transition = { action: "chitchat" as const, slotUpdates: [], reason: "chitchat" };
  const decision = policy.decide(understanding, state, rewriter.rewrite("你好", understanding, state, transition), transition);

  assert.equal(decision.answer, "请问有什么企业软件问题可以帮您？");
  assert.doesNotMatch(decision.answer || "", /您好|你好/);
});

function understood(intent: DialogueUnderstandingResult["intent"], topicAction: DialogueUnderstandingResult["topicAction"], targetTopic: string | null, needsClarification = false): DialogueUnderstandingResult {
  return { intent, topicAction, targetTopic, resolvedReferences: [], confidence: needsClarification ? 0.3 : 0.98, needsClarification };
}
