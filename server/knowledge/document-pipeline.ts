import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { extname } from "node:path";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import type { RequestContext } from "../core/types.js";
import { embedText } from "./embedding.js";
import type { KnowledgeStore } from "./knowledge-store.js";
import type { VectorStore } from "./vector-store.js";

export const supportedDocumentExtensions = new Set([".pdf", ".docx", ".txt", ".md", ".xlsx", ".csv"]);
const pdf = createRequire(import.meta.url)("pdf-parse/lib/pdf-parse.js") as (buffer: Buffer) => Promise<{ text: string }>;

export class DocumentPipeline {
  constructor(private readonly store: KnowledgeStore, private readonly vectors: VectorStore) {}

  async process(context: RequestContext, knowledgeBaseId: string, file: { originalname: string; mimetype: string; size: number; buffer: Buffer }) {
    const extension = extname(file.originalname).toLowerCase();
    if (!supportedDocumentExtensions.has(extension)) throw new Error("仅支持 PDF、DOCX、TXT、MD、XLSX、CSV 文件");
    const document = this.store.createDocument(context, knowledgeBaseId, { filename: file.originalname.slice(0, 240), fileType: extension.slice(1).toUpperCase(), size: file.size });
    try {
      this.store.setDocumentStatus(context, document.id, "parsing");
      const text = normalizeText(await parseDocument(extension, file.buffer));
      if (!text) throw new Error("文档中没有可提取的文本");
      const config = this.store.get(context, knowledgeBaseId).knowledgeBase.config;
      this.store.setDocumentStatus(context, document.id, "chunking");
      const chunks = chunkText(text, config.chunkSize, config.chunkOverlap).map((content) => ({ id: randomUUID(), content }));
      if (!chunks.length) throw new Error("文档分块结果为空");
      this.store.replaceChunks(context, document.id, chunks);
      this.store.setDocumentStatus(context, document.id, "embedding");
      await this.vectors.upsert(context, chunks.map((chunk, index) => ({
        id: chunk.id, knowledgeBaseId, documentId: document.id, content: chunk.content,
        embedding: embedText(chunk.content), metadata: { filename: file.originalname, fileType: extension.slice(1).toUpperCase(), chunkIndex: index },
      })));
      this.store.setDocumentStatus(context, document.id, "ready");
      return this.store.document(context, document.id);
    } catch (error) {
      this.store.setDocumentStatus(context, document.id, "failed", error instanceof Error ? error.message : "文档处理失败");
      return this.store.document(context, document.id);
    }
  }
}

async function parseDocument(extension: string, buffer: Buffer) {
  if (extension === ".pdf") return (await pdf(buffer)).text;
  if (extension === ".docx") return (await mammoth.extractRawText({ buffer })).value;
  if (extension === ".xlsx") {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    return workbook.SheetNames.map((name) => `# ${name}\n${XLSX.utils.sheet_to_csv(workbook.Sheets[name])}`).join("\n\n");
  }
  return new TextDecoder("utf-8").decode(buffer);
}

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
