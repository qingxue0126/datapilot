import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const phoneAgentId = "builtin.phone-support";
const apiBase = process.env.DATAPILOT_E2E_API_URL || "http://localhost:3001";

type SessionDetail = {
  session: { id: string; title: string; messageCount: number };
  messages: { id: string; role: "user" | "assistant"; content: string; result?: Record<string, unknown> }[];
};
type AgentCall = { sessionId: string; historyMessages: number; status?: number; contentType?: string };
type Monitor = { agentCalls: AgentCall[]; sessionCalls: { method: string; path: string; status?: number }[]; exchangeCalls: { method: string; path: string; status?: number }[] };

let createdSessionIds: string[] = [];

test.describe.serial("builtin.phone-support real Edge E2E", () => {
  test.beforeEach(async ({ page }) => {
    createdSessionIds = [];
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("textarea[aria-label='输入数据问题']")).toBeVisible();
    await selectPhoneAgent(page);
  });

  test.afterEach(async ({ page }) => {
    await Promise.all(createdSessionIds.map((sessionId) => deleteSession(page, sessionId)));
  });

  test("TC-PHONE-01 · T01 Session 创建：网页与 Agent 使用同一 Session", async ({ page }, testInfo) => {
    const monitor = monitorApi(page);
    const sessionId = await sendTurn(page, "E2E T01 账套备份咨询", monitor);
    const detail = await getSession(page, sessionId);

    expect(detail.session.id).toBe(sessionId);
    expect(detail.session.messageCount).toBe(2);
    expect(detail.messages).toHaveLength(2);
    expect(monitor.agentCalls).toHaveLength(1);
    expect(monitor.agentCalls[0]).toMatchObject({ sessionId, historyMessages: 0, status: 200 });
    expect(monitor.exchangeCalls).toHaveLength(0);
    expect(contextTrace(detail)).toMatchObject({ turns: 0, truncated: false });
    await attachCaseArtifacts(testInfo, page, "TC-PHONE-01", monitor, detail);
  });

  test("TC-PHONE-02 · T02 同一 Session 连续三轮且无重复写入", async ({ page }, testInfo) => {
    const monitor = monitorApi(page);
    const first = await sendTurn(page, "E2E T02 我要咨询账套备份", monitor);
    const second = await sendTurn(page, "测试公司", monitor);
    const third = await sendTurn(page, "U8", monitor);
    const detail = await getSession(page, first);

    expect([first, second, third]).toEqual([first, first, first]);
    expect(monitor.agentCalls.map((call) => call.sessionId)).toEqual([first, first, first]);
    expect(monitor.agentCalls.map((call) => call.historyMessages)).toEqual([0, 2, 4]);
    expect(monitor.exchangeCalls).toHaveLength(0);
    expectCompleteExchanges(detail, 3);
    expect(contextTrace(detail)).toMatchObject({ turns: 2, truncated: false });
    await attachCaseArtifacts(testInfo, page, "TC-PHONE-02", monitor, detail);
  });

  test("TC-PHONE-03 · T03 历史信息完整保存", async ({ page }, testInfo) => {
    const monitor = monitorApi(page);
    const questions = ["E2E T03 历史保存验证", "测试公司", "U8"];
    const sessionId = await sendTurns(page, questions, monitor);
    const detail = await getSession(page, sessionId);

    expectCompleteExchanges(detail, questions.length);
    expect(detail.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual(questions);
    expect(new Set(detail.messages.map((message) => message.id)).size).toBe(detail.messages.length);
    await attachCaseArtifacts(testInfo, page, "TC-PHONE-03", monitor, detail);
  });

  test("TC-PHONE-04 · T04 多话题历史保留", async ({ page }, testInfo) => {
    const monitor = monitorApi(page);
    const questions = ["E2E T04 如何新增部门", "测试公司", "U8", "E2E T04 如何导出报表"];
    const sessionId = await sendTurns(page, questions, monitor);
    const detail = await getSession(page, sessionId);

    const savedQuestions = detail.messages.filter((message) => message.role === "user").map((message) => message.content);
    expect(savedQuestions).toEqual(questions);
    expect(savedQuestions).toContain("E2E T04 如何新增部门");
    expect(savedQuestions).toContain("E2E T04 如何导出报表");
    expectCompleteExchanges(detail, questions.length);
    await attachCaseArtifacts(testInfo, page, "TC-PHONE-04", monitor, detail);
  });

  test("TC-PHONE-05 · T05 不同 Session 隔离", async ({ page }, testInfo) => {
    const monitor = monitorApi(page);
    const first = await sendTurn(page, "E2E T05 会话甲", monitor);
    await page.reload({ waitUntil: "domcontentloaded" });
    await selectPhoneAgent(page);
    const second = await sendTurn(page, "E2E T05 会话乙", monitor);
    const [firstDetail, secondDetail] = await Promise.all([getSession(page, first), getSession(page, second)]);

    expect(second).not.toBe(first);
    expect(firstDetail.messages.map((message) => message.content)).toContain("E2E T05 会话甲");
    expect(firstDetail.messages.map((message) => message.content)).not.toContain("E2E T05 会话乙");
    expect(secondDetail.messages.map((message) => message.content)).toContain("E2E T05 会话乙");
    expect(secondDetail.messages.map((message) => message.content)).not.toContain("E2E T05 会话甲");
    await attachCaseArtifacts(testInfo, page, "TC-PHONE-05", monitor, secondDetail, { isolatedSessionId: first, isolatedMessageCount: firstDetail.session.messageCount });
  });

  test("TC-PHONE-06 · T06 页面刷新后可从网页会话列表恢复", async ({ page }, testInfo) => {
    const monitor = monitorApi(page);
    const sessionId = await sendTurn(page, "E2E T06 刷新恢复", monitor);
    const before = await getSession(page, sessionId);

    await page.reload({ waitUntil: "domcontentloaded" });
    const item = page.locator(`.recent-analysis-item[aria-label="打开分析：${cssEscape(before.session.title)}"]`);
    await expect(item).toBeVisible();
    await item.click();
    await expect(page.locator("section.message-stream")).toContainText("E2E T06 刷新恢复");
    const restored = await getSession(page, sessionId);
    expectCompleteExchanges(restored, 1);
    await attachCaseArtifacts(testInfo, page, "TC-PHONE-06", monitor, restored);
  });

  test("TC-PHONE-07 · T07 上下文窗口会截断但会话历史仍完整", async ({ page }, testInfo) => {
    const monitor = monitorApi(page);
    let sessionId = await sendTurn(page, "E2E T07 上下文窗口", monitor);
    let trace = contextTrace(await getSession(page, sessionId));
    for (let turn = 0; turn < 12 && !trace.truncated; turn += 1) {
      sessionId = await sendTurn(page, "好的", monitor);
      trace = contextTrace(await getSession(page, sessionId));
    }
    const detail = await getSession(page, sessionId);

    expect(trace.truncated).toBe(true);
    expect(trace.turns).toBeGreaterThan(0);
    expectCompleteExchanges(detail, monitor.agentCalls.length);
    expect(detail.messages.filter((message) => message.role === "user").length).toBeGreaterThan(trace.turns);
    await attachCaseArtifacts(testInfo, page, "TC-PHONE-07", monitor, detail, { contextPrepare: trace });
  });

  test("TC-PHONE-08 · T08 网页会话结束并清理", async ({ page }, testInfo) => {
    const monitor = monitorApi(page);
    const sessionId = await sendTurn(page, "E2E T08 会话清理", monitor);
    const detail = await getSession(page, sessionId);
    const sessionItem = page.locator(`.recent-analysis-item[aria-label="打开分析：${cssEscape(detail.session.title)}"]`);

    await sessionItem.getByRole("button", { name: `会话菜单：${detail.session.title}` }).click();
    await page.getByRole("menuitem", { name: "删除" }).click();
    await page.getByRole("button", { name: "确认删除" }).click();
    await expect.poll(async () => (await fetchSession(page, sessionId)).status).toBe(404);
    createdSessionIds = createdSessionIds.filter((id) => id !== sessionId);
    await attachCaseArtifacts(testInfo, page, "TC-PHONE-08", monitor, detail, { cleanupStatus: 404 });
  });
});

