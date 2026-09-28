import type { RequestContext } from "../core/types.js";
import { lexicalScore } from "./embedding.js";
import type { EmbeddingProvider } from "./embedding.js";
import { KnowledgeStore, KnowledgeStoreError, type RetrievalConfig } from "./knowledge-store.js";
import type { Metadata, MetadataValue, VectorStore } from "./vector-store.js";

export type KnowledgeRetrievalRequest = {
  knowledgeBaseId: string;
  query: string;
  filters?: Metadata;
  topK?: number;
  scoreThreshold?: number;
  rerank?: boolean;
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
  config: RetrievalConfig;
  vectorStore: VectorStore["provider"];
};

export class KnowledgeRetrievalService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly vectors: VectorStore,
    private readonly embeddings: EmbeddingProvider,
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
    const filters = validateMetadata(request.filters);

    this.validateFilterSchema(context, knowledgeBaseId, filters);
    const queryEmbedding = await this.embeddings.embed(context, config.embeddingModel, query);
    let matches = await this.vectors.search(context, knowledgeBaseId, queryEmbedding, {
      limit: Math.max(topK * 3, topK),
      metadataFilter: filters,
      indexConfig: vectorIndexConfig(config),
    });
    if (rerank) {
      matches = matches
        .map((item) => ({ ...item, score: item.score * 0.72 + lexicalScore(query, item.content) * 0.28 }))
        .sort((left, right) => right.score - left.score);
    }

    const documents = new Map(detail.documents.map((document) => [document.id, document]));
    const items = matches.filter((item) => item.score >= scoreThreshold).slice(0, topK).map((item, index) => {
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
    return { items, filters, topK, scoreThreshold, rerank, config, vectorStore: this.vectors.provider };
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
