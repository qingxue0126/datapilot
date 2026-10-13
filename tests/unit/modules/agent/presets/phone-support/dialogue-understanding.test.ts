import assert from "node:assert/strict";
import test from "node:test";
import { DIALOGUE_MODEL, DialogueUnderstanding } from "../../../../../../server/modules/agent/presets/phone-support/dialogue-understanding.js";
import type { RequestContext } from "../../../../../../server/shared/types/context.js";

const context: RequestContext = { tenantId: "t1", accountSetId: "a1", userId: "u1", role: "tenant_admin", sessionId: "s1" };
const turns = [
  { question: "怎么新增部门？", answer: "可以进入部门档案新增。" },
  { question: "那怎么删除科目？", answer: "请先确认科目是否使用。" },
];
const topics = [{ topic: "新增部门", turn: 1 }, { topic: "删除科目", turn: 2 }];

function fakeModels(content: string | Error) {
  const calls: { modelId?: string; options?: Record<string, unknown> }[] = [];
  const models = {
    list: () => [{ id: "flash-id", enabled: true, modelId: DIALOGUE_MODEL }],
    create: () => { throw new Error("must not create"); },
    chat: async (_context: RequestContext, modelId: string, _messages: unknown, options: Record<string, unknown>) => {
      calls.push({ modelId, options });
      if (content instanceof Error) throw content;
      return { content, latencyMs: 12, usage: { promptTokens: 80, completionTokens: 25, totalTokens: 105 } };
    },
  };
  return { models, calls };
}

test("rule fast path handles closing intent without calling a model", async () => {
  const { models, calls } = fakeModels(new Error("unused"));
  const response = await new DialogueUnderstanding(models as never).understand(context, { utterance: "再见", turns, priorTopics: topics });
  assert.deepEqual(response.result, {
    intent: "end", topicAction: "end", targetTopic: "删除科目", resolvedReferences: [], confidence: 0.99, needsClarification: false,
  });
  assert.equal(response.diagnostics.source, "rule");
  assert.equal(calls.length, 0);
});

test(`uses only ${DIALOGUE_MODEL} and validates a grounded A to B to A result`, async () => {
  const output = JSON.stringify({
    intent: "consult", topicAction: "resume", targetTopic: "新增部门",
    resolvedReferences: [{ expression: "刚才的部门问题", resolvedTo: "新增部门", sourceTurn: 1 }],
    confidence: 0.93, needsClarification: false,
  });
  const { models, calls } = fakeModels(output);
  const response = await new DialogueUnderstanding(models as never).understand(context, { utterance: "回到刚才的部门问题，还有限制吗？", turns, priorTopics: topics });
  assert.equal(response.result.topicAction, "resume");
  assert.equal(response.result.resolvedReferences[0].sourceTurn, 1);
  assert.equal(response.diagnostics.source, "llm");
  assert.deepEqual(response.diagnostics.usage, { promptTokens: 80, completionTokens: 25, totalTokens: 105 });
  assert.equal(calls[0].modelId, "flash-id");
  assert.equal(calls[0].options?.structured, true);
  assert.equal(calls[0].options?.disableThinking, true);
});

test("ordinal reference is resolved by rules only when the candidate exists", async () => {
  const { models, calls } = fakeModels(new Error("unused"));
  const found = await new DialogueUnderstanding(models as never).understand(context, { utterance: "第二个再解释一下", turns, priorTopics: topics });
  assert.equal(found.result.targetTopic, "删除科目");
  assert.equal(found.result.topicAction, "continue");
  assert.deepEqual(found.result.resolvedReferences, [{ expression: "第二个", resolvedTo: "删除科目", sourceTurn: 2 }]);
  const missing = await new DialogueUnderstanding(models as never).understand(context, { utterance: "第三个怎么处理", turns, priorTopics: topics });
  assert.equal(missing.result.needsClarification, true);
  assert.equal(missing.result.targetTopic, null);
  assert.equal(calls.length, 0);
});

