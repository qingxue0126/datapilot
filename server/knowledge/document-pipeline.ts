import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { extname } from "node:path";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import type { RequestContext } from "../core/types.js";
import type { EmbeddingProvider } from "./embedding.js";
import type { KnowledgeStore, ParserType, RetrievalConfig } from "./knowledge-store.js";
import { MilvusUnavailableError, type Metadata, type VectorRecord, type VectorStore } from "./vector-store.js";

export const supportedDocumentExtensions = new Set([".pdf", ".docx", ".txt", ".md", ".xlsx", ".csv"]);
const tableExtensions = new Set([".xlsx", ".csv"]);
const pdf = createRequire(import.meta.url)("pdf-parse/lib/pdf-parse.js") as (buffer: Buffer) => Promise<{ text: string }>;

export type ParserOptions = Pick<RetrievalConfig, "parserType" | "chunkSize" | "chunkOverlap" | "questionColumn" | "answerColumn" | "metadataFields">;
export type ParsedChunk = { id: string; content: string; metadata: Metadata; enabled: boolean };
export type ParseResult = { parserType: ParserType; columns: string[]; chunks: ParsedChunk[] };

export class DocumentPipeline {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly vectors: VectorStore,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  async process(context: RequestContext, knowledgeBaseId: string, file: {
    originalname: string; mimetype: string; size: number; buffer: Buffer;
  }, parserOverrides: Partial<ParserOptions> = {}) {
    const extension = extname(file.originalname).toLowerCase();
    if (!supportedDocumentExtensions.has(extension)) throw new Error("仅支持 PDF、DOCX、TXT、MD、XLSX、CSV 文件");
    const base = this.store.get(context, knowledgeBaseId).knowledgeBase;
    const parserType = parserOverrides.parserType || (tableExtensions.has(extension) ? "table" : base.config.parserType);
    const document = this.store.createDocument(context, knowledgeBaseId, {
      filename: file.originalname.slice(0, 240), fileType: extension.slice(1).toUpperCase(), size: file.size,
      parserType, source: file.buffer,
    });
    return this.run(context, document.id, extension, file.buffer, { ...base.config, ...parserOverrides, parserType });
  }

  async reparse(context: RequestContext, documentId: string, parserOverrides: Partial<ParserOptions> = {}) {
    const document = this.store.document(context, documentId);
    const source = this.store.documentSource(context, documentId);
    const base = this.store.get(context, document.knowledgeBaseId).knowledgeBase;
    const extension = `.${document.fileType.toLowerCase()}`;
    const parserType = parserOverrides.parserType || document.parserType || base.config.parserType;
    return this.run(context, documentId, extension, source, { ...base.config, ...parserOverrides, parserType });
  }

  async revectorize(context: RequestContext, knowledgeBaseId: string) {
    const base = this.store.get(context, knowledgeBaseId).knowledgeBase;
    const chunks = this.store.listBaseChunks(context, knowledgeBaseId);
    await this.vectors.deleteKnowledgeBase(context, knowledgeBaseId);
    const enabled = chunks.filter((chunk) => chunk.enabled);
    for (let index = 0; index < enabled.length; index += 64) {
      const batch = enabled.slice(index, index + 64);
      const vectors = await this.embeddings.embedBatch(context, base.config.embeddingModel, batch.map((chunk) => chunk.content));
      await this.vectors.upsert(context, batch.map((chunk, offset) => ({
        id: chunk.id, knowledgeBaseId, documentId: chunk.documentId, content: chunk.content,
        embedding: vectors[offset], metadata: chunk.metadata, enabled: true,
      })));
    }
    this.store.markReindexed(context, knowledgeBaseId);
    return { chunks: enabled.length };
  }

