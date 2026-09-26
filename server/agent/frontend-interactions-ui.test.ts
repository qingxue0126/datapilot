import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
const detail = readFileSync(new URL("../../components/datapilot/datasource-detail.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

test("datasource and history cards support whole-card mouse and keyboard activation", () => {
  assert.match(page, /className=\{`db-card[\s\S]*?role="button"[\s\S]*?tabIndex=\{0\}/);
  assert.match(page, /className="history-item"[\s\S]*?role="button"[\s\S]*?tabIndex=\{0\}/);
  assert.match(page, /event\.key === "Enter" \|\| event\.key === " "/);
});

test("nested card actions do not trigger the parent card action", () => {
  assert.match(page, /className="db-actions"[\s\S]*?event\.stopPropagation\(\)/);
  assert.match(page, /className="history-actions"[\s\S]*?event\.stopPropagation\(\)/);
});

test("visible help control provides an explicit unfinished-feature response", () => {
  assert.match(page, /aria-label="帮助"[\s\S]*?setInteractionNotice\("帮助中心功能开发中"\)/);
  assert.match(page, /className="interaction-toast"[\s\S]*?role="status"/);
});

test("brand and overview entity modules reuse existing navigation logic", () => {
  assert.match(page, /className="brand"[\s\S]*?onClick=\{\(\) => setView\("chat"\)\}/);
  assert.match(detail, /className="entity-chip-grid"[\s\S]*?onClick=\{\(\) => onTab\("mapping"\)\}/);
});

test("interactive surfaces expose hover, active and keyboard focus feedback", () => {
  assert.match(styles, /\.history-item:hover/);
  assert.match(styles, /\.db-card:hover/);
  assert.match(styles, /\.sidebar \.nav-item:hover/);
  assert.match(styles, /\.query-footer \.source-selector:hover/);
  assert.match(styles, /\.primary-action:hover/);
  assert.match(styles, /button:not\(:disabled\):active/);
  assert.match(styles, /\[role="button"\]:focus-visible/);
});
