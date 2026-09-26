import assert from "node:assert/strict";
import test from "node:test";
import { loadQueryHistory, type HistoryStorage } from "../../components/datapilot/query-history-storage.js";

class MemoryStorage implements HistoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test("bootstrap admin inherits legacy query history without deleting the source", () => {
  const storage = new MemoryStorage();
  const legacy = [{ id: "legacy-1", question: "旧问题" }];
  const defaultUserLegacy = [{ id: "legacy-2", question: "旧默认用户问题" }];
  storage.setItem("datapilot-history", JSON.stringify(legacy));
  storage.setItem("datapilot-history:local-admin", JSON.stringify(defaultUserLegacy));
  const migrated = loadQueryHistory(storage, { id: "admin-1", isBootstrapAdmin: true });
  assert.deepEqual(migrated, [...legacy, ...defaultUserLegacy]);
  assert.equal(storage.getItem("datapilot-history"), JSON.stringify(legacy));
  assert.equal(storage.getItem("datapilot-history:local-admin"), JSON.stringify(defaultUserLegacy));
  assert.deepEqual(JSON.parse(storage.getItem("datapilot-history:admin-1")!), [...legacy, ...defaultUserLegacy]);
});

test("legacy history migration runs only once", () => {
  const storage = new MemoryStorage();
  storage.setItem("datapilot-history", JSON.stringify([{ id: "legacy-1" }]));
  loadQueryHistory(storage, { id: "admin-1", isBootstrapAdmin: true });
  storage.setItem("datapilot-history", JSON.stringify([{ id: "legacy-1" }, { id: "late-legacy" }]));
  assert.deepEqual(loadQueryHistory(storage, { id: "admin-1", isBootstrapAdmin: true }), [{ id: "legacy-1" }]);
  assert.ok(storage.getItem("datapilot-history:migrated:admin-1"));
});

test("non-bootstrap users cannot see legacy or bootstrap-admin history", () => {
  const storage = new MemoryStorage();
  storage.setItem("datapilot-history", JSON.stringify([{ id: "legacy-1" }]));
  storage.setItem("datapilot-history:admin-1", JSON.stringify([{ id: "admin-only" }]));
  storage.setItem("datapilot-history:user-2", JSON.stringify([{ id: "user-2-only" }]));
  assert.deepEqual(loadQueryHistory(storage, { id: "user-2", isBootstrapAdmin: false }), [{ id: "user-2-only" }]);
});
