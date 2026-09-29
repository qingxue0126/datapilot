import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccountStore, AuthError } from "./account-store.js";
import { EnvironmentIdentityProvider } from "./identity-provider.js";
import { PermissionService } from "./permission-service.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "datapilot-auth-"));
  const path = join(directory, "accounts.json");
  return { path, store: new AccountStore(path), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("registration succeeds and password is stored as a bcrypt hash", async () => {
  const item = fixture();
  try {
    const result = await item.store.register("Admin@example.com", "Secure123", "Secure123");
    assert.equal(result.user.email, "admin@example.com");
    const persisted = readFileSync(item.path, "utf8");
    assert.doesNotMatch(persisted, /Secure123/);
    assert.match(persisted, /\$2[aby]\$/);
  } finally { item.cleanup(); }
});

test("duplicate active user is rejected", async () => {
  const item = fixture();
  try {
    await item.store.register("analyst", "Secure123", "Secure123");
    await assert.rejects(() => item.store.register("ANALYST", "Secure456", "Secure456"), (error: AuthError) => error.status === 409);
  } finally { item.cleanup(); }
});

test("wrong password is rejected and correct login succeeds", async () => {
  const item = fixture();
  try {
    await item.store.register("analyst", "Secure123", "Secure123");
    await assert.rejects(() => item.store.login("analyst", "Wrong123"), (error: AuthError) => error.status === 401);
    const login = await item.store.login("analyst", "Secure123");
    assert.equal(login.user.username, "analyst");
  } finally { item.cleanup(); }
});

test("session persists across store instances and logout invalidates it", async () => {
  const item = fixture();
  try {
    const registered = await item.store.register("persistent", "Secure123", "Secure123");
    const reloaded = new AccountStore(item.path);
    assert.equal(reloaded.authenticate(registered.token).user.username, "persistent");
    reloaded.logout(registered.token);
    assert.throws(() => reloaded.authenticate(registered.token), (error: AuthError) => error.status === 401);
  } finally { item.cleanup(); }
});

test("API keys store only a hash and restore their bound tenant identity", async () => {
  const item = fixture();
  try {
    const registered = await item.store.register("api-owner", "Secure123", "Secure123");
    const created = item.store.createApiKey(registered.token, "RAGFlow");
    assert.match(created.key, /^dp_[A-Za-z0-9_-]{32,}$/);
    const persisted = readFileSync(item.path, "utf8");
    assert.doesNotMatch(persisted, new RegExp(created.key));
    const context = item.store.authenticateApiKey(created.key);
    assert.equal(context.tenantId, registered.user.tenantId);
    assert.match(context.sessionId, /^api-key:/);
    assert.ok(item.store.listApiKeys(registered.token)[0].lastUsedAt);
    item.store.setApiKeyEnabled(registered.token, created.apiKey.id, false);
    assert.throws(() => item.store.authenticateApiKey(created.key), (error: AuthError) => error.status === 401);
    item.store.setApiKeyEnabled(registered.token, created.apiKey.id, true);
    item.store.revokeApiKey(registered.token, created.apiKey.id);
    assert.throws(() => item.store.authenticateApiKey(created.key), (error: AuthError) => error.status === 401);
  } finally { item.cleanup(); }
});

test("unauthenticated identity resolution is rejected", () => {
  const item = fixture();
  try {
    const identities = new EnvironmentIdentityProvider(item.store);
    const request = { header: () => undefined };
    assert.throws(() => identities.resolve(request as never), (error: AuthError) => error.status === 401);
  } finally { item.cleanup(); }
});

test("deleted account is soft-deleted, sessions are revoked, and login is refused", async () => {
  const item = fixture();
  try {
    const registered = await item.store.register("departing", "Secure123", "Secure123");
    item.store.deleteAccount(registered.token);
    assert.throws(() => item.store.authenticate(registered.token), (error: AuthError) => error.status === 401);
    await assert.rejects(() => item.store.login("departing", "Secure123"), (error: AuthError) => error.status === 401);
    const persisted = JSON.parse(readFileSync(item.path, "utf8"));
    assert.equal(persisted.accounts[0].status, "deleted");
    assert.ok(persisted.accounts[0].deletedAt);
  } finally { item.cleanup(); }
});

test("registered accounts receive isolated tenant and account-set contexts", async () => {
  const item = fixture();
  try {
    const first = await item.store.register("tenant-a", "Secure123", "Secure123");
    const second = await item.store.register("tenant-b", "Secure123", "Secure123");
    const firstContext = item.store.authenticate(first.token).context;
    const secondContext = item.store.authenticate(second.token).context;
    assert.equal(item.store.authenticate(first.token).user.isBootstrapAdmin, true);
    assert.equal(item.store.authenticate(second.token).user.isBootstrapAdmin, false);
    assert.notEqual(firstContext.tenantId, secondContext.tenantId);
    assert.notEqual(firstContext.accountSetId, secondContext.accountSetId);
    assert.notEqual(firstContext.userId, secondContext.userId);
    assert.ok(new PermissionService().policy(firstContext).capabilities.includes("connection:manage"));
  } finally { item.cleanup(); }
});

test("member, owner, and root receive the expected account-center permissions", async () => {
  const item = fixture();
  try {
    const root = await item.store.register("root-admin", "Secure123", "Secure123");
    const owner = await item.store.register("team-owner", "Secure123", "Secure123");
    const member = await item.store.register("ordinary-member", "Secure123", "Secure123");
    assert.equal(item.store.accountCenter(root.token).user.isRoot, true);
    assert.equal(item.store.accountCenter(root.token).admin?.scope, "platform");
    assert.equal(item.store.accountCenter(owner.token).user.role, "tenant_owner");
    assert.equal(item.store.accountCenter(owner.token).admin?.scope, "tenant");

    item.store.inviteMember(root.token, { identifier: "ordinary-member", role: "finance_viewer" });
    item.store.switchTeam(member.token, root.user.tenantId);
    const memberCenter = item.store.accountCenter(member.token);
    assert.equal(memberCenter.user.role, "finance_viewer");
    assert.equal(memberCenter.user.canManageTenant, false);
    assert.equal(memberCenter.admin, undefined);
    assert.throws(() => item.store.createTeam(member.token, "越权团队"), (error: AuthError) => error.status === 403);
  } finally { item.cleanup(); }
});

test("team switching is limited to memberships and owner management stays tenant-scoped", async () => {
  const item = fixture();
  try {
    const root = await item.store.register("root-admin", "Secure123", "Secure123");
    const owner = await item.store.register("owner-two", "Secure123", "Secure123");
    assert.throws(() => item.store.switchTeam(owner.token, root.user.tenantId), (error: AuthError) => error.status === 403);
    assert.throws(() => item.store.inviteMember(owner.token, { identifier: "someone", tenantId: root.user.tenantId }), (error: AuthError) => error.status === 403);

    item.store.inviteMember(root.token, { identifier: "owner-two", role: "finance_analyst" });
    const switched = item.store.switchTeam(owner.token, root.user.tenantId);
    assert.equal(switched.user.tenantId, root.user.tenantId);
    assert.equal(item.store.authenticate(owner.token).context.tenantId, root.user.tenantId);
  } finally { item.cleanup(); }
});
