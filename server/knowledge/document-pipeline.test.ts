import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import type { RequestContext } from "../core/types.js";
import { DocumentPipeline, parseDocumentChunks, parseDocumentPreview } from "./document-pipeline.js";
import { TestEmbeddingProvider } from "./embedding.js";
import { KnowledgeStore } from "./knowledge-store.js";
import { LocalVectorStore } from "./vector-store.js";

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

test("QA Parser independently builds content, embedding text, and metadata", async () => {
  const source = workbookBuffer([{
    Porduct: "好会计", Module: "基础档案", Question_TyPe: "会计科目",
    Question: "如何增加外币科目？", Answer: "进入设置后新增外币核算科目。",
  }]);
  const result = await parseDocumentChunks(".xlsx", source, {
    parserType: "qa", chunkSize: 800, chunkOverlap: 120,
    questionColumn: "Question", answerColumn: "Answer", metadataFields: [],
    columnMode: "manual",
    columnRoles: {
      Porduct: { content: false, embedding: false, metadata: true },
      Module: { content: false, embedding: false, metadata: true },
      Question_TyPe: { content: false, embedding: false, metadata: true },
      Question: { content: true, embedding: true, metadata: false },
      Answer: { content: true, embedding: false, metadata: false },
    },
  });

  assert.equal(result.chunks.length, 1);
  assert.equal(result.chunks[0].content, "问题：如何增加外币科目？\n答案：进入设置后新增外币核算科目。");
  assert.equal(result.chunks[0].embeddingContent, "问题：如何增加外币科目？");
  assert.equal(result.chunks[0].metadata.Porduct, "好会计");
  assert.equal(result.chunks[0].metadata.Module, "基础档案");
  assert.equal(result.chunks[0].metadata.Question_TyPe, "会计科目");
  assert.equal(result.chunks[0].metadata.Question, undefined);
  assert.equal(result.chunks[0].metadata.Answer, undefined);
});

