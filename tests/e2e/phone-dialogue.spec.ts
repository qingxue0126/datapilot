import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const phoneAgentId = "builtin.phone-support";
const apiBase = process.env.DATAPILOT_E2E_API_URL || "http://localhost:3001";

type Understanding = {
  intent: string;
  topicAction: string;
  targetTopic: string | null;
  resolvedReferences: { expression: string; resolvedTo: string; sourceTurn: number }[];
  confidence: number;
  needsClarification: boolean;
};
type Trace = { step: string; status: string; durationMs: number; detail?: string };
type SessionDetail = { session: { id: string; title: string; messageCount: number }; messages: { role: string; content: string; result?: Record<string, unknown> }[] };
type Expected = { intent: string; topicAction: string; targetTopic?: string | null; reference?: string; needsClarification: boolean };
type TurnCapture = { input: string; actual: Understanding; trace: Trace[]; contextTurns: number; model: Record<string, unknown> };

let createdSessionIds: string[] = [];

const cases: { id: string; priority: "P0" | "P1" | "P2"; category: string; name: string; inputs: string[]; expected: Expected; allowFallback?: boolean }[] = [
  { id: "DU-01", priority: "P0", category: "A→A", name: "省略指代", inputs: ["如何新增部门？", "测试公司", "U8", "具体怎么做？"], expected: { intent: "consult", topicAction: "continue", targetTopic: "新增部门", needsClarification: false } },
  { id: "DU-02", priority: "P1", category: "A→A", name: "补充解释", inputs: ["如何新增部门？", "测试公司", "U8", "我的意思是新增下级部门"], expected: { intent: "correct", topicAction: "continue", targetTopic: "新增下级部门", needsClarification: false } },
  { id: "DU-03", priority: "P1", category: "A→A", name: "关联延伸", inputs: ["如何新增部门？", "测试公司", "U8", "新增后怎么分配权限？"], expected: { intent: "consult", topicAction: "continue", targetTopic: "分配权限", needsClarification: false } },
  { id: "DU-04", priority: "P1", category: "A→A", name: "条件追加", inputs: ["如何新增部门？", "测试公司", "U8", "如果已经有同名部门呢？"], expected: { intent: "consult", topicAction: "continue", targetTopic: "新增部门", needsClarification: false } },
  { id: "DU-05", priority: "P1", category: "A→A", name: "重复确认", inputs: ["如何新增部门？", "测试公司", "U8", "对，就是这个问题"], expected: { intent: "confirm", topicAction: "continue", targetTopic: "新增部门", needsClarification: false } },
  { id: "DU-06", priority: "P0", category: "A→B", name: "新话题切换", inputs: ["如何新增部门？", "测试公司", "U8", "怎么删除会计科目？"], expected: { intent: "delete", topicAction: "switch", targetTopic: "删除会计科目", needsClarification: false } },
  { id: "DU-07", priority: "P0", category: "A→B→A", name: "历史话题恢复", inputs: ["如何新增部门？", "测试公司", "U8", "怎么删除会计科目？", "第一个再解释一下"], expected: { intent: "consult", topicAction: "resume", targetTopic: "新增部门", reference: "第一个", needsClarification: false }, allowFallback: true },
  { id: "DU-08", priority: "P1", category: "多话题", name: "多话题并行", inputs: ["如何新增部门？", "测试公司", "U8", "同时还要新增客户档案"], expected: { intent: "create", topicAction: "extend", targetTopic: "新增客户档案", needsClarification: false } },
  { id: "DU-09", priority: "P1", category: "多话题", name: "话题结束", inputs: ["如何新增部门？", "测试公司", "U8", "部门问题先到这里，接着问科目查询"], expected: { intent: "query", topicAction: "switch", targetTopic: "科目查询", needsClarification: false } },
  { id: "DU-10", priority: "P0", category: "信息处理", name: "槽位补充", inputs: ["如何新增部门？", "测试公司"], expected: { intent: "clarify", topicAction: "continue", targetTopic: "新增部门", needsClarification: false }, allowFallback: true },
  { id: "DU-11", priority: "P0", category: "信息处理", name: "信息纠正", inputs: ["如何新增部门？", "测试公司", "U8", "我是说新增客户，不是部门"], expected: { intent: "correct", topicAction: "switch", targetTopic: "新增客户", needsClarification: false } },
  { id: "DU-12", priority: "P1", category: "信息处理", name: "问题补充", inputs: ["如何查询凭证？", "测试公司", "U8", "还要按制单人筛选"], expected: { intent: "query", topicAction: "extend", targetTopic: "查询凭证", needsClarification: false } },
  { id: "DU-13", priority: "P0", category: "信息处理", name: "否定重述", inputs: ["如何删除凭证？", "测试公司", "U8", "不是删除，是作废凭证"], expected: { intent: "correct", topicAction: "continue", targetTopic: "作废凭证", needsClarification: false } },
  { id: "DU-14", priority: "P0", category: "澄清", name: "指代歧义", inputs: ["如何新增部门？", "测试公司", "U8", "怎么删除会计科目？", "那个怎么修改？"], expected: { intent: "clarify", topicAction: "clarify", targetTopic: null, needsClarification: true }, allowFallback: true },
  { id: "DU-15", priority: "P0", category: "澄清", name: "问题模糊", inputs: ["怎么弄？"], expected: { intent: "clarify", topicAction: "clarify", targetTopic: null, needsClarification: true }, allowFallback: true },
  { id: "DU-16", priority: "P0", category: "澄清", name: "信息冲突", inputs: ["如何删除凭证？", "测试公司", "U8", "不要删除，但请删除它"], expected: { intent: "clarify", topicAction: "clarify", targetTopic: null, needsClarification: true } },
  { id: "DU-17", priority: "P2", category: "特殊意图", name: "闲聊", inputs: ["你好"], expected: { intent: "chitchat", topicAction: "chitchat", targetTopic: null, needsClarification: false }, allowFallback: true },
  { id: "DU-18", priority: "P0", category: "特殊意图", name: "结束", inputs: ["如何新增部门？", "再见"], expected: { intent: "end", topicAction: "end", targetTopic: "新增部门", needsClarification: false }, allowFallback: true },
  { id: "DU-19", priority: "P0", category: "特殊意图", name: "转人工", inputs: ["请帮我转人工客服"], expected: { intent: "transfer", topicAction: "end", targetTopic: null, needsClarification: false }, allowFallback: true },
  { id: "DU-20", priority: "P0", category: "异常", name: "LLM 调用失败安全降级", inputs: ["如何新增部门？"], expected: { intent: "create", topicAction: "start", targetTopic: "新增部门", needsClarification: false }, allowFallback: true },
];

