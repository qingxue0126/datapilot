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
