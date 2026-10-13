import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/phone-auth.setup.ts",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  outputDir: "tmp/e2e-artifacts",
  reporter: [["list"], ["./tests/e2e/phone-dialogue-reporter.ts"], ["html", { outputFolder: "tmp/e2e-playwright", open: "never" }]],
  use: {
    baseURL: process.env.DATAPILOT_E2E_WEB_URL || "http://localhost:3000",
    storageState: "tmp/playwright-phone-auth.json",
    browserName: "chromium",
    channel: "msedge",
    headless: process.env.DATAPILOT_E2E_HEADED !== "1",
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    video: "off",
    trace: "off",
  },
});