test("stabilizes known multi-turn bad cases before provider-specific interpretation", async () => {
  const { models, calls } = fakeModels(new Error("unused"));
  const understanding = new DialogueUnderstanding(models as never);
  const cases = [
    { utterance: "具体怎么做？", expected: { intent: "consult", topicAction: "continue", targetTopic: "删除科目", needsClarification: false } },
    { utterance: "我的意思是新增下级部门", expected: { intent: "clarify", topicAction: "continue", targetTopic: "删除科目", needsClarification: false } },
    { utterance: "如果已经有同名部门呢？", expected: { intent: "consult", topicAction: "continue", targetTopic: "删除科目", needsClarification: false } },
    { utterance: "怎么删除会计科目？", expected: { intent: "delete", topicAction: "switch", targetTopic: "删除会计科目", needsClarification: false } },
    { utterance: "同时还要新增客户档案", expected: { intent: "create", topicAction: "switch", targetTopic: "新增客户档案", needsClarification: false } },
    { utterance: "部门问题先到这里，接着问科目查询", expected: { intent: "query", topicAction: "switch", targetTopic: "科目查询", needsClarification: false } },
    { utterance: "还要按制单人筛选", expected: { intent: "query", topicAction: "continue", targetTopic: "删除科目", needsClarification: false } },
    { utterance: "不是删除，是作废凭证", expected: { intent: "correct", topicAction: "continue", targetTopic: "作废凭证", needsClarification: false } },
    { utterance: "那个怎么修改？", expected: { intent: "update", topicAction: "clarify", targetTopic: null, needsClarification: true } },
    { utterance: "怎么弄？", expected: { intent: "consult", topicAction: "clarify", targetTopic: null, needsClarification: true } },
    { utterance: "不要删除，但请删除它", expected: { intent: "clarify", topicAction: "clarify", targetTopic: null, needsClarification: true } },
  ];
  for (const item of cases) {
    const response = await understanding.understand(context, { utterance: item.utterance, turns, priorTopics: topics });
    assert.deepEqual(response.result, { ...item.expected, resolvedReferences: [], confidence: response.result.confidence });
    assert.equal(response.diagnostics.source, "rule");
  }
  assert.equal(calls.length, 0);
});

test("normalizes department permission follow-ups to a stable extended topic", async () => {
  const { models, calls } = fakeModels(new Error("unused"));
  const response = await new DialogueUnderstanding(models as never).understand(context, {
    utterance: "新增后怎么分配权限？",
    turns: [turns[0]],
    priorTopics: [{ topic: "新增部门", turn: 1 }],
  });
  assert.deepEqual(response.result, {
    intent: "consult", topicAction: "extend", targetTopic: "部门权限", resolvedReferences: [], confidence: 0.98, needsClarification: false,
  });
  assert.equal(response.diagnostics.source, "rule");
  assert.equal(calls.length, 0);
});

test("model failure is observable and ambiguous references are not guessed", async () => {
  const { models } = fakeModels(new Error("模型请求失败（402）：Insufficient Balance; Bearer secret"));
  const response = await new DialogueUnderstanding(models as never).understand(context, { utterance: "那个怎么改？", turns, priorTopics: topics });
  assert.equal(response.diagnostics.source, "safe_fallback");
  assert.match(response.diagnostics.degradationReason || "", /402.*Insufficient Balance/);
  assert.doesNotMatch(response.diagnostics.degradationReason || "", /Bearer secret/);
  assert.equal(response.result.needsClarification, true);
  assert.equal(response.result.resolvedReferences.length, 0);
});

test("rejects an ungrounded LLM reference and safely degrades", async () => {
  const { models } = fakeModels(JSON.stringify({
    intent: "consult", topicAction: "resume", targetTopic: "不存在的话题",
    resolvedReferences: [{ expression: "那个", resolvedTo: "不存在的话题", sourceTurn: 1 }],
    confidence: 0.99, needsClarification: false,
  }));
  const response = await new DialogueUnderstanding(models as never).understand(context, { utterance: "那个呢？", turns, priorTopics: topics });
  assert.equal(response.diagnostics.source, "safe_fallback");
  assert.equal(response.result.needsClarification, true);
  assert.equal(response.result.resolvedReferences.length, 0);
});

test("a vague first-turn ellipsis requests clarification instead of inventing a topic", async () => {
  const { models } = fakeModels(new Error("model unavailable"));
  const response = await new DialogueUnderstanding(models as never).understand(context, { utterance: "怎么弄？", turns: [] });
  assert.equal(response.result.topicAction, "clarify");
  assert.equal(response.result.targetTopic, null);
  assert.equal(response.result.needsClarification, true);
});