test.describe("phone dialogue understanding real Edge E2E", () => {
  test.beforeEach(async ({ page }) => {
    createdSessionIds = [];
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("textarea[aria-label='输入数据问题']")).toBeVisible();
    await selectPhoneAgent(page);
  });

  test.afterEach(async ({ page }) => {
    await Promise.all(createdSessionIds.map((sessionId) => deleteSession(page, sessionId)));
  });

  for (const scenario of cases) {
    test(`${scenario.id} · ${scenario.category} · ${scenario.name}`, async ({ page }, testInfo) => {
      const sse: string[] = [];
      const captures: TurnCapture[] = [];
      let sessionId = "";
      for (const input of scenario.inputs) {
        sessionId = await sendTurn(page, input, sse);
        const detail = await getSession(page, sessionId);
        captures.push(capture(detail, input));
      }
      const actual = captures.at(-1)!;
      const modelFailure = actual.model.source === "safe_fallback" && Boolean(actual.model.degradationReason);
      const artifact = { ...scenario, sessionId, inputs: scenario.inputs, expected: scenario.expected, actual: actual.actual, turns: captures, sse, modelFailure };
      await attachArtifact(testInfo, page, artifact);

      if (modelFailure && !scenario.allowFallback) {
        testInfo.annotations.push({ type: "blocked", description: `MODEL_FAILURE: ${String(actual.model.degradationReason).slice(0, 180)}` });
        test.skip(true, "BLOCKED: managed intent route failure");
      }

      expect(actual.actual.intent).toBe(scenario.expected.intent);
      expect(actual.actual.topicAction).toBe(scenario.expected.topicAction);
      expect(actual.actual.needsClarification).toBe(scenario.expected.needsClarification);
      if (scenario.expected.targetTopic === null) expect(actual.actual.targetTopic).toBeNull();
      else if (scenario.expected.targetTopic) expect(actual.actual.targetTopic || "").toContain(scenario.expected.targetTopic);
      if (scenario.expected.reference) expect(actual.actual.resolvedReferences.some((item) => item.expression.includes(scenario.expected.reference!))).toBe(true);
      expect(actual.model.route).toBe("intent");
      if (actual.model.source === "llm") expect(String(actual.model.model || "")).not.toBe("");
      expect(detailSessionConsistency(captures, scenario.inputs.length)).toBe(true);
    });
  }

  test("DU-21 · 会话 · 不同通话隔离", async ({ page }, testInfo) => {
    const firstSse: string[] = [];
    const first = await sendTurn(page, "如何新增部门？", firstSse);
    await page.reload({ waitUntil: "domcontentloaded" });
    await selectPhoneAgent(page);
    const secondSse: string[] = [];
    const second = await sendTurn(page, "如何查询凭证？", secondSse);
    const [a, b] = await Promise.all([getSession(page, first), getSession(page, second)]);
    expect(first).not.toBe(second);
    expect(a.messages.map((item) => item.content)).not.toContain("如何查询凭证？");
    expect(b.messages.map((item) => item.content)).not.toContain("如何新增部门？");
    await attachArtifact(testInfo, page, { id: "DU-21", priority: "P0", category: "会话", name: "不同通话隔离", sessionId: second, isolatedSessionId: first, inputs: ["如何新增部门？", "如何查询凭证？"], expected: { isolated: true }, actual: { isolated: true }, sse: [...firstSse, ...secondSse] });
  });
});

