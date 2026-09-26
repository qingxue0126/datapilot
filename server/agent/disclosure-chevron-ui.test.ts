import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const explanation = readFileSync(new URL("../../components/datapilot/agent-explanation.tsx", import.meta.url), "utf8");
const datasourceDetail = readFileSync(new URL("../../components/datapilot/datasource-detail.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

test("answer explanation disclosures use the shared chevron", () => {
  assert.equal(explanation.match(/className="disclosure-summary"/g)?.length, 5);
  assert.equal(explanation.match(/chevron-icon chevron-right/g)?.length, 5);
});

test("raw schema disclosures use the same chevron", () => {
  assert.match(datasourceDetail, /disclosure-summary/);
  assert.match(datasourceDetail, /chevron-icon chevron-right/);
});

test("native disclosure markers are hidden", () => {
  assert.match(styles, /\.disclosure-summary::\-webkit-details-marker\s*\{\s*display:\s*none/);
  assert.match(styles, /list-style:\s*none/);
});

test("open disclosures rotate the shared chevron downward", () => {
  assert.match(styles, /details\[open\].*\.chevron-icon\s*\{\s*transform:\s*rotate\(45deg\)/);
});
