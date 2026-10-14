import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PhoneSupportHarness } from "../../../../../../server/modules/agent/presets/phone-support/phone-support.js";
import { SessionStoreError, SqliteSessionStore } from "../../../../../../server/modules/conversation/session-store.js";
import type { RequestContext } from "../../../../../../server/shared/types/context.js";

const context: RequestContext = { tenantId: "t1", accountSetId: "a1", userId: "u1", role: "tenant_admin", sessionId: "s" };
function setup(items: { content: string; score: number; metadata?: Record<string, unknown> }[] = [{ content: "账套支持备份和删除，具体步骤是进入系统设置。", score: 0.9 }], options: { modelContent?: string; modelError?: Error } = {}) {
  const exchanges: { question: string; answer: string; result: Record<string, unknown> }[] = [];
  const requests: { knowledgeBaseId: string; query: string; filters?: unknown }[] = [];
  const sessions = {
    create: () => ({ id: "phone-session", title: "", pinned: false, createdAt: "", updatedAt: "", messageCount: 0 }),
    get: () => ({ session: { id: "phone-session", title: "", pinned: false, createdAt: "", updatedAt: "", messageCount: exchanges.length * 2 }, messages: exchanges.map((item, index) => ({ id: `a${index}`, sessionId: "phone-session", role: "assistant" as const, content: item.answer, result: item.result, createdAt: "" })) }),
    history: () => exchanges.map((item) => ({ question: item.question, answer: item.answer, createdAt: 0 })),
    appendExchange: (_c: RequestContext, _id: string, input: typeof exchanges[number]) => { exchanges.push(input); return {} as never; },
  };
  const retrieval = { retrieve: async (_c: RequestContext, request: { knowledgeBaseId: string; query: string; filters?: unknown }) => { requests.push(request); return { items: items.map((item, index) => ({ ...item, rank: index + 1, chunkId: `c${index}`, documentId: "d", filename: "faq", fileType: "md", chunkIndex: index, metadata: item.metadata || {} })), filters: {}, topK: 5, scoreThreshold: 0.25, rerank: false, retrievalMode: "hybrid" as const, vectorWeight: 0.7, candidateCount: 15, rerankModel: "", config: {} as never, vectorStore: "local" as never, query: request.query }; } };
  const modelCalls: { messages: { role: string; content: string }[]; options: Record<string, unknown> }[] = [];
  const models = { text: async (messages: { role: string; content: string }[], modelOptions: Record<string, unknown>) => { modelCalls.push({ messages, options: modelOptions }); if (options.modelError) throw options.modelError; return options.modelContent || "可以的。您可以进入系统设置进行操作。"; } };
  const workflows = {
    getPresetConfig: () => ({ knowledgeBaseId: "baec59c9-5b4d-4a10-84f4-4b896bfedcd1", productMetadataField: "适用产品" }),
    executionContext: (value: RequestContext) => value,
  };
  return { harness: new PhoneSupportHarness({ sessions: sessions as never, retrieval: retrieval as never, models: models as never, workflows: workflows as never }), exchanges, requests, modelCalls };
}

test("phone support preserves slots and rewrites follow-up questions", async () => {
  const { harness, exchanges } = setup();
  const first = await harness.run(context, { query: "账套怎么备份", companyName: "甲公司", product: "财务系统" });
  const second = await harness.run(context, { query: "那怎么删除呢", sessionId: first.sessionId, companyName: "甲公司", product: "财务系统" });
  assert.equal(second.state, "answering");
  assert.equal(second.rewrittenQuery, "财务系统软件如何删除账套？");
  assert.doesNotMatch(second.rewrittenQuery, /备份/);
  assert.equal(exchanges.length, 2);
});

