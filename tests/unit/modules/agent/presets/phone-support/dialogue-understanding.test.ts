import assert from "node:assert/strict";
import test from "node:test";
import { DialogueUnderstanding } from "../../../../../../server/modules/agent/presets/phone-support/dialogue-understanding.js";
import type { RequestContext } from "../../../../../../server/shared/types/context.js";

const context: RequestContext = { tenantId: "t1", accountSetId: "a1", userId: "u1", role: "tenant_admin", sessionId: "s1" };
const turns = [{ question: "账套怎么备份？", answer: "可以进入系统管理备份。" }];
const topics = [{ topic: "账套怎么备份？", originalQuery: "账套怎么备份？", resolvedQuery: "账套怎么备份？", turn: 1 }];

function output(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    intent: "consult", topicAction: "start", targetTopic: "这个月的报表不对", resolvedReferences: [], confidence: 0.96,
    needsClarification: false, contextDependency: "independent",
    semanticFrame: { action: null, entities: ["报表"], timeExpressions: ["这个月"], conditions: [], symptoms: ["不对"], negations: ["不对"] },
    ...overrides,
  });
}
function fakeModels(content: string | Error) {
  const calls: { options: Record<string, unknown> }[] = [];
  return {
    calls,
    models: {
      text: async (_messages: unknown, options: Record<string, unknown>) => {
        calls.push({ options });
        if (content instanceof Error) throw content;
        (options.onUsage as ((usage: unknown, latency: number, model: string) => void) | undefined)?.({ promptTokens: 80, completionTokens: 25, totalTokens: 105 }, 12, "managed-model");
        return content;
      },
      list: () => { throw new Error("must not list models"); },
      create: () => { throw new Error("must not create models"); },
    },
  };
}

test("deterministic rules only handle clear control intents and pure chitchat", async () => {
  const { models, calls } = fakeModels(new Error("unused"));
  const understanding = new DialogueUnderstanding(models as never);
  for (const utterance of ["再见", "不用了，再见", "请转人工客服", "你好"]) {
    const response = await understanding.understand(context, { utterance, turns, priorTopics: topics });
    assert.equal(response.diagnostics.source, "rule");
  }
  assert.equal(calls.length, 0);
});

test("ambiguous acknowledgements use the preceding customer-service context", async () => {
  const { models, calls } = fakeModels(new Error("unused"));
  const understanding = new DialogueUnderstanding(models as never);
  const closing = await understanding.understand(context, { utterance: "不用了", turns: [{ question: "还有别的问题吗", answer: "请问还有其他问题需要了解吗？" }], priorTopics: topics });
  const slotReply = await understanding.understand(context, { utterance: "好的", turns: [{ question: "账套怎么备份", answer: "请问您使用哪款产品？" }], priorTopics: topics, waitingFor: "product" });
  assert.equal(closing.result.intent, "end");
  assert.equal(slotReply.result.intent, "confirm");
  assert.notEqual(slotReply.result.intent, "end");
  assert.equal(calls.length, 0);
});

test("business understanding uses the managed intent route and preserves the original issue", async () => {
  const { models, calls } = fakeModels(output());
  const response = await new DialogueUnderstanding(models as never).understand(context, { utterance: "这个月的报表不对", turns: [] });
  assert.equal(response.result.targetTopic, "这个月的报表不对");
  assert.equal(response.result.contextDependency, "independent");
  assert.deepEqual(response.result.semanticFrame.timeExpressions, ["这个月"]);
  assert.equal(response.diagnostics.model, "managed-model");
  assert.deepEqual(response.diagnostics.usage, { promptTokens: 80, completionTokens: 25, totalTokens: 105 });
  assert.equal(calls[0].options.task, "intent");
  assert.equal(calls[0].options.disableThinking, true);
  const failover = calls[0].options.failover as Record<string, unknown>;
  assert.equal(failover.totalTimeoutMs, 5000);
  assert.equal(failover.attemptTimeoutMs, 1500);
  assert.equal(failover.overrideRouteTimeout, true);
  assert.equal(failover.maxAttemptsPerModel, 1);
  assert.deepEqual(failover.noRetryStatusCodes, [402]);
  assert.equal(typeof failover.onAttempt, "function");
});

test("a grounded dependent follow-up may resolve to the active entity", async () => {
  const dependent = output({
    intent: "delete", topicAction: "switch", targetTopic: "账套怎么删除呢？", contextDependency: "dependent",
    semanticFrame: { action: "删除", entities: ["账套"], timeExpressions: [], conditions: [], symptoms: [], negations: [] },
    resolvedReferences: [{ expression: "那", resolvedTo: "账套怎么备份？", sourceTurn: 1 }],
  });
  const { models } = fakeModels(dependent);
  const response = await new DialogueUnderstanding(models as never).understand(context, { utterance: "那怎么删除呢？", turns, priorTopics: topics });
  assert.equal(response.result.targetTopic, "账套怎么删除呢？");
  assert.equal(response.result.contextDependency, "dependent");
  assert.equal(response.result.resolvedReferences[0].resolvedTo, "账套怎么备份？");
});

test("structural rules resolve topic resume, action ellipsis, and ambiguous references without an LLM", async () => {
  const { models, calls } = fakeModels(new Error("unused"));
  const understanding = new DialogueUnderstanding(models as never);
  const multiple = [topics[0], { topic: "怎么查询会计科目？", originalQuery: "怎么查询会计科目？", resolvedQuery: "怎么查询会计科目？", turn: 4 }];

  const resumed = await understanding.understand(context, { utterance: "刚才提到的账套备份怎么具体操作？", turns, priorTopics: multiple });
  assert.equal(resumed.result.topicAction, "resume");
  assert.equal(resumed.result.targetTopic, "账套怎么备份？");

  const ambiguous = await understanding.understand(context, { utterance: "那个怎么修改？", turns, priorTopics: multiple });
  assert.equal(ambiguous.result.intent, "clarify");
  assert.equal(ambiguous.result.needsClarification, true);

  const actionChange = await understanding.understand(context, { utterance: "那么怎么删除呢？", turns, priorTopics: topics });
  assert.equal(actionChange.result.intent, "delete");
  assert.match(actionChange.result.targetTopic || "", /账套.*删除/);
  assert.equal(calls.length, 0);
});

test("invalid references and model failures degrade without guessing", async () => {
  const invalid = output({ topicAction: "resume", contextDependency: "dependent", targetTopic: "不存在的话题", resolvedReferences: [{ expression: "那个", resolvedTo: "不存在的话题", sourceTurn: 1 }] });
  const first = await new DialogueUnderstanding(fakeModels(invalid).models as never).understand(context, { utterance: "那个呢？", turns, priorTopics: topics });
  assert.equal(first.result.needsClarification, true);
  assert.equal(first.diagnostics.source, "safe_fallback");

  const failure = await new DialogueUnderstanding(fakeModels(new Error("Bearer secret upstream failed")).models as never).understand(context, { utterance: "怎么弄？", turns, priorTopics: topics });
  assert.equal(failure.result.intent, "clarify");
  assert.equal(failure.result.needsClarification, true);
  assert.doesNotMatch(failure.diagnostics.degradationReason || "", /Bearer secret/);
});
