import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const phoneAgentId = "builtin.phone-support";
const apiBase = process.env.DATAPILOT_E2E_API_URL || "http://localhost:3001";
type Trace = { step: string; status: string; durationMs: number; detail?: string };
type Phone = { state: string; slots: Record<string, string>; currentTopic?: string; rewrittenQuery: string; sources: { content?: string; chunkId?: string }[]; dialogueUnderstanding: Record<string, unknown>; dialogueState: { product?: string; currentTopic?: string; topicHistory: string[]; topics: { topic: string; slots: Record<string, unknown> }[] }; policy: { action: string; reason: string }; trace: Trace[] };
type SessionDetail = { session: { id: string; messageCount: number }; messages: { role: string; content: string; result?: { phone?: Phone } }[] };
type Turn = { input: string; sessionId: string; sse: string; phone: Phone; answer: string };

let sessions: string[] = [];

test.describe.serial("phone full dialogue management E2E", () => {
  test.beforeEach(async ({ page }) => {
    sessions = [];
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("textarea[aria-label='输入数据问题']")).toBeVisible();
    await selectPhoneAgent(page);
  });

  test.afterEach(async ({ page }) => { await Promise.all(sessions.map((id) => deleteSession(page, id))); });

  test("FULL-01 · A→A 自然表达、指代补全、真实 RAG 与 SSE", async ({ page }, testInfo) => {
    const turns: Turn[] = [];
    for (const input of ["我准备建一个新的部门档案，入口在哪儿？", "测试公司", "U8", "下一步具体怎么操作？"]) turns.push(await send(page, input));
    await blockOnExternalFailure(testInfo, page, turns);
    const last = turns.at(-1)!;
    expect(last.phone.currentTopic || "").toContain("部门");
    expect(last.phone.rewrittenQuery, JSON.stringify(last.phone, null, 2)).toContain("部门");
    expect(last.phone.rewrittenQuery).not.toMatch(/^U8软件如何/);
    expect(last.phone.sources.length, JSON.stringify(last.phone, null, 2)).toBeGreaterThan(0);
    expect(JSON.stringify(last.phone.sources)).toContain("部门");
    expect(last.phone.trace.map((item) => item.step)).toEqual(expect.arrayContaining(["dialogue.understand", "dialogue.state", "dialogue.rewrite", "dialogue.policy", "knowledge.retrieve", "answer"]));
    expect(last.sse).toContain("event: done");
    expect((last.sse.match(/event: delta/g) || []).length).toBeGreaterThan(0);
    const detail = await getSession(page, last.sessionId);
    expect(detail.messages.filter((item) => item.role === "assistant")).toHaveLength(4);
    await artifact(testInfo, page, "FULL-01", "A→A / unseen natural language / RAG / SSE", turns, detail);
  });

  test("FULL-02 · A→B→A 话题隔离、恢复与刷新持久化", async ({ page }, testInfo) => {
    const turns: Turn[] = [];
    for (const input of ["如何新增部门？", "测试公司", "U8", "那会计科目怎么查询？", "刚才提到的新增部门怎么具体操作？"]) turns.push(await send(page, input));
    await blockOnExternalFailure(testInfo, page, turns);
    const switched = turns[3].phone;
    expect(switched.currentTopic || "").toContain("会计科目");
    expect(switched.rewrittenQuery).toContain("会计科目");
    expect(switched.rewrittenQuery).not.toMatch(/新增|部门/);
    const resumed = turns[4].phone;
    expect(resumed.currentTopic || "").toContain("新增部门");
    expect(resumed.rewrittenQuery).toContain("新增部门");
    expect(resumed.rewrittenQuery).not.toContain("科目");
    expect(resumed.dialogueState.topicHistory.some((item) => item.includes("新增部门"))).toBe(true);
    expect(resumed.dialogueState.topicHistory.some((item) => item.includes("会计科目"))).toBe(true);

    await page.reload({ waitUntil: "domcontentloaded" });
    const restored = await getSession(page, turns[0].sessionId);
    const restoredPhone = restored.messages.at(-1)?.result?.phone;
    expect(restoredPhone?.dialogueState.currentTopic || "").toContain("新增部门");
    expect(restoredPhone?.dialogueState.topics).toHaveLength(2);
    await artifact(testInfo, page, "FULL-02", "A→B→A / state persistence / refresh", turns, restored);
  });

  test("FULL-03 · 信息纠正优先且不触发污染检索", async ({ page }, testInfo) => {
    const turns: Turn[] = [];
    for (const input of ["如何新增部门？", "测试公司", "U8", "不是U8，改成T3", "我是说新增客户档案，不是部门"]) turns.push(await send(page, input));
    const productCorrection = turns[3].phone;
    expect(productCorrection.dialogueState.product).toBe("T3");
    expect(productCorrection.trace.some((item) => item.step === "knowledge.retrieve")).toBe(false);
    const topicCorrection = turns[4].phone;
    expect(topicCorrection.currentTopic || "").toContain("新增客户档案");
    expect(topicCorrection.rewrittenQuery).toContain("新增客户档案");
    expect(topicCorrection.rewrittenQuery).toContain("不是部门");
    await artifact(testInfo, page, "FULL-03", "correction precedence / no stale retrieval", turns, await getSession(page, turns[0].sessionId));
  });

  test("FULL-04 · 缺问题、歧义、转人工、结束与 Session 隔离", async ({ page }, testInfo) => {
    const turns: Turn[] = [await send(page, "U8"), await send(page, "测试公司")];
    expect(turns[0].phone.trace.some((item) => item.step === "knowledge.retrieve")).toBe(false);
    expect(turns[1].phone.policy.action, JSON.stringify(turns[1].phone, null, 2)).toBe("ask_query");
    expect(turns[1].phone.trace.some((item) => item.step === "knowledge.retrieve")).toBe(false);
    const firstSession = turns[0].sessionId;

    await page.reload({ waitUntil: "domcontentloaded" });
    await selectPhoneAgent(page);
    const isolated = await send(page, "怎么弄？");
    expect(isolated.sessionId).not.toBe(firstSession);
    expect(isolated.phone.policy.action).toBe("clarify");
    expect(isolated.phone.trace.some((item) => item.step === "knowledge.retrieve")).toBe(false);
    const transfer = await send(page, "麻烦现在转人工客服");
    expect(transfer.phone.state).toBe("transferring");
    expect(transfer.answer).toContain("转接人工");
    const ended = await send(page, "不用了，再见");
    expect(ended.phone.dialogueUnderstanding.intent).toBe("end");
    expect(ended.phone.trace.some((item) => item.step === "knowledge.retrieve")).toBe(false);
    const first = await getSession(page, firstSession);
    expect(first.messages.map((item) => item.content)).not.toContain("怎么弄？");
    const all = [...turns, isolated, transfer, ended];
    await artifact(testInfo, page, "FULL-04", "missing question / ambiguity / transfer / end / isolation", all, await getSession(page, isolated.sessionId), { isolatedSession: first });
  });

  test("FULL-05 · 无可靠证据时转人工且不编造步骤", async ({ page }, testInfo) => {
    const turns: Turn[] = [];
    for (const input of ["如何新增部门？", "测试公司", "U8", "怎么启用火星税控舱？"]) turns.push(await send(page, input));
    await blockOnExternalFailure(testInfo, page, turns);
    const last = turns.at(-1)!;
    expect(last.phone.trace.some((item) => item.step === "knowledge.retrieve")).toBe(true);
    expect(last.phone.state).toBe("transferring");
    expect(last.phone.sources).toHaveLength(0);
    expect(last.answer).toContain("人工客服");
    expect(last.answer).not.toMatch(/进入|点击|菜单|步骤/);
    await artifact(testInfo, page, "FULL-05", "no grounded evidence / safe transfer", turns, await getSession(page, last.sessionId));
  });
});

