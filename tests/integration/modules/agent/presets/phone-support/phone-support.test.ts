import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PhoneSupportHarness } from "../../../../../../server/modules/agent/presets/phone-support/phone-support.js";
import { SessionStoreError, SqliteSessionStore } from "../../../../../../server/modules/conversation/session-store.js";
import type { RequestContext } from "../../../../../../server/shared/types/context.js";
import type { ModelAttemptDiagnostic } from "../../../../../../server/modules/model/model-service.js";

const context: RequestContext = { tenantId: "t1", accountSetId: "a1", userId: "u1", role: "tenant_admin", sessionId: "s" };
function setup(items: { content: string; score: number; metadata?: Record<string, unknown> }[] = [{ content: "账套支持备份和删除，具体步骤是进入系统设置。", score: 0.9 }], options: { modelContent?: string; modelError?: Error; retrievalError?: Error; modelAttempts?: ModelAttemptDiagnostic[] } = {}) {
  const exchanges: { question: string; answer: string; result: Record<string, unknown> }[] = [];
  const requests: { knowledgeBaseId: string; query: string; filters?: unknown; retrievalMode?: string; rerank?: boolean; topK?: number }[] = [];
  const sessions = {
    create: () => ({ id: "phone-session", title: "", pinned: false, createdAt: "", updatedAt: "", messageCount: 0 }),
    get: () => ({ session: { id: "phone-session", title: "", pinned: false, createdAt: "", updatedAt: "", messageCount: exchanges.length * 2 }, messages: exchanges.map((item, index) => ({ id: `a${index}`, sessionId: "phone-session", role: "assistant" as const, content: item.answer, result: item.result, createdAt: "" })) }),
    history: () => exchanges.map((item) => ({ question: item.question, answer: item.answer, createdAt: 0 })),
    appendExchange: (_c: RequestContext, _id: string, input: typeof exchanges[number]) => { exchanges.push(input); return {} as never; },
  };
  const retrieval = { retrieve: async (_c: RequestContext, request: { knowledgeBaseId: string; query: string; filters?: unknown; retrievalMode?: string; rerank?: boolean; topK?: number }) => { requests.push(request); if (options.retrievalError) throw options.retrievalError; return { items: items.map((item, index) => ({ ...item, rank: index + 1, chunkId: `c${index}`, documentId: "d", filename: "faq", fileType: "md", chunkIndex: index, metadata: item.metadata || {} })), filters: {}, topK: 5, scoreThreshold: 0.25, rerank: false, retrievalMode: "hybrid" as const, vectorWeight: 0.7, candidateCount: 15, rerankModel: "", config: {} as never, vectorStore: "local" as never, query: request.query }; } };
  const modelCalls: { messages: { role: string; content: string }[]; options: Record<string, unknown> }[] = [];
  const models = { text: async (messages: { role: string; content: string }[], modelOptions: Record<string, unknown>) => {
    if (modelOptions.task === "intent") return intentResponse(messages);
    modelCalls.push({ messages, options: modelOptions });
    const onAttempt = (modelOptions.failover as { onAttempt?: (diagnostic: ModelAttemptDiagnostic) => void } | undefined)?.onAttempt;
    for (const diagnostic of options.modelAttempts || [{ role: "primary", modelId: "deepseek-v4-flash", attempt: 1, status: "succeeded", durationMs: 7 } satisfies ModelAttemptDiagnostic]) onAttempt?.(diagnostic);
    if (options.modelError) throw options.modelError;
    return options.modelContent || "可以的。您可以进入系统设置进行操作。";
  } };
  const workflows = {
    getPresetConfig: () => ({ knowledgeBaseId: "baec59c9-5b4d-4a10-84f4-4b896bfedcd1", productMetadataField: "适用产品" }),
    executionContext: (value: RequestContext) => value,
  };
  return { harness: new PhoneSupportHarness({ sessions: sessions as never, retrieval: retrieval as never, models: models as never, workflows: workflows as never }), exchanges, requests, modelCalls };
}