async function selectPhoneAgent(page: Page) {
  await page.getByRole("button", { name: "配置" }).click();
  const select = page.locator("select").last();
  await select.selectOption(phoneAgentId);
  await page.getByRole("button", { name: "配置" }).click();
}

async function sendTurn(page: Page, input: string, sse: string[]) {
  const responsePromise = page.waitForResponse((candidate) => candidate.url().includes(`/api/agents/${phoneAgentId}/run/stream`) && candidate.request().method() === "POST");
  await page.locator("textarea[aria-label='输入数据问题']").fill(input);
  await page.locator("button.send-button").click();
  const response = await responsePromise;
  const requestBody = JSON.parse(response.request().postData() || "{}");
  const sessionId = String(requestBody.input?.sessionId || "");
  expect(sessionId).not.toBe("");
  if (!createdSessionIds.includes(sessionId)) createdSessionIds.push(sessionId);
  await expect(page.locator("button.send-button")).toHaveText("发送 ↗", { timeout: 75_000 });
  try { sse.push(sanitize(await response.text())); } catch { sse.push("<SSE body unavailable>"); }
  return sessionId;
}

async function getSession(page: Page, sessionId: string) {
  const result = await page.evaluate(async ({ apiBase, sessionId }) => {
    const response = await fetch(`${apiBase}/api/sessions/${encodeURIComponent(sessionId)}`, { credentials: "include" });
    return { status: response.status, body: await response.json() };
  }, { apiBase, sessionId });
  expect(result.status).toBe(200);
  return result.body as SessionDetail;
}

function capture(detail: SessionDetail, input: string): TurnCapture {
  const phone = detail.messages.at(-1)?.result?.phone as { dialogueUnderstanding?: Understanding; trace?: Trace[] } | undefined;
  expect(phone?.dialogueUnderstanding, "缺少 DialogueUnderstanding 结构化输出").toBeTruthy();
  const trace = phone?.trace || [];
  const context = trace.find((item) => item.step === "context.prepare")?.detail?.match(/turns=(\d+)/);
  const understandingTrace = trace.find((item) => item.step === "dialogue.understand");
  expect(understandingTrace, "缺少 dialogue.understand trace").toBeTruthy();
  let model: Record<string, unknown> = {};
  try { model = JSON.parse(understandingTrace?.detail || "{}"); } catch { /* assertion below explains malformed trace */ }
  return { input, actual: phone!.dialogueUnderstanding!, trace, contextTurns: Number(context?.[1] || 0), model };
}

function detailSessionConsistency(captures: TurnCapture[], count: number) {
  return captures.length === count && captures.every((item, index) => item.contextTurns === index);
}

async function attachArtifact(testInfo: TestInfo, page: Page, value: Record<string, unknown>) {
  const path = testInfo.outputPath(`${String(value.id)}-dialogue.json`);
  await writeFile(path, sanitize(JSON.stringify(value, null, 2)), "utf8");
  await testInfo.attach(`${String(value.id)}-dialogue.json`, { path, contentType: "application/json" });
  await testInfo.attach(`${String(value.id)}-screenshot.png`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
}

async function deleteSession(page: Page, sessionId: string) {
  await page.evaluate(async ({ apiBase, sessionId }) => { await fetch(`${apiBase}/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", credentials: "include" }); }, { apiBase, sessionId });
}

function sanitize(value: string) {
  return value.replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_.-]+/gi, "<redacted>").replace(/"password"\s*:\s*"[^"]*"/gi, '"password":"<redacted>"');
}