async function selectPhoneAgent(page: Page) {
  await page.getByRole("button", { name: "配置" }).click();
  const agentSelect = page.locator("select").last();
  await agentSelect.selectOption(phoneAgentId);
  await expect(agentSelect).toHaveValue(phoneAgentId);
  await page.getByRole("button", { name: "配置" }).click();
}

async function sendTurns(page: Page, questions: string[], monitor: Monitor) {
  let sessionId = "";
  for (const question of questions) sessionId = await sendTurn(page, question, monitor);
  return sessionId;
}

async function sendTurn(page: Page, question: string, monitor: Monitor) {
  const request = page.waitForRequest((candidate) => candidate.url().includes(`/api/agents/${phoneAgentId}/run/stream`) && candidate.method() === "POST");
  await page.locator("textarea[aria-label='输入数据问题']").fill(question);
  await page.locator("button.send-button").click();
  const sseRequest = await request;
  const input = JSON.parse(sseRequest.postData() || "{}")?.input || {};
  const sessionId = String(input.sessionId || "");
  expect(sessionId).not.toBe("");
  if (!createdSessionIds.includes(sessionId)) createdSessionIds.push(sessionId);
  await expect(page.locator("button.send-button")).toHaveText("发送 ↗", { timeout: 75_000 });
  await expect.poll(() => monitor.agentCalls.length).toBeGreaterThan(0);
  return sessionId;
}

