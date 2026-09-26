import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const componentSource = readFileSync(new URL("../../components/datapilot/current-datasource-shortcut.tsx", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");

test("sidebar shortcut renders the active datasource name", () => {
  assert.match(componentSource, /source\.name/);
});

test("sidebar shortcut renders database and ERP types", () => {
  assert.match(componentSource, /source\?\.engine\.split/);
  assert.match(componentSource, /erpLabel\(source\.insight\?\.erpType\)/);
});

test("sidebar shortcut derives connected and offline states from source status", () => {
  assert.match(componentSource, /source\?\.status === "connected"/);
  assert.match(componentSource, /已连接.*未连接/s);
  assert.match(componentSource, /status-dot.*source\.status/s);
});

test("sidebar shortcut opens the active datasource detail", () => {
  assert.match(pageSource, /CurrentDatasourceShortcut source=\{activeSource\}/);
  assert.match(pageSource, /activeSource \? void openSourceDetail\(activeSource\) : setView\("sources"\)/);
});

test("sidebar shortcut shares the canonical active datasource", () => {
  assert.match(pageSource, /const activeSource = sources\.find\(\(source\) => source\.id === activeSourceId\)/);
  assert.doesNotMatch(componentSource, /useState/);
});

test("active datasource deletion still uses connected-first fallback", () => {
  assert.match(pageSource, /fallbackDatasourceId\(remaining/);
});

test("sidebar shortcut provides the empty datasource state", () => {
  assert.match(componentSource, /未选择数据源/);
  assert.match(componentSource, /点击前往数据源/);
});

test("sidebar shortcut omits mapping and join metrics", () => {
  assert.doesNotMatch(componentSource, /mappingConfidence|joinPaths|unresolvedFields|Validation|实体/);
});