  private async run(context: RequestContext, documentId: string, extension: string, source: Buffer, options: ParserOptions) {
    const document = this.store.document(context, documentId);
    try {
      this.store.setDocumentStatus(context, documentId, "parsing");
      const parsed = await parseDocumentChunks(extension, source, options);
      if (!parsed.chunks.length) throw new Error("文档中没有可提取的内容");
      this.store.setDocumentParsing(context, documentId, parsed.parserType, parsed.columns);
      this.store.setDocumentStatus(context, documentId, "chunking");
      const chunks = parsed.chunks.map((chunk, chunkIndex) => ({
        ...chunk,
        metadata: {
          filename: document.filename, fileType: document.fileType, chunkIndex,
          ...chunk.metadata,
        },
      }));
      this.store.replaceChunks(context, documentId, chunks);
      this.store.setDocumentStatus(context, documentId, "embedding");
      await this.vectors.deleteDocument(context, documentId);
      for (let index = 0; index < chunks.length; index += 64) {
        const batch = chunks.slice(index, index + 64);
        const embeddings = await this.embeddings.embedBatch(context, this.store.get(context, document.knowledgeBaseId).knowledgeBase.config.embeddingModel, batch.map((chunk) => chunk.content));
        const records: VectorRecord[] = batch.map((chunk, offset) => ({
          id: chunk.id, knowledgeBaseId: document.knowledgeBaseId, documentId, content: chunk.content,
          embedding: embeddings[offset], metadata: chunk.metadata, enabled: chunk.enabled,
        }));
        await this.vectors.upsert(context, records);
      }
      this.store.setDocumentStatus(context, documentId, "ready");
      return this.store.document(context, documentId);
    } catch (error) {
      this.store.setDocumentStatus(context, documentId, "failed", error instanceof Error ? error.message : "文档处理失败");
      if (error instanceof MilvusUnavailableError) throw error;
      return this.store.document(context, documentId);
    }
  }
}

export async function parseDocumentChunks(extension: string, buffer: Buffer, options: ParserOptions): Promise<ParseResult> {
  if (options.parserType === "general") {
    const text = normalizeText(await parseGeneralDocument(extension, buffer));
    return { parserType: "general", columns: [], chunks: chunkText(text, options.chunkSize, options.chunkOverlap).map((content) => ({ id: randomUUID(), content, metadata: {}, enabled: true })) };
  }
  if (!tableExtensions.has(extension)) throw new Error("Table/QA Parser 仅适用于 XLSX 或 CSV 文件");
  const sheets = readWorkbook(buffer, extension);
  const columns = [...new Set(sheets.flatMap((sheet) => sheet.columns))];
  const chunks: ParsedChunk[] = [];
  for (const sheet of sheets) {
    sheet.rows.forEach((row, index) => {
      const rowNumber = index + 2;
      const metadata: Metadata = { sheet: sheet.name, row: rowNumber };
      for (const field of options.metadataFields) if (row[field] !== undefined && row[field] !== "") metadata[field] = row[field];
      if (options.parserType === "qa") {
        const question = displayValue(row[options.questionColumn]);
        const answer = displayValue(row[options.answerColumn]);
        if (!question && !answer) return;
        chunks.push({ id: randomUUID(), content: `问题：${question}\n答案：${answer}`.trim(), metadata, enabled: true });
        return;
      }
      const content = sheet.columns.map((column) => [column, displayValue(row[column])] as const)
        .filter(([, value]) => value !== "").map(([column, value]) => `${column}：${value}`).join("\n");
      if (content) chunks.push({ id: randomUUID(), content, metadata, enabled: true });
    });
  }
  if (options.parserType === "qa" && (!columns.includes(options.questionColumn) || !columns.includes(options.answerColumn))) {
    throw new Error(`QA Parser 未找到问题列“${options.questionColumn}”或答案列“${options.answerColumn}”`);
  }
  return { parserType: options.parserType, columns, chunks };
}

async function parseGeneralDocument(extension: string, buffer: Buffer) {
  if (extension === ".pdf") return (await pdf(buffer)).text;
  if (extension === ".docx") return (await mammoth.extractRawText({ buffer })).value;
  if (extension === ".xlsx") {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    return workbook.SheetNames.map((name) => `# ${name}\n${XLSX.utils.sheet_to_csv(workbook.Sheets[name])}`).join("\n\n");
  }
  return new TextDecoder("utf-8").decode(buffer);
}

function readWorkbook(buffer: Buffer, extension: string) {
  const workbook = extension === ".csv"
    ? XLSX.read(new TextDecoder("utf-8").decode(buffer), { type: "string", raw: false })
    : XLSX.read(buffer, { type: "buffer", raw: false });
  return workbook.SheetNames.map((name) => {
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[name], { defval: "", raw: false });
    const columns = rows.length ? Object.keys(rows[0]).map((item) => item.trim()).filter(Boolean) : [];
    return {
      name,
      columns,
      rows: rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.trim(), metadataValue(value)]))),
    };
  });
}

function metadataValue(value: unknown): string | number | boolean {
  if (typeof value === "number" || typeof value === "boolean") return value;
  return String(value ?? "").trim();
}
function displayValue(value: unknown) { return String(value ?? "").trim(); }
function normalizeText(text: string) { return text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(); }

export function chunkText(text: string, size: number, overlap: number) {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf("\n", end), text.lastIndexOf("。", end), text.lastIndexOf(". ", end));
      if (boundary > start + Math.floor(size * 0.55)) end = boundary + 1;
    }
    const content = text.slice(start, end).trim();
    if (content) chunks.push(content);
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}
