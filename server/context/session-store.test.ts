import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RequestContext } from "../core/types.js";
import { SessionStoreError, SqliteSessionStore } from "./session-store.js";

const alice: RequestContext = { tenantId: "tenant-a", accountSetId: "books-a", userId: "alice", role: "tenant_admin", sessionId: "auth-a" };
const bob: RequestContext = { ...alice, userId: "bob", sessionId: "auth-b" };
const otherTenant: RequestContext = { ...alice, tenantId: "tenant-b", sessionId: "auth-c" };
const otherAccountSet: RequestContext = { ...alice, accountSetId: "books-b", sessionId: "auth-d" };

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "datapilot-sessions-"));
  const path = join(directory, "sessions.sqlite");
  const store = new SqliteSessionStore(path, 2);
  return { path, directory, store, cleanup: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function result(question: string, sql = "SELECT 1") {
  return { question, summary: `回答：${question}`, sql, rows: [], columns: [], rowCount: 0, executionMs: 1 };
}

test("sessions and messages persist and the first question creates a short title", () => {
  const item = fixture();
  try {
    const session = item.store.create(alice, { datasourceId: "source-a" });
    const saved = item.store.appendExchange(alice, session.id, {
      question: "请分析2026年9月营业收入变化趋势？", answer: "已完成分析", datasourceId: "source-a",
      result: result("请分析2026年9月营业收入变化趋势？"),
    });
    item.store.appendExchange(alice, session.id, { question: "和8月相比呢？", answer: "环比分析", datasourceId: "source-a", result: result("和8月相比呢？") });
    item.store.appendExchange(alice, session.id, { question: "按部门拆分", answer: "部门分析", datasourceId: "source-a", result: result("按部门拆分") });
    assert.equal(saved.messages.length, 2);
    assert.equal(saved.session.title, "请分析2026年9月营业收入变化趋势");
    assert.equal(saved.session.pinned, false);
    item.store.update(alice, session.id, { pinned: true });
    item.store.close();
    const reloaded = new SqliteSessionStore(item.path);
    try {
      const detail = reloaded.get(alice, session.id);
      assert.equal(detail.messages.length, 6);
      assert.equal(detail.session.title, "请分析2026年9月营业收入变化趋势");
      assert.equal(detail.session.pinned, true);
      assert.equal(detail.messages[1].result?.sql, "SELECT 1");
    } finally { reloaded.close(); }
    rmSync(item.directory, { recursive: true, force: true });
  } catch (error) { try { item.cleanup(); } catch { /* already closed */ } throw error; }
});

test("session reads, updates, deletes, and history are isolated by tenant/account-set/user", () => {
  const item = fixture();
  try {
    const session = item.store.create(alice);
    for (const question of ["第一问", "第二问", "第三问"]) {
      item.store.appendExchange(alice, session.id, { question, answer: `${question}答案`, datasourceId: "source-a", result: result(question) });
    }
    assert.deepEqual(item.store.history(alice, session.id).map((turn) => turn.question), ["第二问", "第三问"]);
    assert.equal(item.store.list(alice).length, 1);
    assert.equal(item.store.list(bob).length, 0);
    for (const context of [bob, otherTenant, otherAccountSet]) {
      assert.throws(() => item.store.get(context, session.id), (error: SessionStoreError) => error.status === 404);
      assert.throws(() => item.store.update(context, session.id, { title: "越权" }), (error: SessionStoreError) => error.status === 404);
      assert.throws(() => item.store.update(context, session.id, { pinned: true }), (error: SessionStoreError) => error.status === 404);
      assert.throws(() => item.store.delete(context, session.id), (error: SessionStoreError) => error.status === 404);
    }
    item.store.update(alice, session.id, { title: "手动标题" });
    item.store.appendExchange(alice, session.id, { question: "不会覆盖", answer: "答案", datasourceId: "source-a", result: result("不会覆盖") });
    assert.equal(item.store.get(alice, session.id).session.title, "手动标题");
    item.store.delete(alice, session.id);
    assert.equal(item.store.list(alice).length, 0);
  } finally { item.cleanup(); }
});

test("different sessions never share model context", () => {
  const item = fixture();
  try {
    const first = item.store.create(alice);
    const second = item.store.create(alice);
    item.store.appendExchange(alice, first.id, { question: "只属于会话一", answer: "一", datasourceId: "source-a", result: result("只属于会话一") });
    item.store.appendExchange(alice, second.id, { question: "只属于会话二", answer: "二", datasourceId: "source-a", result: result("只属于会话二") });
    assert.deepEqual(item.store.history(alice, first.id).map((turn) => turn.question), ["只属于会话一"]);
    assert.deepEqual(item.store.history(alice, second.id).map((turn) => turn.question), ["只属于会话二"]);
  } finally { item.cleanup(); }
});
