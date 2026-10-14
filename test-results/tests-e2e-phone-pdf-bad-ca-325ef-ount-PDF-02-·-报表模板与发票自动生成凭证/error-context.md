# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests\e2e\phone-pdf-bad-cases.spec.ts >> PDF bad cases - real test account >> PDF-02 · 报表模板与发票自动生成凭证
- Location: tests\e2e\phone-pdf-bad-cases.spec.ts:40:3

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/", waiting until "domcontentloaded"

```

# Test source

```ts
  1   | import { expect, test, type Page } from "@playwright/test";
  2   | 
  3   | const agentId = "builtin.phone-support";
  4   | const apiBase = process.env.DATAPILOT_E2E_API_URL || "http://localhost:3001";
  5   | type Phone = { state: string; currentTopic?: string; rewrittenQuery: string; sources: { content?: string }[]; policy: { action: string } };
  6   | type Turn = { sessionId: string; phone: Phone; answer: string };
  7   | 
  8   | let sessions: string[] = [];
  9   | 
  10  | test.describe.serial("PDF bad cases - real test account", () => {
  11  |   test.beforeEach(async ({ page }) => {
  12  |     sessions = [];
> 13  |     await page.goto("/", { waitUntil: "domcontentloaded" });
      |                ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  14  |     await expect(page.locator("textarea[aria-label='输入数据问题']")).toBeVisible();
  15  |     await page.getByRole("button", { name: "配置" }).click();
  16  |     await page.locator("select").last().selectOption(agentId);
  17  |     await page.getByRole("button", { name: "配置" }).click();
  18  |   });
  19  | 
  20  |   test.afterEach(async ({ page }) => {
  21  |     await Promise.all(sessions.map((sessionId) => page.evaluate(async ({ apiBase, sessionId }) => {
  22  |       await fetch(`${apiBase}/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", credentials: "include" });
  23  |     }, { apiBase, sessionId })));
  24  |   });
  25  | 
  26  |   test("PDF-01 · 账套备份后追问删除与凭证删除", async ({ page }) => {
  27  |     await send(page, "账套怎么备份");
  28  |     await send(page, "上海企通");
  29  |     await send(page, "T3");
  30  |     const deleted = await send(page, "那么怎么删除呢");
  31  |     expect(deleted.phone.currentTopic).toBe("删除账套");
  32  |     expect(deleted.phone.rewrittenQuery, JSON.stringify(deleted.phone, null, 2)).toBe("T3软件如何删除账套？");
  33  |     expect(JSON.stringify(deleted.phone.sources)).toContain("删除当前输出账套");
  34  | 
  35  |     const voucher = await send(page, "凭证可以删除吗");
  36  |     expect(voucher.phone.state).toBe("answering");
  37  |     expect(JSON.stringify(voucher.phone.sources)).toContain("未记账");
  38  |   });
  39  | 
  40  |   test("PDF-02 · 报表模板与发票自动生成凭证", async ({ page }) => {
  41  |     await send(page, "这个月的报表不对，需要处理");
  42  |     await send(page, "上海企通");
  43  |     const recalculation = await send(page, "U8");
  44  |     expect(JSON.stringify(recalculation.phone.sources), JSON.stringify(recalculation.phone, null, 2)).toContain("重新计算");
  45  | 
  46  |     const unresolved = await send(page, "重新计算了，数据还是不对");
  47  |     expect(["answering", "transferring"]).toContain(unresolved.phone.state);
  48  | 
  49  |     const latestTemplate = await send(page, "可以给我发一份最新的报表模板吗");
  50  |     expect(latestTemplate.phone.state).toBe("transferring");
  51  |     expect(latestTemplate.phone.sources).toHaveLength(0);
  52  | 
  53  |     const newComputer = await send(page, "我这台是新的电脑，没有报表模板，可以给我发一份吗");
  54  |     expect(newComputer.phone.state).toBe("answering");
  55  |     expect(JSON.stringify(newComputer.phone.sources)).toContain("复制到新电脑上");
  56  | 
  57  |     const unsupportedProduct = await send(page, "发票怎么可以生成凭证");
  58  |     expect(unsupportedProduct.phone.state).toBe("transferring");
  59  | 
  60  |     const invoice = await send(page, "易代账的发票怎么自动生成凭证");
  61  |     expect(invoice.phone.currentTopic).toBe("发票生成凭证");
  62  |     expect(invoice.phone.rewrittenQuery).toBe("易代账软件发票如何自动生成凭证？");
  63  |     expect(JSON.stringify(invoice.phone.sources)).toContain("税务数字账户");
  64  |   });
  65  | 
  66  |   test("PDF-03 · 用户、操作员、公司和关账", async ({ page }) => {
  67  |     await send(page, "怎么增加一个用户");
  68  |     await send(page, "上海企通");
  69  |     const user = await send(page, "T3");
  70  |     expect(user.phone.currentTopic).toBe("新增操作人员");
  71  |     expect(JSON.stringify(user.phone.sources)).toContain("编号、姓名、密码");
  72  | 
  73  |     const operator = await send(page, "怎么增加操作员");
  74  |     expect(operator.phone.state).toBe("answering");
  75  |     expect(JSON.stringify(operator.phone.sources)).toContain("编号、姓名、密码");
  76  | 
  77  |     await page.reload({ waitUntil: "domcontentloaded" });
  78  |     await page.getByRole("button", { name: "配置" }).click();
  79  |     await page.locator("select").last().selectOption(agentId);
  80  |     await page.getByRole("button", { name: "配置" }).click();
  81  |     await send(page, "怎么在系统里新增一个公司");
  82  |     await send(page, "上海企通");
  83  |     const company = await send(page, "好会计");
  84  |     expect(company.phone.currentTopic).toBe("新增账套");
  85  |     expect(JSON.stringify(company.phone.sources)).toContain("输入公司名称");
  86  | 
  87  |     await page.reload({ waitUntil: "domcontentloaded" });
  88  |     await page.getByRole("button", { name: "配置" }).click();
  89  |     await page.locator("select").last().selectOption(agentId);
  90  |     await page.getByRole("button", { name: "配置" }).click();
  91  |     await send(page, "怎么关账");
  92  |     await send(page, "上海企通");
  93  |     const closing = await send(page, "T+");
  94  |     expect(closing.phone.currentTopic).toBe("结账");
  95  |     expect(closing.phone.state).toBe("answering");
  96  |     expect(JSON.stringify(closing.phone.sources)).toContain("系统管理-财务结账");
  97  |   });
  98  | });
  99  | 
  100 | async function send(page: Page, input: string): Promise<Turn> {
  101 |   const responsePromise = page.waitForResponse((response) => response.url().includes(`/api/agents/${agentId}/run/stream`) && response.request().method() === "POST");
  102 |   await page.locator("textarea[aria-label='输入数据问题']").fill(input);
  103 |   await page.locator("button.send-button").click();
  104 |   const response = await responsePromise;
  105 |   const request = JSON.parse(response.request().postData() || "{}");
  106 |   const sessionId = String(request.input?.sessionId || "");
  107 |   expect(sessionId).not.toBe("");
  108 |   if (!sessions.includes(sessionId)) sessions.push(sessionId);
  109 |   const body = await response.text();
  110 |   const done = [...body.matchAll(/event: done\s*\ndata: (.+)/g)].at(-1)?.[1];
  111 |   expect(done).toBeTruthy();
  112 |   const output = JSON.parse(done!).result.output as { answer: string; sessionId: string; state: string; currentTopic?: string; rewrittenQuery: string; sources: { content?: string }[]; policy: { action: string } };
  113 |   return { sessionId: output.sessionId, phone: output, answer: output.answer };
```