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

test("sidebar user entry exposes personal center, guarded admin center, logout, and account deletion", () => {
  assert.match(page, /<UserAccountMenu/);
  assert.match(accountUi, /个人中心/);
  assert.match(accountUi, /user\.canManageTenant && <button role="menuitem"[\s\S]*?管理员中心/);
  assert.match(accountUi, /退出登录/);
  assert.match(accountUi, /注销账户/);
});

test("personal and admin centers expose role-specific sections", () => {
  assert.match(accountUi, /个人资料/);
  assert.match(accountUi, /账号信息/);
  assert.match(accountUi, /修改密码/);
  assert.match(accountUi, /我的团队/);
  assert.match(accountUi, /创建团队/);
  assert.match(accountUi, /成员管理/);
  assert.match(accountUi, /邀请成员/);
  assert.match(accountUi, /角色与权限/);
  assert.match(accountUi, /user\.isRoot && <><span[\s\S]*?所有租户[\s\S]*?所有用户[\s\S]*?平台级管理/);
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