test("document pipeline embeds only Embedding-enabled fields and persists filter metadata", async () => {
  const context: RequestContext = { tenantId: "tenant", accountSetId: "books", userId: "user", role: "tenant_admin", sessionId: "session" };
  const store = new KnowledgeStore(":memory:");
  const vectors = new LocalVectorStore(":memory:");
  const embedded: string[][] = [];
  class RecordingEmbeddings extends TestEmbeddingProvider {
    override async embedBatch(requestContext: RequestContext, modelId: string, texts: string[]) {
      embedded.push(texts);
      return super.embedBatch(requestContext, modelId, texts);
    }
  }
  try {
    const base = store.create(context, { name: "FAQ", config: {
      parserType: "qa", questionColumn: "Question", answerColumn: "Answer", columnMode: "manual",
      columnRoles: {
        Porduct: { content: false, embedding: false, metadata: true },
        Module: { content: false, embedding: false, metadata: true },
        Question_TyPe: { content: false, embedding: false, metadata: true },
        Question: { content: true, embedding: true, metadata: false },
        Answer: { content: true, embedding: false, metadata: false },
      },
    } });
    const pipeline = new DocumentPipeline(store, vectors, new RecordingEmbeddings());
    const source = workbookBuffer([{
      Porduct: "好会计", Module: "基础档案", Question_TyPe: "会计科目",
      Question: "如何增加外币科目？", Answer: "进入设置后新增外币核算科目。",
    }]);
    const document = await pipeline.process(context, base.id, {
      originalname: "faq.xlsx", mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: source.length, buffer: source,
    }, { parserType: "qa" });
    const chunk = store.listChunks(context, document.id)[0];
    assert.equal(chunk.content, "问题：如何增加外币科目？\n答案：进入设置后新增外币核算科目。");
    assert.equal(chunk.embeddingContent, "问题：如何增加外币科目？");
    assert.deepEqual(embedded, [["问题：如何增加外币科目？"]]);
    assert.equal(chunk.metadata.Porduct, "好会计");
    assert.equal(chunk.metadata.Module, "基础档案");
    assert.equal(chunk.metadata.Question_TyPe, "会计科目");
  } finally { vectors.close(); store.close(); }
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

test("Table Parser applies index, metadata, both, and ignore column roles", async () => {
  const result = await parseDocumentChunks(".xlsx", workbookBuffer(rows), {
    parserType: "table", chunkSize: 800, chunkOverlap: 120, questionColumn: "问题", answerColumn: "答案", metadataFields: [],
    columnMode: "manual",
    columnRoles: { 产品: "metadata", 模块: "ignore", 问题类型: "metadata", 问题: "index", 答案: "both" },
  });
  assert.match(result.chunks[0].content, /问题：如何删除凭证/);
  assert.match(result.chunks[0].content, /答案：打开凭证列表/);
  assert.doesNotMatch(result.chunks[0].content, /产品：/);
  assert.doesNotMatch(result.chunks[0].content, /模块：/);
  assert.equal(result.chunks[0].metadata["产品"], "好会计");
  assert.equal(result.chunks[0].metadata["问题类型"], "操作");
  assert.equal(result.chunks[0].metadata["答案"], "打开凭证列表，选择目标凭证后删除。");
  assert.equal(result.chunks[0].metadata["模块"], undefined);
});

test("Table Parser auto mode infers content, embedding, and metadata attributes", async () => {
  const result = await parseDocumentChunks(".xlsx", workbookBuffer(rows), {
    parserType: "table", chunkSize: 800, chunkOverlap: 120, questionColumn: "问题", answerColumn: "答案", metadataFields: [],
    columnMode: "auto",
    columnRoles: {},
  });
  assert.equal(result.chunks[0].content, "问题：如何删除凭证？\n答案：打开凭证列表，选择目标凭证后删除。");
  assert.equal(result.chunks[0].embeddingContent, result.chunks[0].content);
  assert.equal(result.chunks[0].metadata["产品"], "好会计");
  assert.equal(result.chunks[0].metadata["模块"], "凭证");
  assert.equal(result.chunks[0].metadata["问题类型"], "操作");
  assert.equal(result.chunks[0].metadata["问题"], undefined);
});

test("Table Parser infers unmapped columns after an Excel file is replaced", async () => {
  const replacementRows = [{ "适用产品": "U8", "问题领域": "供应链", "问题类别": "采购管理", "问题描述": "采购订单可以按行关闭吗？", "处理方案": "可以，在订单明细中关闭对应行。" }];
  const result = await parseDocumentChunks(".xlsx", workbookBuffer(replacementRows), {
    parserType: "table", chunkSize: 800, chunkOverlap: 120, questionColumn: "问题", answerColumn: "答案", metadataFields: ["产品", "模块"],
    columnMode: "manual",
    columnRoles: {
      "产品": { content: false, embedding: false, metadata: true },
      "模块": { content: false, embedding: false, metadata: true },
      "问题": { content: true, embedding: true, metadata: false },
      "答案": { content: true, embedding: false, metadata: false },
    },
  });
  assert.equal(result.chunks.length, 1);
  assert.match(result.chunks[0].content, /采购订单可以按行关闭吗/);
  assert.match(result.chunks[0].content, /订单明细中关闭对应行/);
  assert.equal(result.chunks[0].metadata["适用产品"], "U8");
  assert.equal(result.chunks[0].metadata["问题领域"], "供应链");
  assert.equal(result.chunks[0].metadata["问题类别"], "采购管理");
});

test("General Paragraph strategy keeps paragraphs as independent chunks", async () => {
  const result = await parseDocumentChunks(".txt", Buffer.from("第一段内容。\n\n第二段内容。"), {
    parserType: "general", chunkStrategy: "paragraph", chunkSize: 100, chunkOverlap: 20,
    questionColumn: "问题", answerColumn: "答案", metadataFields: [],
  });
  assert.equal(result.chunks.length, 2);
  assert.equal(result.chunks[0].content, "第一段内容。");
  assert.equal(result.chunks[1].content, "第二段内容。");
});
