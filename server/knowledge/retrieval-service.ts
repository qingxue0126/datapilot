import type { RequestContext } from "../core/types.js";
import { lexicalScore } from "./embedding.js";
import type { EmbeddingProvider } from "./embedding.js";
import { KnowledgeStore, KnowledgeStoreError, type RetrievalConfig } from "./knowledge-store.js";
import type { Metadata, MetadataValue, VectorSearchResult, VectorStore } from "./vector-store.js";

export interface RerankService {
  rerank(context: RequestContext, modelId: string, query: string, documents: string[], topN: number): Promise<{ results: { index: number; score: number }[] }>;
}

export type KnowledgeRetrievalRequest = {
  knowledgeBaseId: string;
  query: string;
  filters?: Metadata;
  topK?: number;
  scoreThreshold?: number;
  rerank?: boolean;
  retrievalMode?: "vector" | "hybrid";
  vectorWeight?: number;
  candidateCount?: number;
  rerankModel?: string;
  rerankTopK?: number;
};

export type KnowledgeRetrievalItem = {
  rank: number;
  chunkId: string;
  documentId: string;
  filename: string;
  fileType: string;
  chunkIndex: number;
  content: string;
  score: number;
  metadata: Metadata;
};

export type KnowledgeRetrievalResult = {
  items: KnowledgeRetrievalItem[];
  filters: Metadata;
  topK: number;
  scoreThreshold: number;
  rerank: boolean;
  retrievalMode: "vector" | "hybrid";
  vectorWeight: number;
  candidateCount: number;
  rerankModel: string;
  config: RetrievalConfig;
  vectorStore: VectorStore["provider"];
};

