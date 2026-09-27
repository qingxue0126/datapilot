import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DataType, MilvusClient, type SearchResultData } from "@zilliz/milvus2-sdk-node";
import type { RequestContext } from "../core/types.js";

export type MetadataValue = string | number | boolean;
export type Metadata = Record<string, MetadataValue>;
export type VectorRecord = { id: string; knowledgeBaseId: string; documentId: string; content: string; embedding: number[]; metadata: Metadata; enabled: boolean };
export type VectorSearchResult = VectorRecord & { score: number };
export type VectorSearchOptions = { limit: number; metadataFilter?: Metadata };

export interface VectorStore {
  readonly provider: "local" | "milvus";
  upsert(context: RequestContext, records: VectorRecord[]): void | Promise<void>;
  deleteKnowledgeBase(context: RequestContext, knowledgeBaseId: string): void | Promise<void>;
  deleteDocument(context: RequestContext, documentId: string): void | Promise<void>;
  deleteChunk(context: RequestContext, chunkId: string): void | Promise<void>;
  search(context: RequestContext, knowledgeBaseId: string, queryEmbedding: number[], options: VectorSearchOptions): VectorSearchResult[] | Promise<VectorSearchResult[]>;
  close?(): void;
}

type VectorRow = { id: string; knowledge_base_id: string; document_id: string; content: string; embedding_json: string; metadata_json: string; enabled: number };