function monitorApi(page: Page): Monitor {
  const monitor: Monitor = { agentCalls: [], sessionCalls: [], exchangeCalls: [] };
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === `/api/agents/${phoneAgentId}/run/stream` && request.method() === "POST") {
      const input = JSON.parse(request.postData() || "{}")?.input || {};
      monitor.agentCalls.push({ sessionId: String(input.sessionId || ""), historyMessages: Array.isArray(input.__conversationHistory) ? input.__conversationHistory.length : -1 });
    } else if (path.includes("/exchanges")) {
      monitor.exchangeCalls.push({ method: request.method(), path });
    } else if (path.startsWith("/api/sessions")) {
      monitor.sessionCalls.push({ method: request.method(), path });
    }
  });
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path === `/api/agents/${phoneAgentId}/run/stream`) {
      const call = monitor.agentCalls.at(-1);
      if (call) { call.status = response.status(); call.contentType = response.headers()["content-type"]; }
    }
    for (const item of [...monitor.sessionCalls, ...monitor.exchangeCalls].reverse()) {
      if (item.path === path && item.status === undefined) { item.status = response.status(); break; }
    }
  });
  return monitor;
}

async function getSession(page: Page, sessionId: string) {
  const response = await fetchSession(page, sessionId);
  expect(response.status).toBe(200);
  return response.body as SessionDetail;
}

async function fetchSession(page: Page, sessionId: string): Promise<{ status: number; body: unknown }> {
  return page.evaluate(async ({ apiBase, sessionId }) => {
    const response = await fetch(`${apiBase}/api/sessions/${encodeURIComponent(sessionId)}`, { credentials: "include" });
    return { status: response.status, body: await response.json() };
  }, { apiBase, sessionId });
}

async function deleteSession(page: Page, sessionId: string) {
  await page.evaluate(async ({ apiBase, sessionId }) => {
    await fetch(`${apiBase}/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", credentials: "include" });
  }, { apiBase, sessionId });
}

function expectCompleteExchanges(detail: SessionDetail, turns: number) {
  expect(detail.session.messageCount).toBe(turns * 2);
  expect(detail.messages).toHaveLength(turns * 2);
  expect(detail.messages.map((message) => message.role)).toEqual(Array.from({ length: turns }, () => ["user", "assistant"]).flat());
  expect(new Set(detail.messages.map((message) => message.id)).size).toBe(turns * 2);
}

function contextTrace(detail: SessionDetail) {
  const result = detail.messages.at(-1)?.result;
  const phone = result?.phone as { trace?: { step: string; detail?: string }[] } | undefined;
  const detailText = phone?.trace?.find((item) => item.step === "context.prepare")?.detail || "";
  const match = detailText.match(/turns=(\d+); truncated=(true|false)/);
  expect(match, `缺少 context.prepare trace: ${detailText}`).not.toBeNull();
  return { turns: Number(match?.[1]), truncated: match?.[2] === "true" };
}

async function attachCaseArtifacts(testInfo: TestInfo, page: Page, tcId: string, monitor: Monitor, detail: SessionDetail, extra: Record<string, unknown> = {}) {
  const response = {
    session: detail.session,
    messages: detail.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content.slice(0, 1_000),
      result: responseMetadata(message.result),
    })),
  };
  const resultPath = testInfo.outputPath(`${tcId}-result.json`);
  await writeFile(resultPath, JSON.stringify({
    tcId,
    result: "PASS",
    http: {
      agentSse: monitor.agentCalls,
      sessions: monitor.sessionCalls,
      exchanges: monitor.exchangeCalls,
    },
    response,
    ...extra,
  }, null, 2), "utf8");
  await testInfo.attach(`${tcId}-result.json`, { path: resultPath, contentType: "application/json" });
  await testInfo.attach(`${tcId}-screenshot.png`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
}

function responseMetadata(result: Record<string, unknown> | undefined) {
  if (!result) return undefined;
  const phone = result.phone as Record<string, unknown> | undefined;
  return {
    channel: result.channel,
    agentId: result.agentId,
    runId: result.runId,
    status: result.status,
    phone: phone && {
      state: phone.state,
      currentTopic: phone.currentTopic,
      rewrittenQuery: phone.rewrittenQuery,
      intent: phone.intent,
      dialogueUnderstanding: phone.dialogueUnderstanding,
      trace: phone.trace,
    },
  };
}

function cssEscape(value: string) {
  return value.replace(/(["\\])/g, "\\$1");
}
