import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
const accountUi = readFileSync(new URL("../../components/datapilot/account-access.tsx", import.meta.url), "utf8");
const apiUi = readFileSync(new URL("../../components/datapilot/api-management.tsx", import.meta.url), "utf8");
const icons = readFileSync(new URL("../../components/datapilot/icons.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

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

test("personal center is a direct profile page with a separate password dialog", () => {
  assert.match(accountUi, /个人信息/);
  assert.match(accountUi, /修改密码/);
  assert.match(accountUi, /personal-center-content/);
  assert.match(accountUi, /password-change-dialog/);
  assert.doesNotMatch(accountUi, /个人中心导航/);
  assert.doesNotMatch(accountUi, /我的组织/);
  assert.doesNotMatch(accountUi, /\/api\/auth\/api-keys/);
  assert.match(styles, /\.personal-center-backdrop \{ inset: 0 0 0 248px;/);
  assert.match(styles, /\.password-dialog-backdrop \{ inset: 0 0 0 248px;/);
});

test("admin center retains organization, user, and invitation management", () => {
  assert.match(accountUi, /组织管理/);
  assert.match(accountUi, /用户管理/);
  assert.match(accountUi, /邀请用户/);
  assert.match(accountUi, /组织邀请/);
});

test("profile and invitation changes refresh the active application context", () => {
  assert.match(accountUi, /onContextChanged\(data\.user\)/);
  assert.match(page, /accountContextChanged/);
  assert.match(page, /currentUser\?\.tenantId !== user\.tenantId/);
});

test("API is a standalone sidebar page with API Key management", () => {
  assert.match(page, /<ApiPlugIcon \/>[\s\S]*API<\/button>/);
  assert.match(page, /view === "api" && <ApiManagement/);
  assert.match(icons, /export function ApiPlugIcon/);
  assert.match(apiUi, /DataPilot API/);
  assert.match(apiUi, /API 服务器/);
  assert.match(apiUi, /\/api\/auth\/api-keys/);
  assert.match(apiUi, /完整密钥仅显示一次/);
  assert.match(apiUi, /创建新密钥/);
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