function intentResponse(messages: { role: string; content: string }[]) {
  const prompt = messages.at(-1)?.content || "";
  const utterance = prompt.match(/当前用户原话[：:]\n([\s\S]+)$/)?.[1]?.trim() || "";
  const topics = [...prompt.matchAll(/^\d+\. (.+?)；原始问题=/gm)].map((match) => match[1]);
  const current = topics.at(-1);
  let targetTopic = utterance;
  let topicAction: "start" | "continue" | "switch" | "resume" | "extend" = current ? "switch" : "start";
  let contextDependency: "independent" | "dependent" = "independent";
  if (/^(?:那|然后|接着).*(?:删除)/.test(utterance) && current) { targetTopic = `账套怎么删除呢？`; topicAction = "switch"; contextDependency = "dependent"; }
  else if (/具体|下一步|重新计算|注意事项/.test(utterance) && current) { targetTopic = current; topicAction = "continue"; contextDependency = "dependent"; }
  const action = targetTopic.match(/新增|增加|删除|作废|修改|查询|备份|恢复|导入|导出|生成|结账|关账|关闭/)?.[0] || null;
  const entities = ["账套", "部门", "科目", "订单", "发票", "凭证", "报表", "客户", "供应商", "操作员", "操作人员", "用户"].filter((item) => targetTopic.includes(item));
  const symptoms = targetTopic.match(/(?:报错|错误|异常|不对|失败|未设置)[^，。！？!?]{0,20}|\b\d{2,}\b/g) || [];
  const conditions = targetTopic.match(/按行|按[^，。！？!?]{1,12}(?:筛选|查询|关闭)/g) || [];
  return JSON.stringify({ intent: /删除/.test(targetTopic) ? "delete" : /新增|增加/.test(targetTopic) ? "create" : /查询/.test(targetTopic) ? "query" : /不对|报错|异常|失败/.test(targetTopic) ? "troubleshoot" : "consult", topicAction, targetTopic, resolvedReferences: [], confidence: 0.98, needsClarification: false, contextDependency, semanticFrame: { action, entities, timeExpressions: targetTopic.match(/这个月|本月|今天|今年/g) || [], conditions, symptoms, negations: targetTopic.match(/没有|不能|不对|不是|未[^，。！？!?]*/g) || [] } });
}

test("phone support preserves slots and rewrites follow-up questions", async () => {
  const { harness, exchanges } = setup();
  const first = await harness.run(context, { query: "账套怎么备份", companyName: "甲公司", product: "财务系统" });
  const second = await harness.run(context, { query: "那怎么删除呢", sessionId: first.sessionId, companyName: "甲公司", product: "财务系统" });
  assert.equal(second.state, "answering", JSON.stringify(second, null, 2));
  assert.equal(second.rewrittenQuery, "账套怎么删除呢？");
  assert.doesNotMatch(second.rewrittenQuery, /备份/);
  assert.equal(exchanges.length, 2);
});

test("PDF bad cases route to the matching, grounded knowledge entry", async () => {
  const cases: { query: string; product: string; sourceQuestion?: string; source: string }[] = [
    { query: "账套可以删除吗", product: "T3", source: "删除当前输出账套" },
    { query: "我这台是新的电脑，没有报表模板，可以给我发一份吗", product: "U8", source: "复制到新电脑上" },
    { query: "易代账的发票怎么自动生成凭证", product: "易代账", source: "税务数字账户" },
    { query: "怎么增加一个用户", product: "T3", sourceQuestion: "怎么新增一个操作人员", source: "录入，编号、姓名、密码" },
    { query: "怎么增加操作员", product: "T3", sourceQuestion: "怎么新增一个操作人员", source: "录入，编号、姓名、密码" },
    { query: "怎么在系统里新增一个公司", product: "好会计", sourceQuestion: "怎么新增账套", source: "输入公司名称" },
    { query: "怎么关账", product: "T+", source: "财务结账" },
  ] as const;

  for (const item of cases) {
    const content = `问题描述：${item.sourceQuestion || item.query}\n解决方案：${item.source}`;
    const result = await setup([{ content, score: 0.99 }], { modelError: new Error("use grounded fallback") }).harness.run(context, {
      query: item.query, companyName: "上海企通", product: item.product,
    });
    assert.equal(result.state, "answering", `${item.query}: ${JSON.stringify(result)}`);
    assert.equal(result.currentTopic, item.query, item.query);
    assert.equal(result.rewrittenQuery, item.query, item.query);
    assert.ok(result.sources.length > 0, item.query);
    assert.ok(result.answer.includes(item.source), item.query);
  }
});

