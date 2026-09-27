import type { Express, NextFunction, Request, Response } from "express";
import multer from "multer";
import type { RequestContext } from "../core/types.js";
import { DocumentPipeline, parseDocumentPreview, supportedDocumentExtensions, type ParserOptions } from "./document-pipeline.js";
import type { EmbeddingProvider } from "./embedding.js";
import { lexicalScore } from "./embedding.js";
import { KnowledgeStore, KnowledgeStoreError, type RetrievalConfig } from "./knowledge-store.js";
import { MilvusUnavailableError, type Metadata, type VectorStore } from "./vector-store.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

export function installKnowledgeRoutes(
  app: Express,
  store: KnowledgeStore,
  vectors: VectorStore,
  embeddings: EmbeddingProvider,
  resolveIdentity: (request: Request) => RequestContext,
) {
  const pipeline = new DocumentPipeline(store, vectors, embeddings);

  app.get("/api/knowledge-bases", (request, response) => {
    try { response.json({ items: store.list(resolveIdentity(request)), vectorStore: vectors.provider }); }
    catch (error) { knowledgeError(response, error); }
  });

  app.post("/api/knowledge-bases", (request, response) => {
    try { response.status(201).json({ knowledgeBase: store.create(resolveIdentity(request), { name: String(request.body?.name || ""), description: request.body?.description, config: request.body?.config }) }); }
    catch (error) { knowledgeError(response, error); }
  });

  app.get("/api/knowledge-bases/:id", (request, response) => {
    try { response.json(store.get(resolveIdentity(request), request.params.id)); }
    catch (error) { knowledgeError(response, error); }
  });

  app.patch("/api/knowledge-bases/:id", (request, response) => {
    try {
      const input: { name?: string; description?: string; config?: Partial<RetrievalConfig> } = {};
      if (request.body?.name !== undefined) input.name = String(request.body.name);
      if (request.body?.description !== undefined) input.description = String(request.body.description);
      if (request.body?.config !== undefined) input.config = request.body.config as Partial<RetrievalConfig>;
      response.json({ knowledgeBase: store.update(resolveIdentity(request), request.params.id, input) });
    } catch (error) { knowledgeError(response, error); }
  });

  app.delete("/api/knowledge-bases/:id", async (request, response) => {
    try {
      const context = resolveIdentity(request); store.get(context, request.params.id);
      await vectors.deleteKnowledgeBase(context, request.params.id); store.delete(context, request.params.id); response.status(204).end();
    } catch (error) { knowledgeError(response, error); }
  });

  app.post("/api/knowledge-bases/:id/documents", upload.single("file"), async (request, response) => {
    try {
      if (!request.file) throw new KnowledgeStoreError("请选择要上传的文档");
      const extension = request.file.originalname.toLowerCase().match(/\.[^.]+$/)?.[0] || "";
      if (!supportedDocumentExtensions.has(extension)) throw new KnowledgeStoreError("仅支持 PDF、DOCX、TXT、MD、XLSX、CSV 文件");
      const document = await pipeline.process(resolveIdentity(request), String(request.params.id), request.file, parserOptions(request.body));
      response.status(201).json({ document });
    } catch (error) { knowledgeError(response, error); }
  });

  app.get("/api/documents/:id/chunks", (request, response) => {
    try {
      const context = resolveIdentity(request);
      response.json({ document: store.document(context, request.params.id), items: store.listChunks(context, request.params.id) });
    } catch (error) { knowledgeError(response, error); }
  });

  app.get("/api/documents/:id/preview", async (request, response) => {
    try {
      const context = resolveIdentity(request);
      const document = store.document(context, request.params.id);
      const source = store.documentSource(context, request.params.id);
      response.json({ document, preview: await parseDocumentPreview(`.${document.fileType.toLowerCase()}`, source) });
    } catch (error) { knowledgeError(response, error); }
  });

  app.post("/api/documents/:id/reparse", async (request, response) => {
    try {
      const document = await pipeline.reparse(resolveIdentity(request), request.params.id, parserOptions(request.body));
      response.json({ document });
    } catch (error) { knowledgeError(response, error); }
  });

  app.delete("/api/documents/:id", async (request, response) => {
    try {
      const context = resolveIdentity(request); store.document(context, request.params.id);
      await vectors.deleteDocument(context, request.params.id); store.deleteDocument(context, request.params.id); response.status(204).end();
    } catch (error) { knowledgeError(response, error); }
  });

  app.patch("/api/chunks/:id", async (request, response) => {
    try {
      const context = resolveIdentity(request);
      const current = store.chunk(context, request.params.id);
      const input: { content?: string; metadata?: Metadata; enabled?: boolean } = {};
      if (request.body?.content !== undefined) input.content = String(request.body.content);
      if (request.body?.metadata !== undefined) input.metadata = cleanMetadata(request.body.metadata);
      if (request.body?.enabled !== undefined) input.enabled = Boolean(request.body.enabled);
      const nextContent = input.content === undefined ? current.content : input.content;
      const base = store.get(context, current.knowledgeBaseId).knowledgeBase;
      const embedding = await embeddings.embed(context, base.config.embeddingModel, nextContent);
      const chunk = store.updateChunk(context, request.params.id, input);
      try {
        await vectors.upsert(context, [{
          id: chunk.id, knowledgeBaseId: chunk.knowledgeBaseId, documentId: chunk.documentId,
          content: chunk.content, embedding, metadata: chunk.metadata, enabled: chunk.enabled,
        }]);
      } catch (error) { store.markRequiresReindex(context, chunk.knowledgeBaseId); throw error; }
      response.json({ chunk });
    } catch (error) { knowledgeError(response, error); }
  });

  app.post("/api/knowledge-bases/:id/revectorize", async (request, response) => {
    try { response.json(await pipeline.revectorize(resolveIdentity(request), request.params.id)); }
    catch (error) { knowledgeError(response, error); }
  });

  app.post("/api/knowledge-bases/:id/retrieve", async (request, response) => {
    try {
      const context = resolveIdentity(request); const detail = store.get(context, request.params.id);
      const query = String(request.body?.query || "").trim();
      if (!query) throw new KnowledgeStoreError("检索内容不能为空");
      if (detail.knowledgeBase.requiresReindex) throw new KnowledgeStoreError("Embedding 模型已变更，请先重新向量化", 409);
      const config = detail.knowledgeBase.config;
      const topK = numberInRange(request.body?.topK, config.topK, 1, 50, true);
      const scoreThreshold = numberInRange(request.body?.scoreThreshold, config.scoreThreshold, -1, 1, false);
      const metadataFilter = cleanMetadata(request.body?.metadataFilter);
      const queryEmbedding = await embeddings.embed(context, config.embeddingModel, query);
      let items = await vectors.search(context, request.params.id, queryEmbedding, { limit: Math.max(topK * 3, topK), metadataFilter });
      if (config.rerank) items = items.map((item) => ({ ...item, score: item.score * 0.72 + lexicalScore(query, item.content) * 0.28 })).sort((a, b) => b.score - a.score);
      const documents = new Map(detail.documents.map((document) => [document.id, document]));
      response.json({
        items: items.filter((item) => item.score >= scoreThreshold).slice(0, topK).map((item, index) => ({
          rank: index + 1,
          chunkId: item.id,
          documentId: item.documentId,
          filename: documents.get(item.documentId)?.filename || String(item.metadata.filename || "未知文件"),
          chunkIndex: Number(item.metadata.chunkIndex || 0),
          content: item.content,
          score: item.score,
          metadata: item.metadata,
        })),
        config: { ...config, topK, scoreThreshold },
        metadataFilter,
        vectorStore: vectors.provider,
      });
    } catch (error) { knowledgeError(response, error); }
  });

  app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (error instanceof multer.MulterError) { knowledgeError(response, error); return; }
    next(error);
  });
}

