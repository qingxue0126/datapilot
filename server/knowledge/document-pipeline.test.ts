import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { parseDocumentChunks, parseDocumentPreview } from "./document-pipeline.js";

function workbookBuffer(rows: Record<string, string>[]) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "高频问题");
  return Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
}

const rows = [
  { 产品: "好会计", 模块: "凭证", 问题类型: "操作", 问题: "如何删除凭证？", 答案: "打开凭证列表，选择目标凭证后删除。" },
  { 产品: "易代账", 模块: "报表", 问题类型: "导出", 问题: "如何导出报表？", 答案: "点击导出按钮。" },
];

test("Table Parser creates one business-row chunk and extracts selected metadata", async () => {
  const result = await parseDocumentChunks(".xlsx", workbookBuffer(rows), {
    parserType: "table", chunkSize: 800, chunkOverlap: 120, questionColumn: "问题", answerColumn: "答案", metadataFields: ["产品", "模块", "问题类型"],
  });
  assert.equal(result.chunks.length, 2);
  assert.deepEqual(result.columns, ["产品", "模块", "问题类型", "问题", "答案"]);
  assert.match(result.chunks[0].content, /产品：好会计/);
  assert.match(result.chunks[0].content, /答案：打开凭证列表/);
  assert.deepEqual(result.chunks[0].metadata, { sheet: "高频问题", row: 2, 产品: "好会计", 模块: "凭证", 问题类型: "操作" });
});

test("QA Parser creates exactly one question-answer chunk per row", async () => {
  const result = await parseDocumentChunks(".xlsx", workbookBuffer(rows), {
    parserType: "qa", chunkSize: 800, chunkOverlap: 120, questionColumn: "问题", answerColumn: "答案", metadataFields: ["产品"],
  });
  assert.equal(result.chunks.length, 2);
  assert.equal(result.chunks[0].content, "问题：如何删除凭证？\n答案：打开凭证列表，选择目标凭证后删除。");
  assert.equal(result.chunks[0].metadata["产品"], "好会计");
});

test("QA Parser rejects missing configured question or answer columns", async () => {
  await assert.rejects(() => parseDocumentChunks(".xlsx", workbookBuffer(rows), {
    parserType: "qa", chunkSize: 800, chunkOverlap: 120, questionColumn: "不存在", answerColumn: "答案", metadataFields: [],
  }), /未找到问题列/);
});

test("document preview preserves workbook sheets, columns, and row values", async () => {
  const preview = await parseDocumentPreview(".xlsx", workbookBuffer(rows));
  assert.equal(preview.kind, "table");
  if (preview.kind !== "table") return;
  assert.equal(preview.sheets.length, 1);
  assert.equal(preview.sheets[0].columns.length, 5);
  assert.equal(preview.sheets[0].rows.length, 2);
  assert.deepEqual(preview.sheets[0].rows[0], rows[0]);
});
