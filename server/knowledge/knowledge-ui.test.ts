import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
const list = readFileSync(new URL("../../components/datapilot/knowledge-base.tsx", import.meta.url), "utf8");
const detail = readFileSync(new URL("../../components/datapilot/knowledge-base-detail.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
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
  assert.match(component, /placeholder="搜索"/);
  assert.match(component, /chunk-switch/);
  for (const label of ["全文", "摘要", "选择当前页", "Text", "条/页"]) assert.ok(component.includes(label));
  assert.match(component, /pageSize = 50/);
  assert.match(component, /tab === "chunks".*chunk-page/s);
  assert.match(component, /value === "chunks" && selectedDocumentId/);
  assert.match(component, /openChunks\(selectedDocumentId\)/);
  for (const label of ["文件列表", "分块结果", "上传时间", "元数据", "解析", "分块数", "确认删除"]) assert.match(component, new RegExp(label));
  assert.doesNotMatch(component, /window\.confirm/);
  assert.doesNotMatch(component, /<option value="auto">Auto<\/option>/);
  assert.doesNotMatch(component, /状态 \/ Parser/);
  for (const label of ["基本信息", "解析", "分块", "元数据", "嵌入", "索引", "Chunk Strategy", "Column Mode", "Index / Text", "Metric Type", "私有（当前租户 / 账套 / 用户）"]) assert.ok(component.includes(label));
  for (const strategy of ["Fixed", "Paragraph", "Heading（预留）", "Table Row", "QA Pair"]) assert.ok(component.includes(strategy));
  assert.ok(component.includes("所有列都会包含在 Chunk 正文中，并同时保存为元数据（RAGFlow 默认方式）。"));
  assert.ok(component.includes('columnMode === "auto" ?'));
  assert.ok(component.includes("已有文档需要重新解析"));
});

test("knowledge configuration uses the six-section order without retrieval controls", () => {
  const configPanel = detail.slice(detail.indexOf("function ConfigPanel"), detail.indexOf("function RetrievalPanel"));
  const sections = ["基本信息", "解析", "分块", "元数据", "嵌入", "索引"];
  let previous = -1;
  for (const section of sections) {
    const position = configPanel.indexOf(`<h3>${section}</h3>`);
    assert.ok(position > previous, `${section} section must follow the requested order`);
    previous = position;
  }
  for (const retrievalSetting of ["TopK", "Score Threshold", "Rerank 模型"]) assert.ok(!configPanel.includes(retrievalSetting));
});

test("chunk preview and results expose independent visible scroll regions", () => {
  assert.match(styles, /\.document-preview-body[^}]*overflow:\s*scroll/);
  assert.match(styles, /\.chunk-results-panel \.chunk-list[^}]*overflow-y:\s*auto/);
  assert.match(styles, /scrollbar-gutter:\s*stable/);
  assert.match(styles, /\.document-preview-body::\-webkit-scrollbar/);
});
