import { expect, test, type Page } from "@playwright/test";

const agentId = "builtin.phone-support";
const apiBase = process.env.DATAPILOT_E2E_API_URL || "http://localhost:3001";
type Phone = { state: string; currentTopic?: string; rewrittenQuery: string; sources: { content?: string }[]; policy: { action: string } };
type Turn = { sessionId: string; phone: Phone; answer: string };

let sessions: string[] = [];

test.describe.serial("PDF bad cases - real test account", () => {
  test.beforeEach(async ({ page }) => {
    sessions = [];
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("textarea[aria-label='输入数据问题']")).toBeVisible();
    await page.getByRole("button", { name: "配置" }).click();
    await page.locator("select").last().selectOption(agentId);
    await page.getByRole("button", { name: "配置" }).click();
  });

  test.afterEach(async ({ page }) => {
    await Promise.all(sessions.map((sessionId) => page.evaluate(async ({ apiBase, sessionId }) => {
      await fetch(`${apiBase}/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", credentials: "include" });
    }, { apiBase, sessionId })));
  });

  test("PDF-01 · 账套备份后追问删除与凭证删除", async ({ page }) => {
    await send(page, "账套怎么备份");
    await send(page, "上海企通");
    await send(page, "T3");
    const deleted = await send(page, "那么怎么删除呢");
    expect(deleted.phone.currentTopic || "").toMatch(/账套.*删除|删除.*账套/);
    expect(deleted.phone.rewrittenQuery, JSON.stringify(deleted.phone, null, 2)).toMatch(/账套.*删除|删除.*账套/);
    expect(deleted.phone.rewrittenQuery).not.toContain("备份");
    expect(JSON.stringify(deleted.phone.sources)).toContain("删除当前输出账套");

    const voucher = await send(page, "凭证可以删除吗");
    expect(voucher.phone.state).toBe("answering");
    expect(JSON.stringify(voucher.phone.sources)).toContain("未记账");
  });

  test("PDF-02 · 报表模板与发票自动生成凭证", async ({ page }) => {
    await send(page, "这个月的报表不对，需要处理");
    await send(page, "上海企通");
    const recalculation = await send(page, "U8");
    expect(["answering", "transferring"]).toContain(recalculation.phone.state);
    const reportEvidence = JSON.stringify(recalculation.phone.sources);
    expect(reportEvidence, JSON.stringify(recalculation.phone, null, 2)).not.toContain("导出Excel");
    if (recalculation.phone.state === "answering") expect(reportEvidence).toContain("重新计算");

    const unresolved = await send(page, "重新计算了，数据还是不对");
    expect(["answering", "transferring"]).toContain(unresolved.phone.state);

    const latestTemplate = await send(page, "可以给我发一份最新的报表模板吗");
    expect(latestTemplate.phone.state, JSON.stringify(latestTemplate.phone, null, 2)).toBe("transferring");
    expect(latestTemplate.phone.sources).toHaveLength(0);

    const newComputer = await send(page, "我这台是新的电脑，没有报表模板，可以给我发一份吗");
    expect(newComputer.phone.state, JSON.stringify(newComputer.phone, null, 2)).toBe("answering");
    expect(JSON.stringify(newComputer.phone.sources)).toContain("复制到新电脑上");

    const unsupportedProduct = await send(page, "发票怎么可以生成凭证");
    expect(unsupportedProduct.phone.state).toBe("transferring");

    const invoice = await send(page, "易代账的发票怎么自动生成凭证");
    expect(invoice.phone.currentTopic).toBe("易代账的发票怎么自动生成凭证");
    expect(invoice.phone.rewrittenQuery).toBe("易代账的发票怎么自动生成凭证");
    expect(JSON.stringify(invoice.phone.sources)).toContain("税务数字账户");
  });

  test("PDF-03 · 用户、操作员、公司和关账", async ({ page }) => {
    await send(page, "怎么增加一个用户");
    await send(page, "上海企通");
    const user = await send(page, "T3");
    expect(user.phone.currentTopic).toBe("怎么增加一个用户");
    expect(JSON.stringify(user.phone.sources)).toContain("编号、姓名、密码");

    const operator = await send(page, "怎么增加操作员");
    expect(operator.phone.state).toBe("answering");
    expect(JSON.stringify(operator.phone.sources)).toContain("编号、姓名、密码");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "配置" }).click();
    await page.locator("select").last().selectOption(agentId);
    await page.getByRole("button", { name: "配置" }).click();
    await send(page, "怎么在系统里新增一个公司");
    await send(page, "上海企通");
    const company = await send(page, "好会计");
    expect(company.phone.currentTopic).toBe("怎么在系统里新增一个公司");
    expect(JSON.stringify(company.phone.sources)).toContain("输入公司名称");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "配置" }).click();
    await page.locator("select").last().selectOption(agentId);
    await page.getByRole("button", { name: "配置" }).click();
    await send(page, "怎么关账");
    await send(page, "上海企通");
    const closing = await send(page, "T+");
    expect(closing.phone.currentTopic).toBe("怎么关账");
    expect(closing.phone.state).toBe("answering");
    expect(JSON.stringify(closing.phone.sources), JSON.stringify(closing.phone, null, 2)).toContain("系统管理-财务结账");
  });
});

async function send(page: Page, input: string): Promise<Turn> {
  const responsePromise = page.waitForResponse((response) => response.url().includes(`/api/agents/${agentId}/run/stream`) && response.request().method() === "POST");
  await page.locator("textarea[aria-label='输入数据问题']").fill(input);
  await page.locator("button.send-button").click();
  const response = await responsePromise;
  const request = JSON.parse(response.request().postData() || "{}");
  const sessionId = String(request.input?.sessionId || "");
  expect(sessionId).not.toBe("");
  if (!sessions.includes(sessionId)) sessions.push(sessionId);
  const body = await response.text();
  const done = [...body.matchAll(/event: done\s*\ndata: (.+)/g)].at(-1)?.[1];
  expect(done).toBeTruthy();
  const output = JSON.parse(done!).result.output as { answer: string; sessionId: string; state: string; currentTopic?: string; rewrittenQuery: string; sources: { content?: string }[]; policy: { action: string } };
  return { sessionId: output.sessionId, phone: output, answer: output.answer };
}
