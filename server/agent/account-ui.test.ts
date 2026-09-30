import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
const accountUi = readFileSync(new URL("../../components/datapilot/account-access.tsx", import.meta.url), "utf8");

test("anonymous users receive login and registration controls", () => {
  assert.match(page, /<AuthScreen/);
  assert.match(accountUi, /src="\/datapilot-logo\.png"/);
  assert.match(accountUi, /欢迎回来/);
  assert.match(accountUi, /创建账户/);
});

test("sidebar user entry exposes personal center, invitation-aware admin center, logout, and account deletion", () => {
  assert.match(page, /<UserAccountMenu/);
  assert.match(accountUi, /个人中心/);
  assert.match(accountUi, /<button role="menuitem"[\s\S]*?管理员中心/);
  assert.match(accountUi, /退出登录/);
  assert.match(accountUi, /注销账户/);
});

test("personal and admin centers expose role-specific sections", () => {
  assert.match(accountUi, /个人信息/);
  assert.match(accountUi, /修改密码/);
  assert.match(accountUi, /我的组织/);
  assert.match(accountUi, /组织邀请/);
  assert.match(accountUi, /组织管理/);
  assert.match(accountUi, /用户管理/);
  assert.match(accountUi, /邀请用户/);
  assert.match(accountUi, /API Key/);
  assert.match(accountUi, /\/api\/auth\/api-keys/);
  assert.match(accountUi, /完整值只显示一次/);
});

test("team switch delegates to the server and refreshes the active application context", () => {
  assert.match(accountUi, /\/api\/auth\/teams\/switch/);
  assert.match(page, /accountContextChanged/);
  assert.match(page, /currentUser\?\.tenantId !== user\.tenantId/);
});

test("account deletion requires explicit second confirmation", () => {
  assert.match(accountUi, /confirmation !== "DELETE"/);
  assert.match(accountUi, /永久注销账户/);
});

test("all application API calls include cookie credentials", () => {
  assert.match(page, /credentials: "include"/);
  assert.doesNotMatch(page.replace(/function apiFetch[\s\S]*?\n}/, ""), /fetch\(/);
});

test("session bootstrap retries and handles an unavailable API", () => {
  assert.match(page, /apiFetchWithRetry\("\/api\/auth\/me"\)/);
  assert.match(page, /catch \(caught\) \{/);
  assert.match(page, /无法连接 DataPilot API/);
});