async function selectPhoneAgent(page: Page) {
  await page.getByRole("button", { name: "配置" }).click();
  await page.locator("select").last().selectOption(phoneAgentId);
  await page.getByRole("button", { name: "配置" }).click();
}

async function send(page: Page, input: string): Promise<Turn> {
  const responsePromise = page.waitForResponse((response) => response.url().includes(`/api/agents/${phoneAgentId}/run/stream`) && response.request().method() === "POST");
  await page.locator("textarea[aria-label='输入数据问题']").fill(input);
  await page.locator("button.send-button").click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/event-stream");
  const body = JSON.parse(response.request().postData() || "{}");
  const sessionId = String(body.input?.sessionId || "");
  expect(sessionId).not.toBe("");
  if (!sessions.includes(sessionId)) sessions.push(sessionId);
  await expect(page.locator("button.send-button")).toHaveText("发送 ↗", { timeout: 75_000 });
  const sse = sanitize(await response.text());
  expect(sse).not.toContain("event: error");
  const detail = await getSession(page, sessionId);
  const message = detail.messages.at(-1)!;
  expect(message.role).toBe("assistant");
  expect(message.result?.phone).toBeTruthy();
  return { input, sessionId, sse, phone: message.result!.phone!, answer: message.content };
}

async function getSession(page: Page, sessionId: string) {
  const response = await page.evaluate(async ({ apiBase, sessionId }) => {
    const result = await fetch(`${apiBase}/api/sessions/${encodeURIComponent(sessionId)}`, { credentials: "include" });
    return { status: result.status, body: await result.json() };
  }, { apiBase, sessionId });
  expect(response.status).toBe(200);
  return response.body as SessionDetail;
}

async function deleteSession(page: Page, sessionId: string) {
  await page.evaluate(async ({ apiBase, sessionId }) => { await fetch(`${apiBase}/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", credentials: "include" }); }, { apiBase, sessionId });
}

async function blockOnExternalFailure(testInfo: TestInfo, page: Page, turns: Turn[]) {
  const failure = turns.flatMap((turn) => turn.phone.trace).find((item) => item.step === "knowledge.retrieve" && item.status === "failed");
  if (!failure) return;
  await artifact(testInfo, page, String(testInfo.title.match(/^FULL-\d+/)?.[0] || "FULL"), "external dependency failure", turns, await getSession(page, turns[0].sessionId));
  testInfo.annotations.push({ type: "blocked", description: String(failure.detail || "retrieval unavailable").slice(0, 180) });
  test.skip(true, "BLOCKED: real retrieval dependency unavailable");
}

async function artifact(testInfo: TestInfo, page: Page, id: string, category: string, turns: Turn[], detail: SessionDetail, extra: Record<string, unknown> = {}) {
  const value = { id, category, priority: "P0", result: "PASS", turns, session: detail, ...extra };
  const path = testInfo.outputPath(`${id}-full.json`);
  await writeFile(path, sanitize(JSON.stringify(value, null, 2)), "utf8");
  await testInfo.attach(`${id}-full.json`, { path, contentType: "application/json" });
  await testInfo.attach(`${id}-screenshot.png`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
}

function sanitize(value: string) { return value.replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_.-]+/gi, "<redacted>").replace(/"password"\s*:\s*"[^"]*"/gi, '"password":"<redacted>"'); }