test("PDF bad cases transfer safely when the knowledge base has no matching answer", async () => {
  for (const query of ["重新计算了，数据还是不对", "可以给我发一份最新的报表模板吗"]) {
    const { harness } = setup([], { modelError: new Error("not used") });
    const first = await harness.run(context, { query: "这个月的报表不对，需要处理", companyName: "上海企通", product: "U8" });
    const result = await harness.run(context, {
      query, sessionId: first.sessionId, companyName: "上海企通", product: "U8",
    });
    assert.equal(result.state, "transferring", `${query}: ${JSON.stringify(result)}`);
    assert.equal(result.sources.length, 0, query);
  }
});

test("phone support asks for missing slots and transfers when knowledge has no answer", async () => {
  const missing = await setup().harness.run(context, { query: "如何新增部门", product: "财务系统" });
  assert.equal(missing.state, "collecting");
  assert.match(missing.answer, /贵公司的名称/);
  const noEvidence = setup([]);
  const noAnswer = await noEvidence.harness.run(context, { query: "如何新增部门", companyName: "甲公司", product: "财务系统" });
  assert.equal(noAnswer.state, "transferring");
  assert.equal(noEvidence.modelCalls.length, 0);
});

test("phone support rejects retrieval hits without a topic anchor", async () => {
  const result = await setup([{ content: "问题描述：如何新增部门\n解决方案：进入基础档案新增部门。", score: 0.99 }]).harness.run(context, {
    query: "怎么启用火星税控舱？", companyName: "企通", product: "U8",
  });
  assert.equal(result.state, "transferring");
  assert.equal(result.sources.length, 0);
  assert.doesNotMatch(result.answer, /基础档案|新增部门/);
});

test("report anomalies never use a report-export hit just because the entity matches", async () => {
  const result = await setup([{ content: "问题描述：如何导出报表到 Excel\n解决方案：进入报表中心，点击导出 Excel。", score: 0.99 }]).harness.run(context, {
    query: "这个月的报表不对", companyName: "企通", product: "U8",
  });
  assert.equal(result.state, "transferring");
  assert.equal(result.policy.reason, "evidence_mismatch");
  assert.doesNotMatch(result.answer, /导出|Excel/);
});

test("time-scoped report anomalies reject evidence for a conflicting period", async () => {
  const result = await setup([{ content: "问题描述：上个月的报表不对\n解决方案：重新计算上个月的报表。", score: 0.99 }]).harness.run(context, {
    query: "这个月的报表不对", companyName: "企通", product: "U8",
  });
  assert.equal(result.state, "transferring");
  const validation = JSON.parse(result.trace.find((item) => item.step === "knowledge.validate")?.detail || "{}");
  assert.equal(validation.candidates[0].checks.timeExpressions, false);
});

test("negated entities and operations are excluded while the corrected target stays required", async () => {
  const customer = await setup([{ content: "问题描述：如何新增客户档案\n解决方案：进入基础档案，新增客户并保存。", score: 0.99 }], { modelError: new Error("use fallback") }).harness.run(context, {
    query: "我要新增客户档案，不是部门", companyName: "企通", product: "T3",
  });
  assert.equal(customer.state, "answering", JSON.stringify(customer, null, 2));
  assert.doesNotMatch(customer.answer, /新增部门/);

  const voucher = await setup([{ content: "问题描述：如何作废凭证\n解决方案：选择未记账凭证，点击作废。", score: 0.99 }], { modelError: new Error("use fallback") }).harness.run(context, {
    query: "不是删除，是作废凭证", companyName: "企通", product: "U8",
  });
  assert.equal(voucher.state, "answering", JSON.stringify(voucher, null, 2));
  assert.match(voucher.answer, /作废/);
});

test("disabled answer validation accepts the model answer without replacing omitted content", async () => {
  const source = "问题描述：如何删除账套\n解决方案：进入系统管理选择账套后删除。删除前必须先备份，删除后无法恢复。";
  const result = await setup([{ content: source, score: 0.99 }], { modelContent: "进入系统管理，选择账套后删除即可。" }).harness.run(context, {
    query: "账套怎么删除", companyName: "企通", product: "T3",
  });
  assert.equal(result.state, "answering");
  assert.equal(result.answer, "进入系统管理，选择账套后删除即可。");
  const detail = JSON.parse(result.trace.find((item) => item.step === "answer.generate")?.detail || "{}");
  assert.equal(detail.answerValidation, "disabled");
  assert.equal(detail.usedDeterministicFallback, false);
  assert.equal(result.trace.some((item) => item.step === "answer.validate"), false);
});

