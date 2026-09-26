import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
const icon = readFileSync(new URL("../../components/datapilot/icons.tsx", import.meta.url), "utf8");

test("analysis workspace uses the shared chat bubble icon", () => {
  assert.match(page, /ChatBubbleIcon/);
  assert.match(page, /empty-analysis[\s\S]*ChatBubbleIcon/);
});

test("legacy data question primary navigation is removed", () => {
  assert.doesNotMatch(page, /nav-item[\s\S]{0,180}>数据问答<\/button>/);
});

test("query history uses the same chat bubble icon", () => {
  assert.match(page, /history-icon.*ChatBubbleIcon/s);
});

test("legacy data question glyph is removed", () => {
  assert.doesNotMatch(page, /⌁/);
});

test("chat bubble icon is an accessible decorative SVG", () => {
  assert.match(icon, /viewBox="0 0 24 24"/);
  assert.match(icon, /aria-hidden="true"/);
  assert.match(icon, /stroke="currentColor"/);
});
