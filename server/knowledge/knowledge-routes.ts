import type { Express, NextFunction, Request, Response } from "express";
import multer from "multer";
import type { RequestContext } from "../core/types.js";
import { DocumentPipeline, supportedDocumentExtensions } from "./document-pipeline.js";
import { embedText, lexicalScore } from "./embedding.js";
import { KnowledgeStore, KnowledgeStoreError, type RetrievalConfig } from "./knowledge-store.js";
import type { VectorStore } from "./vector-store.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

export function installKnowledgeRoutes(app: Express, store: KnowledgeStore, vectors: VectorStore, resolveIdentity: (request: Request) => RequestContext) {
  const pipeline = new DocumentPipeline(store, vectors);

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
      if (!request.file) throw new KnowledgeStoreError("请选择要上传的文件");
      const extension = request.file.originalname.toLowerCase().match(/\.[^.]+$/)?.[0] || "";
      if (!supportedDocumentExtensions.has(extension)) throw new KnowledgeStoreError("仅支持 PDF、DOCX、TXT、MD、XLSX、CSV 文件");
      const document = await pipeline.process(resolveIdentity(request), String(request.params.id), request.file);
      response.status(201).json({ document });
    } catch (error) { knowledgeError(response, error); }
  });

  app.delete("/api/documents/:id", async (request, response) => {
    try {
      const context = resolveIdentity(request); store.document(context, request.params.id);
      await vectors.deleteDocument(context, request.params.id); store.deleteDocument(context, request.params.id); response.status(204).end();
    } catch (error) { knowledgeError(response, error); }
  });

  app.post("/api/knowledge-bases/:id/retrieve", async (request, response) => {
    try {
      const context = resolveIdentity(request); const detail = store.get(context, request.params.id);
      const query = String(request.body?.query || "").trim();
      if (!query) throw new KnowledgeStoreError("检索内容不能为空");
      const config = detail.knowledgeBase.config;
      const topK = Math.min(50, Math.max(1, Number(request.body?.topK || config.topK)));
      let items = await vectors.search(context, request.params.id, embedText(query), Math.max(topK * 3, topK));
      if (config.rerank) items = items.map((item) => ({ ...item, score: item.score * 0.72 + lexicalScore(query, item.content) * 0.28 })).sort((a, b) => b.score - a.score);
      response.json({ items: items.filter((item) => item.score >= config.scoreThreshold).slice(0, topK).map((item) => ({ chunkId: item.id, documentId: item.documentId, content: item.content, score: item.score, filename: String(item.metadata.filename || "未知文件"), chunkIndex: Number(item.metadata.chunkIndex || 0) })), config, vectorStore: vectors.provider });
    } catch (error) { knowledgeError(response, error); }
  });

  app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (error instanceof multer.MulterError) {
      knowledgeError(response, error);
      return;
    }
    next(error);
  });
}

function knowledgeError(response: { status: (code: number) => { json: (value: unknown) => unknown } }, error: unknown) {
  const multerError = error instanceof multer.MulterError;
  const status = error instanceof KnowledgeStoreError ? error.status : multerError ? 413 : 400;
  response.status(status).json({ error: error instanceof Error ? error.message : "知识库操作失败" });
}
