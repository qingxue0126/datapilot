import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
const list = readFileSync(new URL("../../components/datapilot/knowledge-base.tsx", import.meta.url), "utf8");
const detail = readFileSync(new URL("../../components/datapilot/knowledge-base-detail.tsx", import.meta.url), "utf8");
const component = `${list}\n${detail}`;

test("sidebar exposes knowledge base as a primary navigation item", () => {
  assert.match(page, /view === "knowledge"/);
  assert.match(page, />知识库<\/button>/);
  assert.match(page, /<KnowledgeBaseView/);
});

test("knowledge UI exposes parser, chunks, metadata, embedding, and retrieval testing", () => {
  for (const label of ["新建知识库", "新增文件", "重新解析文档", "Metadata Fields", "Embedding 模型", "重新向量化", "检索测试", "Score Threshold", "定位 Chunk"]) {
    assert.match(component, new RegExp(label));
  }
  assert.match(component, /\.pdf,\.docx,\.txt,\.md,\.xlsx,\.csv/);
  assert.match(component, /item\.score\.toFixed\(4\)/);
  assert.match(component, /api\/documents\/.*\/chunks/);
  assert.match(component, /api\/chunks\//);
  assert.match(component, /api\/documents\/.*\/preview/);
  assert.match(component, /chunk-split-layout/);
  assert.match(component, /document-preview-panel/);
  assert.match(component, /placeholder="搜索 Chunk"/);
  assert.match(component, /chunk-switch/);
  assert.match(component, /value === "chunks" && selectedDocumentId/);
  assert.match(component, /openChunks\(selectedDocumentId\)/);
  for (const label of ["文件列表", "分块结果", "上传时间", "元数据", "解析", "分块数", "确认删除"]) assert.match(component, new RegExp(label));
  assert.doesNotMatch(component, /window\.confirm/);
  assert.doesNotMatch(component, /<option value="auto">Auto<\/option>/);
  assert.doesNotMatch(component, /状态 \/ Parser/);
  for (const label of ["基础信息", "向量信息", "解析方法", "Column Mode", "索引 + 元数据", "私有（当前租户 / 账套 / 用户）"]) assert.ok(component.includes(label));
});