test("knowledge retrieval failures degrade to transfer and remain observable", async () => {
  const result = await setup([], { retrievalError: new Error("vector store unavailable") }).harness.run(context, {
    query: "账套怎么备份", companyName: "企通", product: "U8",
  });
  assert.equal(result.state, "transferring");
  assert.equal(result.policy.reason, "retrieval_failed");
  assert.equal(result.trace.find((item) => item.step === "knowledge.retrieve")?.status, "failed");
});

test("phone support replays workflow history so a company answer is not asked again", async () => {
  const { harness } = setup();
  const first = await harness.run(context, { query: "怎么返账" });
  const second = await harness.run(context, { query: "企通", __conversationHistory: [{ role: "user", content: "怎么返账" }, { role: "assistant", content: first.answer }] });
  assert.equal(second.state, "collecting");
  assert.match(second.answer, /产品/);
  assert.doesNotMatch(second.answer, /公司名称/);
});

test("phone support uses the desired slot prompts, rewrites KB content, and closes politely", async () => {
  const { harness } = setup(
    [{ content: "问题描述：报错：91未设置变量，如何处理\n解决方案：请删除 Cache 文件夹后重启电脑。", score: 0.9 }],
    { modelContent: "可以的。您先删除 Cache 文件夹，再重新启动电脑。" },
  );
  const first = await harness.run(context, { query: "91未设置变量怎么办？", companyName: "企通", product: "U8" });
  assert.equal(first.state, "answering");
  assert.match(first.answer, /删除 Cache 文件夹.*重新启动电脑/);
  assert.doesNotMatch(first.answer, /问题描述|解决方案|知识库|请按以下步骤操作/);
  const closing = await harness.run(context, { query: "好的", sessionId: first.sessionId, companyName: "企通", product: "U8" });
  assert.equal(closing.answer, "好的，如果还有其他问题，随时告诉我。");
});

test("phone support preserves KB wording when the answer model is unavailable", async () => {
  const { harness } = setup(
    [{ content: "问题描述：如何新增部门\n解决方案：请按以下步骤操作：基础档案-机构设置-部门档案，点击增加，录入部门编码和部门名称后保存", score: 0.9 }],
    { modelError: new Error("model unavailable") },
  );
  const result = await harness.run(context, { query: "想要新增一个部门", companyName: "企通", product: "T3" });
  assert.equal(result.state, "answering", JSON.stringify(result, null, 2));
  assert.equal(result.answer, "请按以下步骤操作：基础档案-机构设置-部门档案，点击增加，录入部门编码和部门名称后保存");
  assert.equal(result.trace.find((item) => item.step === "answer.generate")?.status, "failed");
  assert.doesNotMatch(result.answer, /问题描述|解决方案/);
});

test("phone support records primary 402 and uses the successful fallback model", async () => {
  const attempts: ModelAttemptDiagnostic[] = [
    { role: "primary", modelId: "deepseek-v4-flash", attempt: 1, status: "failed", statusCode: 402, durationMs: 11, error: "Insufficient Balance" },
    { role: "fallback", modelId: "qwen3.8-flash", attempt: 1, status: "succeeded", durationMs: 18 },
  ];
  const result = await setup(
    [{ content: "问题描述：如何新增部门\n解决方案：进入基础档案，点击新增部门并保存。", score: 0.99 }],
    { modelContent: "进入基础档案，点击新增部门并保存。", modelAttempts: attempts },
  ).harness.run(context, { query: "如何新增部门", companyName: "企通", product: "T3" });
  const detail = JSON.parse(result.trace.find((item) => item.step === "answer.generate")?.detail || "{}");
  assert.equal(result.answer, "进入基础档案，点击新增部门并保存。");
  assert.equal(detail.model, "qwen3.8-flash");
  assert.deepEqual(detail.attempts.map((item: ModelAttemptDiagnostic) => [item.role, item.statusCode, item.durationMs]), [["primary", 402, 11], ["fallback", undefined, 18]]);
});