export class KnowledgeRetrievalService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly vectors: VectorStore,
    private readonly embeddings: EmbeddingProvider,
    private readonly reranker?: RerankService,
  ) {}

  async retrieve(context: RequestContext, request: KnowledgeRetrievalRequest): Promise<KnowledgeRetrievalResult> {
    const knowledgeBaseId = String(request.knowledgeBaseId || "").trim();
    if (!knowledgeBaseId) throw new KnowledgeStoreError("knowledge_base_id 不能为空");
    const query = String(request.query || "").trim();
    if (!query) throw new KnowledgeStoreError("query 不能为空");

    const detail = this.store.get(context, knowledgeBaseId);
    if (detail.knowledgeBase.requiresReindex) throw new KnowledgeStoreError("Embedding 模型或索引配置已变更，请先重新向量化", 409);
    const config = detail.knowledgeBase.config;
    const topK = boundedNumber(request.topK, config.topK, 1, 50, true, "top_k");
    const scoreThreshold = boundedNumber(request.scoreThreshold, config.scoreThreshold, -1, 1, false, "score_threshold");
    if (request.rerank !== undefined && typeof request.rerank !== "boolean") throw new KnowledgeStoreError("rerank 必须是布尔值");
    const rerank = request.rerank ?? config.rerank;
    const retrievalMode = request.retrievalMode === undefined ? "vector" : request.retrievalMode;
    if (retrievalMode !== "vector" && retrievalMode !== "hybrid") throw new KnowledgeStoreError("retrieval_mode 仅支持 vector 或 hybrid");
    const vectorWeight = boundedNumber(request.vectorWeight, 0.7, 0, 1, false, "vector_weight");
    const candidateCount = boundedNumber(request.candidateCount, Math.max(topK * 3, topK), topK, 200, true, "candidate_count");
    const rerankTopK = boundedNumber(request.rerankTopK, topK, 1, 50, true, "rerank_top_k");
    const rerankModel = String(request.rerankModel ?? config.rerankModel ?? "").trim();
    const filters = validateMetadata(request.filters);

    this.validateFilterSchema(context, knowledgeBaseId, filters);
    const queryEmbedding = await this.embeddings.embed(context, config.embeddingModel, query);
    let matches = await this.vectors.search(context, knowledgeBaseId, queryEmbedding, {
      limit: candidateCount,
      metadataFilter: filters,
      indexConfig: vectorIndexConfig(config),
    });
    if (retrievalMode === "hybrid") matches = this.hybridMatches(context, knowledgeBaseId, query, filters, matches, vectorWeight, candidateCount);
    matches = matches.filter((item) => item.score >= scoreThreshold);
    if (rerank && this.reranker && rerankModel && rerankModel !== "local-keyword-reranker-v1") {
      const ranked = await this.reranker.rerank(context, rerankModel, query, matches.map((item) => item.content), rerankTopK);
      matches = ranked.results.map((result) => ({ ...matches[result.index], score: result.score })).filter((item): item is VectorSearchResult => Boolean(item));
    } else if (rerank) {
      matches = matches
        .map((item) => ({ ...item, score: item.score * 0.72 + lexicalScore(query, item.content) * 0.28 }))
        .sort((left, right) => right.score - left.score);
    }

    const documents = new Map(detail.documents.map((document) => [document.id, document]));
    const finalTopK = rerank ? rerankTopK : topK;
    const items = matches.slice(0, finalTopK).map((item, index) => {
      const document = documents.get(item.documentId);
      return {
        rank: index + 1,
        chunkId: item.id,
        documentId: item.documentId,
        filename: document?.filename || String(item.metadata.filename || "未知文件"),
        fileType: document?.fileType || String(item.metadata.fileType || ""),
        chunkIndex: Number(item.metadata.chunkIndex || 0),
        content: item.content,
        score: item.score,
        metadata: item.metadata,
      };
    });
    return { items, filters, topK: finalTopK, scoreThreshold, rerank, retrievalMode, vectorWeight, candidateCount, rerankModel, config, vectorStore: this.vectors.provider };
  }

  private hybridMatches(context: RequestContext, knowledgeBaseId: string, query: string, filters: Metadata, vectorMatches: VectorSearchResult[], vectorWeight: number, limit: number) {
    const byId = new Map(vectorMatches.map((item) => [item.id, { ...item, score: item.score * vectorWeight }]));
    for (const chunk of this.store.listBaseChunks(context, knowledgeBaseId)) {
      if (!chunk.enabled || !metadataMatches(chunk.metadata, filters)) continue;
      const keywordScore = lexicalScore(query, chunk.content);
      const current = byId.get(chunk.id);
      if (current) current.score += keywordScore * (1 - vectorWeight);
      else if (keywordScore > 0) byId.set(chunk.id, {
        id: chunk.id, knowledgeBaseId, documentId: chunk.documentId, content: chunk.content,
        embedding: [], metadata: chunk.metadata, enabled: true, score: keywordScore * (1 - vectorWeight),
      });
    }
    return [...byId.values()].sort((left, right) => right.score - left.score).slice(0, limit);
  }

  private validateFilterSchema(context: RequestContext, knowledgeBaseId: string, filters: Metadata) {
    if (!Object.keys(filters).length) return;
    const fieldTypes = this.store.metadataSchema(context, knowledgeBaseId);
    const unknown = Object.keys(filters).filter((field) => !fieldTypes.has(field));
    if (unknown.length) {
      const available = [...fieldTypes.keys()].sort().join(", ") || "无";
      throw new KnowledgeStoreError(`Metadata 过滤字段不存在: ${unknown.join(", ")}；可用字段: ${available}`);
    }
    for (const [field, value] of Object.entries(filters)) {
      if (!fieldTypes.get(field)?.has(typeof value)) throw new KnowledgeStoreError(`Metadata 过滤值类型错误: ${field}`);
    }
  }
}

function metadataMatches(metadata: Metadata, filters: Metadata) {
  return Object.entries(filters).every(([field, value]) => metadata[field] === value);
}

export function validateMetadata(value: unknown, label = "filters"): Metadata {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new KnowledgeStoreError(`${label} 必须是对象`);
  const entries = Object.entries(value);
  if (entries.length > 100) throw new KnowledgeStoreError(`${label} 字段不能超过 100 个`);
  const result: Metadata = {};
  for (const [rawKey, item] of entries) {
    const key = rawKey.trim();
    if (!key || key.length > 256) throw new KnowledgeStoreError(`${label} 包含非法字段名`);
    if (!isMetadataValue(item) || (typeof item === "number" && !Number.isFinite(item))) {
      throw new KnowledgeStoreError(`${label}.${key} 仅支持字符串、有限数字或布尔值`);
    }
    if (typeof item === "string" && item.length > 10_000) throw new KnowledgeStoreError(`${label}.${key} 字符串过长`);
    result[key] = item;
  }
  return result;
}

function isMetadataValue(value: unknown): value is MetadataValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number, integer: boolean, field: string) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new KnowledgeStoreError(`${field} 必须是 ${min} 到 ${max} 之间的${integer ? "整数" : "数字"}`);
  }
  return value;
}

function vectorIndexConfig(config: RetrievalConfig) {
  return { indexType: config.indexType, metricType: config.metricType, hnswM: config.hnswM, hnswEfConstruction: config.hnswEfConstruction };
}