/** SQLite vector search is intentionally restricted to local development and tests. */
export class LocalVectorStore implements VectorStore {
  readonly provider = "local" as const;
  private readonly database: DatabaseSync;
  constructor(path = process.env.LOCAL_VECTOR_DB_PATH || resolve(".data", "vectors-test.sqlite")) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`CREATE TABLE IF NOT EXISTS knowledge_vectors (
      id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, account_set_id TEXT NOT NULL, user_id TEXT NOT NULL,
      knowledge_base_id TEXT NOT NULL, document_id TEXT NOT NULL, content TEXT NOT NULL, embedding_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
    ); CREATE INDEX IF NOT EXISTS knowledge_vectors_owner_kb_idx ON knowledge_vectors(tenant_id,account_set_id,user_id,knowledge_base_id);`);
  }
  upsert(context: RequestContext, records: VectorRecord[]) {
    const statement = this.database.prepare(`INSERT OR REPLACE INTO knowledge_vectors
      (id,tenant_id,account_set_id,user_id,knowledge_base_id,document_id,content,embedding_json,metadata_json,enabled) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    this.database.exec("BEGIN IMMEDIATE");
    try { for (const record of records) statement.run(record.id, context.tenantId, context.accountSetId, context.userId, record.knowledgeBaseId, record.documentId, record.content, JSON.stringify(record.embedding), JSON.stringify(record.metadata), record.enabled ? 1 : 0); this.database.exec("COMMIT"); }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  deleteKnowledgeBase(context: RequestContext, knowledgeBaseId: string) { this.database.prepare("DELETE FROM knowledge_vectors WHERE knowledge_base_id=? AND tenant_id=? AND account_set_id=? AND user_id=?").run(knowledgeBaseId, context.tenantId, context.accountSetId, context.userId); }
  deleteDocument(context: RequestContext, documentId: string) { this.database.prepare("DELETE FROM knowledge_vectors WHERE document_id=? AND tenant_id=? AND account_set_id=? AND user_id=?").run(documentId, context.tenantId, context.accountSetId, context.userId); }
  deleteChunk(context: RequestContext, chunkId: string) { this.database.prepare("DELETE FROM knowledge_vectors WHERE id=? AND tenant_id=? AND account_set_id=? AND user_id=?").run(chunkId, context.tenantId, context.accountSetId, context.userId); }
  search(context: RequestContext, knowledgeBaseId: string, queryEmbedding: number[], options: VectorSearchOptions) {
    const rows = this.database.prepare(`SELECT id,knowledge_base_id,document_id,content,embedding_json,metadata_json,enabled FROM knowledge_vectors
      WHERE knowledge_base_id=? AND tenant_id=? AND account_set_id=? AND user_id=? AND enabled=1`)
      .all(knowledgeBaseId, context.tenantId, context.accountSetId, context.userId) as unknown as VectorRow[];
    return rows.map((row) => ({ id: row.id, knowledgeBaseId: row.knowledge_base_id, documentId: row.document_id, content: row.content,
      embedding: JSON.parse(row.embedding_json) as number[], metadata: JSON.parse(row.metadata_json) as Metadata, enabled: Boolean(row.enabled),
      score: cosine(queryEmbedding, JSON.parse(row.embedding_json) as number[]) }))
      .filter((item) => metadataMatches(item.metadata, options.metadataFilter || {})).sort((a, b) => b.score - a.score).slice(0, options.limit);
  }
  close() { this.database.close(); }
}

export type MilvusVectorStoreConfig = { address: string; token?: string; database?: string; collection: string };
type MilvusClientLike = Pick<MilvusClient, "hasCollection" | "createCollection" | "loadCollection" | "upsert" | "delete" | "search" | "closeConnection">;

/** Production vector adapter backed by one ownership-filtered Milvus collection. */
export class MilvusVectorStore implements VectorStore {
  readonly provider = "milvus" as const;
  private initializedDimension = 0;
  private readonly client: MilvusClientLike;
  constructor(readonly config: MilvusVectorStoreConfig, client?: MilvusClientLike) {
    this.client = client || new MilvusClient({ address: config.address, token: config.token, database: config.database });
  }

  async upsert(context: RequestContext, records: VectorRecord[]) {
    if (!records.length) return;
    const dimension = records[0].embedding.length;
    if (!dimension || records.some((record) => record.embedding.length !== dimension)) throw new Error("写入 Milvus 的向量维度不一致");
    await this.ensureCollection(dimension);
    await this.client.upsert({ collection_name: this.config.collection, data: records.map((record) => ({
      chunk_id: record.id, tenant_id: context.tenantId, account_set_id: context.accountSetId, user_id: context.userId,
      knowledge_base_id: record.knowledgeBaseId, document_id: record.documentId, content: record.content.slice(0, 65_535),
      embedding: record.embedding, metadata: record.metadata, enabled: record.enabled,
    })) });
  }
  async deleteKnowledgeBase(context: RequestContext, knowledgeBaseId: string) {
    await this.deleteByFilter(ownerFilter(context, knowledgeBaseId));
  }
  async deleteDocument(context: RequestContext, documentId: string) {
    await this.deleteByFilter(`${ownerFilter(context)} and document_id == ${literal(documentId)}`);
  }
  async deleteChunk(context: RequestContext, chunkId: string) {
    await this.deleteByFilter(`${ownerFilter(context)} and chunk_id == ${literal(chunkId)}`);
  }
  async search(context: RequestContext, knowledgeBaseId: string, queryEmbedding: number[], options: VectorSearchOptions) {
    await this.ensureCollection(queryEmbedding.length);
    const filter = [ownerFilter(context, knowledgeBaseId), "enabled == true", ...metadataExpressions(options.metadataFilter || {})].join(" and ");
    const response = await this.client.search({ collection_name: this.config.collection, data: queryEmbedding, anns_field: "embedding",
      limit: options.limit, metric_type: "IP", params: { nprobe: 16 }, filter,
      output_fields: ["chunk_id", "knowledge_base_id", "document_id", "content", "metadata", "enabled"] });
    const results = response.results as SearchResultData[];
    return results.map((item) => ({ id: String(item.chunk_id || item.id), knowledgeBaseId: String(item.knowledge_base_id), documentId: String(item.document_id),
      content: String(item.content || ""), embedding: [], metadata: normalizeMetadata(item.metadata), enabled: Boolean(item.enabled), score: Number(item.score) }));
  }
  close() { void this.client.closeConnection(); }

  private async deleteByFilter(filter: string) {
    const exists = await this.client.hasCollection({ collection_name: this.config.collection });
    if (exists.value) await this.client.delete({ collection_name: this.config.collection, filter });
  }
  private async ensureCollection(dimension: number) {
    if (this.initializedDimension) {
      if (this.initializedDimension !== dimension) throw new Error(`Milvus Collection 向量维度为 ${this.initializedDimension}，当前模型返回 ${dimension} 维；请使用匹配的 Collection`);
      return;
    }
    const exists = await this.client.hasCollection({ collection_name: this.config.collection });
    if (!exists.value) {
      await this.client.createCollection({ collection_name: this.config.collection, consistency_level: "Session", enable_dynamic_field: false,
        fields: [varchar("chunk_id", 256, true), varchar("tenant_id", 256), varchar("account_set_id", 256), varchar("user_id", 256),
          varchar("knowledge_base_id", 256), varchar("document_id", 256), varchar("content", 65_535),
          { name: "embedding", data_type: DataType.FloatVector, dim: dimension }, { name: "metadata", data_type: DataType.JSON }, { name: "enabled", data_type: DataType.Bool }],
        index_params: { field_name: "embedding", index_name: "embedding_ip", index_type: "HNSW", metric_type: "IP", params: { M: 16, efConstruction: 200 } } });
    }
    await this.client.loadCollection({ collection_name: this.config.collection });
    this.initializedDimension = dimension;
  }
}

export function createVectorStore(): VectorStore {
  const provider = (process.env.VECTOR_STORE_PROVIDER || (process.env.NODE_ENV === "test" ? "local" : "milvus")).toLowerCase();
  if (provider === "local") {
    if (process.env.NODE_ENV === "production") throw new Error("生产环境必须使用 Milvus，LocalVectorStore 仅允许开发和测试使用");
    return new LocalVectorStore();
  }
  return new MilvusVectorStore({ address: process.env.MILVUS_ADDRESS || "http://localhost:19530", token: process.env.MILVUS_TOKEN,
    database: process.env.MILVUS_DATABASE || "default", collection: process.env.MILVUS_COLLECTION || "datapilot_knowledge_chunks" });
}

function varchar(name: string, maxLength: number, primary = false) { return { name, data_type: DataType.VarChar, max_length: maxLength, is_primary_key: primary, autoID: false }; }
function ownerFilter(context: RequestContext, knowledgeBaseId?: string) { return [`tenant_id == ${literal(context.tenantId)}`, `account_set_id == ${literal(context.accountSetId)}`, `user_id == ${literal(context.userId)}`, ...(knowledgeBaseId ? [`knowledge_base_id == ${literal(knowledgeBaseId)}`] : [])].join(" and "); }
function metadataExpressions(filter: Metadata) { return Object.entries(filter).map(([key, value]) => `metadata[${literal(key)}] == ${literal(value)}`); }
function literal(value: MetadataValue) { return typeof value === "string" ? JSON.stringify(value) : String(value); }
function normalizeMetadata(value: unknown): Metadata { if (!value || typeof value !== "object" || Array.isArray(value)) return {}; return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => ["string", "number", "boolean"].includes(typeof item))) as Metadata; }
function metadataMatches(metadata: Metadata, filter: Metadata) { return Object.entries(filter).every(([key, value]) => metadata[key] === value); }
function cosine(left: number[], right: number[]) { let dot = 0; let leftNorm = 0; let rightNorm = 0; const length = Math.min(left.length, right.length); for (let index = 0; index < length; index += 1) { dot += left[index] * right[index]; leftNorm += left[index] ** 2; rightNorm += right[index] ** 2; } return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0; }