function parserOptions(value: unknown): Partial<ParserOptions> {
  if (!value || typeof value !== "object") return {};
  const body = value as Record<string, unknown>;
  const result: Partial<ParserOptions> = {};
  if (["general", "table", "qa"].includes(String(body.parserType))) result.parserType = body.parserType as ParserOptions["parserType"];
  if (body.chunkSize !== undefined) result.chunkSize = Number(body.chunkSize);
  if (body.chunkOverlap !== undefined) result.chunkOverlap = Number(body.chunkOverlap);
  if (body.questionColumn !== undefined) result.questionColumn = String(body.questionColumn);
  if (body.answerColumn !== undefined) result.answerColumn = String(body.answerColumn);
  if (body.metadataFields !== undefined) result.metadataFields = stringArray(body.metadataFields);
  if (body.columnRoles !== undefined) result.columnRoles = columnRoleMap(body.columnRoles);
  return result;
}

function stringArray(value: unknown) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  const text = String(value || "").trim();
  if (!text) return [];
  try { const parsed = JSON.parse(text); if (Array.isArray(parsed)) return parsed.map(String).map((item) => item.trim()).filter(Boolean); } catch { /* comma separated form value */ }
  return text.split(",").map((item) => item.trim()).filter(Boolean);
}

function columnRoleMap(value: unknown): NonNullable<ParserOptions["columnRoles"]> {
  let source = value;
  if (typeof value === "string") { try { source = JSON.parse(value); } catch { return {}; } }
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  const result: NonNullable<ParserOptions["columnRoles"]> = {};
  for (const [column, role] of Object.entries(source as Record<string, unknown>)) {
    const normalized = String(role);
    if (normalized === "index" || normalized === "metadata" || normalized === "both" || normalized === "ignore") result[column] = normalized;
  }
  return result;
}

function cleanMetadata(value: unknown): Metadata {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new KnowledgeStoreError("Metadata 必须是对象");
  const entries = Object.entries(value);
  if (entries.length > 100) throw new KnowledgeStoreError("Metadata 字段不能超过 100 个");
  if (entries.some(([, item]) => !["string", "number", "boolean"].includes(typeof item))) throw new KnowledgeStoreError("Metadata 值仅支持字符串、数字或布尔值");
  return Object.fromEntries(entries) as Metadata;
}

function numberInRange(value: unknown, fallback: number, min: number, max: number, integer: boolean) {
  const number = value === undefined ? fallback : Number(value);
  const normalized = Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  return integer ? Math.round(normalized) : normalized;
}

function knowledgeError(response: { status: (code: number) => { json: (value: unknown) => unknown } }, error: unknown) {
  const multerError = error instanceof multer.MulterError;
  const status = error instanceof MilvusUnavailableError ? 503 : error instanceof KnowledgeStoreError ? error.status : multerError ? 413 : 400;
  response.status(status).json({ error: error instanceof Error ? error.message : "知识库操作失败" });
}