test("phone support uses the verbatim KB answer after both models return 402", async () => {
  const attempts: ModelAttemptDiagnostic[] = [
    { role: "primary", modelId: "deepseek-v4-flash", attempt: 1, status: "failed", statusCode: 402, durationMs: 10, error: "Insufficient Balance" },
    { role: "fallback", modelId: "qwen3.8-flash", attempt: 1, status: "failed", statusCode: 402, durationMs: 13, error: "Insufficient Balance" },
  ];
  const source = "问题：如何新增部门\n答案：已在知识库中找到相关解决方案，接下来为您播报：进入基础档案。\n1. 点击新增；\n2. 录入部门编码并保存。\n注意：编码不能重复。";
  const result = await setup([{ content: source, score: 0.99 }], { modelError: new Error("模型请求失败（402）：Insufficient Balance"), modelAttempts: attempts })
    .harness.run(context, { query: "如何新增部门", companyName: "企通", product: "T3" });
  const detail = JSON.parse(result.trace.find((item) => item.step === "answer.generate")?.detail || "{}");
  assert.equal(result.answer, "已在知识库中找到相关解决方案，接下来为您播报：进入基础档案。\n1. 点击新增；\n2. 录入部门编码并保存。\n注意：编码不能重复。");
  assert.match(result.answer, /1\. 点击新增；[\s\S]*2\. 录入部门编码并保存。[\s\S]*注意：编码不能重复/);
  assert.equal(detail.degradationReason, "both_models_402");
  assert.equal(result.trace.find((item) => item.step === "answer.generate")?.status, "failed");
});

test("phone support records timeout failover and emits the validated fallback-model answer", async () => {
  const attempts: ModelAttemptDiagnostic[] = [
    { role: "primary", modelId: "deepseek-v4-flash", attempt: 1, status: "failed", durationMs: 6000, error: "模型请求超时（6000ms）" },
    { role: "fallback", modelId: "qwen3.8-flash", attempt: 1, status: "succeeded", durationMs: 20 },
  ];
  const result = await setup(
    [{ content: "问题：如何新增部门\n答案：进入基础档案，新增部门并保存。", score: 0.99 }],
    { modelContent: "进入基础档案，新增部门并保存。", modelAttempts: attempts },
  ).harness.run(context, { query: "如何新增部门", companyName: "企通", product: "T3" });
  const detail = JSON.parse(result.trace.find((item) => item.step === "answer.generate")?.detail || "{}");
  assert.equal(detail.attempts[0].error, "模型请求超时（6000ms）");
  assert.equal(detail.model, "qwen3.8-flash");
  assert.equal(result.answer, "进入基础档案，新增部门并保存。");
});

test("phone support grounds DeepSeek rewriting in only the best retrieval hit", async () => {
  const { harness, modelCalls } = setup([
    { content: "问题描述：需要增加会计科目，怎么操作\n解决方案：请按以下步骤操作：基础设置-科目期初进行增加就可以了", score: 0.95 },
    { content: "问题描述：会计科目可以删除吗\n解决方案：已经使用的科目只能停用。", score: 0.7 },
  ], { modelContent: "企通您好，增加会计科目的话，您进入基础设置，找到科目期初，在那里进行增加就可以了。" });
  const result = await harness.run(context, { query: "怎么加科目", companyName: "企通", product: "好会计" });
  assert.equal(result.answer, "增加会计科目的话，您进入基础设置，找到科目期初，在那里进行增加就可以了。");
  assert.equal(modelCalls[0].options.preferredModelId, undefined);
  assert.equal(modelCalls[0].options.temperature, 0);
  assert.equal(modelCalls[0].options.disableThinking, true);
  assert.equal(modelCalls[0].options.maxTokens, 1200);
  assert.equal((modelCalls[0].options.failover as { attemptTimeoutMs?: number }).attemptTimeoutMs, 1_500);
  assert.match(modelCalls[0].messages[0].content, /最大程度保留解决方案原文/);
  assert.match(modelCalls[0].messages[0].content, /若简洁与信息完整发生冲突，优先保证信息完整/);
  assert.doesNotMatch(modelCalls[0].messages[0].content, /不能原样朗读|一到两句话/);
  assert.match(modelCalls[0].messages[1].content, /基础设置-科目期初/);
  assert.doesNotMatch(modelCalls[0].messages[1].content, /只能停用/);
  const retrievalTrace = JSON.parse(result.trace.find((item) => item.step === "knowledge.retrieve")?.detail || "{}");
  assert.deepEqual(retrievalTrace.items, [
    { rank: 1, chunkId: "c0", question: "需要增加会计科目，怎么操作", score: 0.95, metadata: {} },
    { rank: 2, chunkId: "c1", question: "会计科目可以删除吗", score: 0.7, metadata: {} },
  ]);
});

