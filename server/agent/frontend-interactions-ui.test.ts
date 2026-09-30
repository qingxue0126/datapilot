import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
const detail = readFileSync(new URL("../../components/datapilot/datasource-detail.tsx", import.meta.url), "utf8");
const recent = readFileSync(new URL("../../components/datapilot/recent-analyses.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

test("datasource and session cards support whole-card mouse and keyboard activation", () => {
  assert.match(page, /className=\{`db-card[\s\S]*?role="button"[\s\S]*?tabIndex=\{0\}/);
  assert.match(recent, /className=\{`recent-analysis-item[\s\S]*?role="button"[\s\S]*?tabIndex=/);
  assert.match(recent, /event\.key === "Enter" \|\| event\.key === " "/);
});

test("nested card actions do not trigger the parent card action", () => {
  assert.match(page, /className="db-actions"[\s\S]*?event\.stopPropagation\(\)/);
  assert.match(recent, /className="recent-analysis-actions"[\s\S]*?event\.stopPropagation\(\)/);
});

test("the removed global header does not leave a standalone help control", () => {
  assert.doesNotMatch(page, /aria-label="帮助"/);
});

test("brand and overview entity modules reuse existing navigation logic", () => {
  assert.match(page, /className="brand"[\s\S]*?onClick=\{\(\) => setView\("chat"\)\}/);
  assert.match(detail, /className="entity-chip-grid"[\s\S]*?onClick=\{\(\) => onTab\("mapping"\)\}/);
});

test("interactive surfaces expose hover, active and keyboard focus feedback", () => {
  assert.match(styles, /\.recent-analysis-item:hover/);
  assert.match(styles, /\.db-card:hover/);
  assert.match(styles, /\.sidebar \.nav-item:hover/);
  assert.match(styles, /\.query-footer \.source-selector:hover/);
  assert.match(styles, /\.primary-action:hover/);
  assert.match(styles, /button:not\(:disabled\):active/);
  assert.match(styles, /\[role="button"\]:focus-visible/);
});

test("smart Q&A defaults to SSE and exposes a stop action", () => {
  assert.match(page, /streamApi\("\/api\/query\/stream"/);
  assert.match(page, /\/run\/stream`/);
  assert.match(page, /chatStreamRef\.current\?\.abort\(\)/);
  assert.match(page, /停止生成/);
});
