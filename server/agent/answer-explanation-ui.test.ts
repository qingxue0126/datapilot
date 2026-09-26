import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("answer explanation renders the mapping status and effective version", async () => {
  const source = await readFile(new URL("../../components/datapilot/agent-explanation.tsx", import.meta.url), "utf8");

  assert.match(source, /explanation\.mappingStatus === "published" \? "Published"/);
  assert.match(source, /explanation\.publishedVersion \?\? explanation\.registryVersion/);
  assert.match(source, /<span>Mapping 状态<\/span><strong>\{mappingStatus\}<\/strong>/);
  assert.match(source, /<span>Mapping 版本<\/span><strong>\{mappingVersion === undefined \? "—" : `v\$\{mappingVersion\}`\}<\/strong>/);
});