test("disabled answer validation accepts an over-expanded model answer", async () => {
  const source = "问题描述：需要增加会计科目，怎么操作\n解决方案：请按以下步骤操作：基础设置-科目期初进行增加就可以了";
  const invented = "在好会计里增加会计科目，您依次进入基础设置和科目期初，选择增加就可以了。如果是给以前用过的科目增加下级科目，之前这个科目做的数据会自动转到第一个二级科目上，请您放心操作。";
  const result = await setup([{ content: source, score: 0.95 }], { modelContent: invented }).harness.run(context, { query: "怎么加科目", companyName: "企通", product: "好会计" });
  assert.equal(result.answer, invented);
});

test("product completion retrieves the original business question with product metadata", async () => {
  const { harness, requests } = setup();
  const history = [
    { role: "user", content: "订单可以按行关闭吗？" },
    { role: "assistant", content: "方便告诉我一下贵公司的名称吗？" },
    { role: "user", content: "企通" },
    { role: "assistant", content: "为了更好地为您服务，请问您现在使用的是哪一款产品？" },
  ];
  await harness.run(context, { query: "U8", __conversationHistory: history });
  assert.equal(requests[0].query, "订单可以按行关闭吗？");
  assert.equal(requests[0].knowledgeBaseId, "baec59c9-5b4d-4a10-84f4-4b896bfedcd1");
  assert.deepEqual(requests[0].filters, { 适用产品: { $containsToken: "U8" } });
  assert.equal(requests[0].retrievalMode, "hybrid");
  assert.equal(requests[0].rerank, false);
});

test("complete QA pairs still use route:answer and stream the final answer", async () => {
  const source = "问题：如何删除账套\n答案：进入系统管理选择账套后删除。删除前必须先备份，删除后无法恢复。";
  const { harness, modelCalls } = setup([{ content: source, score: 0.99 }], { modelContent: "进入系统管理选择账套后删除。删除前必须先备份，删除后无法恢复。" });
  const deltas: string[] = [];
  const result = await harness.run(context, { query: "账套怎么删除", companyName: "企通", product: "T3" }, undefined, (delta) => deltas.push(delta));
  assert.equal(result.state, "answering");
  assert.equal(modelCalls.length, 1);
  assert.equal(deltas.join(""), result.answer);
  assert.ok(deltas.length >= 2, JSON.stringify(deltas));
  assert.match(result.answer, /必须先备份/);
  assert.match(result.answer, /无法恢复/);
  const detail = JSON.parse(result.trace.find((item) => item.step === "answer.generate")?.detail || "{}");
  assert.equal(detail.route, "answer");
  assert.equal(detail.attempts[0].modelId, "deepseek-v4-flash");
});

test("ordinary evidence uses route:answer without validating model text", async () => {
  const source = "问题描述：如何删除账套\n解决方案：进入系统管理选择账套后删除。删除前必须先备份，删除后无法恢复。";
  const unsafe = "进入系统管理直接删除即可，不需要备份。";
  const { harness, modelCalls } = setup([{ content: source, score: 0.99 }], { modelContent: unsafe });
  const deltas: string[] = [];
  const result = await harness.run(context, { query: "账套怎么删除", companyName: "企通", product: "T3" }, undefined, (delta) => deltas.push(delta));
  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].options.task, "answer");
  assert.equal(deltas.join(""), result.answer);
  assert.equal(result.answer, unsafe);
  assert.match(deltas.join(""), /不需要备份/);
});

test("transfer responses describe a pending handoff instead of claiming a connected agent", async () => {
  const result = await setup([], { retrievalError: new Error("offline") }).harness.run(context, {
    query: "账套怎么备份", companyName: "企通", product: "U8",
  });
  assert.equal(result.state, "transferring");
  assert.match(result.answer, /请求转接.*等待坐席接入/);
  assert.doesNotMatch(result.answer, /转接成功|已接通/);
});

