import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fallbackDatasourceId } from "../../components/datapilot/datasource-selection.js";

const connected = source("connected", "connected");
const offline = source("offline", "offline");
const selectorSource = readFileSync(new URL("../../components/datapilot/datasource-switcher.tsx", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");

test("datasource fallback preserves a valid active source", () => {
  assert.equal(fallbackDatasourceId([connected, offline], offline.id), offline.id);
});

test("datasource fallback selects the first connected source", () => {
  assert.equal(fallbackDatasourceId([offline, connected], "deleted"), connected.id);
});

test("datasource fallback remains empty when only offline sources exist", () => {
  assert.equal(fallbackDatasourceId([offline], "deleted"), "");
});

test("switcher renders every datasource with connected and offline states", () => {
  assert.match(selectorSource, /sources\.map/);
  assert.match(selectorSource, /source\.status/);
  assert.match(selectorSource, /connected.*已连接.*未连接/s);
});

test("switcher marks the current datasource as selected", () => {
  assert.match(selectorSource, /role="option"/);
  assert.match(selectorSource, /aria-selected=\{selected\}/);
  assert.match(selectorSource, /selected \? "✓"/);
});

test("selection and dismissal behavior is wired", () => {
  assert.match(selectorSource, /onSelect\(source\); setOpen\(false\)/);
  assert.match(selectorSource, /pointerdown/);
  assert.match(selectorSource, /event\.key === "Escape"/);
});

test("query requests continue to use the active datasource connection id", () => {
  assert.match(pageSource, /connectionId: activeSource\.connectionId/);
  assert.match(pageSource, /setActiveSourceId\(source\.id\)/);
  assert.match(pageSource, /activeSource\.status !== "connected"/);
});

test("empty datasource state exposes the datasource management entry", () => {
  assert.match(selectorSource, /未选择数据源/);
  assert.match(selectorSource, /暂无可用数据源/);
  assert.match(selectorSource, /onManageSources\(\)/);
});

function source(id: string, status: "connected" | "offline") {
  return { id, connectionId: id, name: id, engine: "MySQL 8", host: "localhost:3306", database: id, tables: 0, status, sshEnabled: false };
}
