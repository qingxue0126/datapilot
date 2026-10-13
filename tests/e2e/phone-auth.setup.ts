import { chromium, type FullConfig } from "@playwright/test";
import { access, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const statePath = "tmp/playwright-phone-auth.json";

export default async function globalSetup(config: FullConfig) {
  const username = process.env.DATAPILOT_E2E_USERNAME;
  const password = process.env.DATAPILOT_E2E_PASSWORD;
  if (!username || !password) {
    try {
      await access(statePath);
      const browser = await chromium.launch({ channel: "msedge", headless: true });
      try {
        const context = await browser.newContext({ baseURL: config.projects[0]?.use.baseURL as string, storageState: statePath });
        const page = await context.newPage();
        await page.goto("/", { waitUntil: "domcontentloaded" });
        if (await page.locator(".auth-card").isVisible()) throw new Error("saved login expired");
        await context.close();
        return;
      } finally { await browser.close(); }
    } catch {
      throw new Error("DATAPILOT_E2E_USERNAME 和 DATAPILOT_E2E_PASSWORD 必须在本地环境中提供，或保留仍有效的 tmp/playwright-phone-auth.json");
    }
  }

  await mkdir(dirname(statePath), { recursive: true });
  const browser = await chromium.launch({ channel: "msedge", headless: process.env.DATAPILOT_E2E_HEADED !== "1" });
  try {
    const context = await browser.newContext({ baseURL: config.projects[0]?.use.baseURL as string });
    const page = await context.newPage();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator("input[name=identifier]").fill(username);
    await page.locator("input[name=password]").fill(password);
    await page.locator("button.auth-submit").click();
    await page.locator(".auth-card").waitFor({ state: "detached", timeout: 20_000 });
    await context.storageState({ path: statePath });
    await context.close();
  } finally {
    await browser.close();
  }
}