test("PDF bad cases route to the matching, grounded knowledge entry", async () => {
  const cases: { query: string; product: string; topic: string; sourceQuestion?: string; source: string; rewrite?: string }[] = [
    { query: "账套可以删除吗", product: "T3", topic: "删除账套", source: "删除当前输出账套", rewrite: "T3软件如何删除账套？" },
    { query: "我这台是新的电脑，没有报表模板，可以给我发一份吗", product: "U8", topic: "报表模板", source: "复制到新电脑上" },
    { query: "易代账的发票怎么自动生成凭证", product: "易代账", topic: "发票生成凭证", source: "税务数字账户", rewrite: "易代账软件发票如何自动生成凭证？" },
    { query: "怎么增加一个用户", product: "T3", topic: "新增操作人员", sourceQuestion: "怎么新增一个操作人员", source: "录入，编号、姓名、密码", rewrite: "T3软件如何新增操作人员？" },
    { query: "怎么增加操作员", product: "T3", topic: "新增操作人员", sourceQuestion: "怎么新增一个操作人员", source: "录入，编号、姓名、密码", rewrite: "T3软件如何新增操作人员？" },
    { query: "怎么在系统里新增一个公司", product: "好会计", topic: "新增账套", sourceQuestion: "怎么新增账套", source: "输入公司名称", rewrite: "好会计软件如何新增账套？" },
    { query: "怎么关账", product: "T+", topic: "结账", source: "财务结账", rewrite: "T+软件怎么结账？" },
  ] as const;

  for (const item of cases) {
    const content = `问题描述：${item.sourceQuestion || item.query}\n解决方案：${item.source}`;
    const result = await setup([{ content, score: 0.99 }], { modelError: new Error("use grounded fallback") }).harness.run(context, {
      query: item.query, companyName: "上海企通", product: item.product,
    });
    assert.equal(result.state, "answering", `${item.query}: ${JSON.stringify(result)}`);
    assert.equal(result.currentTopic, item.topic, item.query);
    assert.equal(result.rewrittenQuery, item.rewrite || `${item.product}软件如何${item.topic}？`, item.query);
    assert.ok(result.sources.length > 0, item.query);
    assert.ok(result.answer.includes(item.source.replace("录入", "填写")), item.query);
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
  const noAnswer = await setup([]).harness.run(context, { query: "如何新增部门", companyName: "甲公司", product: "财务系统" });
  assert.equal(noAnswer.state, "transferring");
});

test("phone support rejects retrieval hits without a topic anchor", async () => {
  const result = await setup([{ content: "问题描述：如何新增部门\n解决方案：进入基础档案新增部门。", score: 0.99 }]).harness.run(context, {
    query: "怎么启用火星税控舱？", companyName: "企通", product: "U8",
  });
  assert.equal(result.state, "transferring");
  assert.equal(result.sources.length, 0);
  assert.doesNotMatch(result.answer, /基础档案|新增部门/);
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
  assert.equal(first.answer, "可以的。您先删除 Cache 文件夹，再重新启动电脑。");
  assert.doesNotMatch(first.answer, /问题描述|解决方案|知识库|请按以下步骤操作/);
  const closing = await harness.run(context, { query: "好的", sessionId: first.sessionId, companyName: "企通", product: "U8" });
  assert.equal(closing.answer, "好的，如果还有其他问题，随时告诉我。");
});

test("phone support humanizes knowledge content when the answer model is unavailable", async () => {
  const { harness } = setup(
    [{ content: "问题描述：如何新增部门\n解决方案：请按以下步骤操作：基础档案-机构设置-部门档案，点击增加，录入部门编码和部门名称后保存", score: 0.9 }],
    { modelError: new Error("model unavailable") },
  );
  const result = await harness.run(context, { query: "想要新增一个部门", companyName: "企通", product: "T3" });
  assert.equal(result.state, "answering");
  assert.equal(result.answer, "您先依次进入“基础档案”、“机构设置”、“部门档案”，点击“增加”，填写部门编码和部门名称，保存就可以了。");
  assert.equal(result.trace.find((item) => item.step === "answer.generate")?.status, "failed");
  assert.doesNotMatch(result.answer, /问题描述|解决方案|请按以下步骤操作/);
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
  assert.match(modelCalls[0].messages[1].content, /基础设置-科目期初/);
  assert.doesNotMatch(modelCalls[0].messages[1].content, /只能停用/);
});

test("phone support rejects an over-expanded answer and uses the grounded fallback", async () => {
  const source = "问题描述：需要增加会计科目，怎么操作\n解决方案：请按以下步骤操作：基础设置-科目期初进行增加就可以了";
  const invented = "在好会计里增加会计科目，您依次进入基础设置和科目期初，选择增加就可以了。如果是给以前用过的科目增加下级科目，之前这个科目做的数据会自动转到第一个二级科目上，请您放心操作。";
  const result = await setup([{ content: source, score: 0.95 }], { modelContent: invented }).harness.run(context, { query: "怎么加科目", companyName: "企通", product: "好会计" });
  assert.equal(result.answer, "增加会计科目的话，您进入“基础设置”，找到“科目期初”，在那里进行增加就可以了。");
  assert.doesNotMatch(result.answer, /自动转到|二级科目/);
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
  assert.equal(requests[0].query, "U8软件如何关闭订单？补充条件：按行。");
  assert.equal(requests[0].knowledgeBaseId, "baec59c9-5b4d-4a10-84f4-4b896bfedcd1");
  assert.deepEqual(requests[0].filters, { 适用产品: { $containsToken: "U8" } });
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
  assert.equal(fourth.currentTopic, "新增部门");
  assert.equal(fourth.rewrittenQuery, "T3软件如何新增部门？请提供详细操作步骤。");
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
