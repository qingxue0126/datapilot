import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
const component = readFileSync(new URL("../../components/datapilot/knowledge-base.tsx", import.meta.url), "utf8");

test("sidebar exposes knowledge base as a primary navigation item", () => {
  assert.match(page, /view === "knowledge"/);
  assert.match(page, />知识库<\/button>/);
  assert.match(page, /<KnowledgeBaseView/);
});

test("knowledge UI exposes upload, configuration, and retrieval test workflows", () => {
  for (const label of ["新建知识库", "上传文档", "检索配置", "检索测试", "chunk_size", "chunk_overlap", "embedding_model", "top_k", "score_threshold", "rerank_model"]) {
    assert.match(component, new RegExp(label));
  }
  assert.match(component, /\.pdf,\.docx,\.txt,\.md,\.xlsx,\.csv/);
  assert.match(component, /Score \{item\.score\.toFixed\(4\)\}/);
});
