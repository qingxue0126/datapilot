import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const cli = resolve("node_modules", "@playwright", "test", "cli.js");
const result = spawnSync(process.execPath, [cli, "test", "-c", "playwright.phone.config.ts", "tests/e2e/phone-support.spec.ts", "tests/e2e/phone-dialogue.spec.ts", "tests/e2e/phone-full.spec.ts", "tests/e2e/phone-pdf-bad-cases.spec.ts"], {
  stdio: "inherit",
  env: {
    ...process.env,
    DATAPILOT_PHONE_REPORT_DIR: resolve("reports", "tests", "e2e"),
    DATAPILOT_PHONE_REPORT_PREFIX: "phone-full",
  },
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
