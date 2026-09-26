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

test("sidebar user entry exposes profile, logout, and account deletion", () => {
  assert.match(page, /<UserAccountMenu/);
  assert.match(accountUi, /个人信息/);
  assert.match(accountUi, /退出登录/);
  assert.match(accountUi, /注销账户/);
});

test("account deletion requires explicit second confirmation", () => {
  assert.match(accountUi, /confirmation !== "DELETE"/);
  assert.match(accountUi, /永久注销账户/);
});

test("all application API calls include cookie credentials", () => {
  assert.match(page, /credentials: "include"/);
  assert.doesNotMatch(page.replace(/function apiFetch[\s\S]*?\n}/, ""), /fetch\(/);
});