test("a detail follow-up keeps the persisted department topic and rejects unrelated subject hits", async () => {
  const department = {
    content: "问题描述：需要新增加一个部门，怎么操作？\n解决方案：请按以下步骤操作：基础档案-机构设置-部门档案，点击增加，录入部门编码和部门名称后保存。",
    score: 0.96,
    metadata: { 适用产品: "T3/T6" },
  };
  const subject = {
    content: "问题描述：以前用过的科目怎么增加下级科目？\n解决方案：原有数据会转移到第一个二级科目。",
    score: 0.99,
    metadata: { 适用产品: "T3/T6" },
  };
  const { harness, requests } = setup([subject, department], { modelError: new Error("use deterministic fallback") });
  const first = await harness.run(context, { query: "想要新增一个部门" });
  const second = await harness.run(context, { query: "企通", sessionId: first.sessionId });
  const third = await harness.run(context, { query: "T3", sessionId: second.sessionId });
  const fourth = await harness.run(context, { query: "具体怎么做？", sessionId: third.sessionId });
  assert.equal(fourth.currentTopic, "想要新增一个部门，具体怎么做？");
  assert.equal(fourth.rewrittenQuery, "想要新增一个部门，具体怎么做？");
  assert.deepEqual(requests.at(-1)?.filters, { 适用产品: { $containsToken: "T3" } });
  assert.match(fourth.answer, /基础档案.*机构设置.*部门档案.*增加.*部门编码.*部门名称.*保存/);
  assert.doesNotMatch(fourth.answer, /科目|二级|数据会转移/);
});

test("three phone turns reuse one persisted session without duplicates and survive restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "datapilot-phone-session-"));
  const databasePath = join(directory, "sessions.sqlite");
  const dependencies = (sessions: SqliteSessionStore) => ({
    sessions,
    retrieval: { retrieve: async () => ({ items: [{ content: "账套支持备份。", score: 0.9, rank: 1, chunkId: "c1", documentId: "d1", filename: "faq", fileType: "md", chunkIndex: 0, metadata: {} }] }) } as never,
    models: { text: async () => "可以在系统设置中备份账套。" } as never,
    workflows: { getPresetConfig: () => ({ knowledgeBaseId: "kb" }), executionContext: (value: RequestContext) => value } as never,
  });
  const sessions = new SqliteSessionStore(databasePath);
  const harness = new PhoneSupportHarness(dependencies(sessions));
  try {
    const first = await harness.run(context, { query: "账套怎么备份", companyName: "甲公司", product: "U8" });
    const second = await harness.run(context, { query: "具体怎么做", sessionId: first.sessionId, companyName: "甲公司", product: "U8" });
    const third = await harness.run(context, { query: "还有别的注意事项吗", sessionId: first.sessionId, companyName: "甲公司", product: "U8" }, undefined, undefined, { runId: "run-third" });
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(third.sessionId, first.sessionId);
    assert.equal(sessions.get(context, first.sessionId).messages.length, 6);
    assert.match(second.trace[0]?.detail || "", /^turns=1; truncated=false$/);
    assert.match(third.trace[0]?.detail || "", /^turns=2; truncated=false$/);
    sessions.close();

    const reloaded = new SqliteSessionStore(databasePath);
    try {
      assert.deepEqual(reloaded.history(context, first.sessionId).map((turn) => turn.question), ["账套怎么备份", "具体怎么做", "还有别的注意事项吗"]);
      assert.equal(reloaded.get(context, first.sessionId).messages.at(-1)?.result?.agentId, "builtin.phone-support");
      assert.equal(reloaded.get(context, first.sessionId).messages.at(-1)?.result?.runId, "run-third");
      reloaded.delete(context, first.sessionId);
      const restartedHarness = new PhoneSupportHarness(dependencies(reloaded));
      await assert.rejects(() => restartedHarness.run(context, { query: "继续", sessionId: first.sessionId }), (error: SessionStoreError) => error.status === 404);
    } finally { reloaded.close(); }
  } finally {
    try { sessions.close(); } catch { /* already closed before restart */ }
    rmSync(directory, { recursive: true, force: true });
  }
});
