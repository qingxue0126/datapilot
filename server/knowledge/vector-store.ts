import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DataType, MilvusClient, type SearchResultData } from "@zilliz/milvus2-sdk-node";
import type { RequestContext } from "../core/types.js";

export type MetadataValue = string | number | boolean;
export type Metadata = Record<string, MetadataValue>;
export type VectorRecord = { id: string; knowledgeBaseId: string; documentId: string; content: string; embedding: number[]; metadata: Metadata; enabled: boolean };
export type VectorSearchResult = VectorRecord & { score: number };
export type VectorIndexOptions = { indexType: "HNSW"; metricType: "COSINE" | "IP" | "L2"; hnswM: number; hnswEfConstruction: number };
export type VectorSearchOptions = { limit: number; metadataFilter?: Metadata; indexConfig?: VectorIndexOptions };
const defaultIndexConfig: VectorIndexOptions = { indexType: "HNSW", metricType: "IP", hnswM: 16, hnswEfConstruction: 200 };

export class MilvusUnavailableError extends Error {
  readonly status = 503;
  constructor(cause?: unknown) {
    super("Milvus unavailable", cause === undefined ? undefined : { cause });
    this.name = "MilvusUnavailableError";
  }
}

export interface VectorStore {
  readonly provider: "local" | "milvus";
  upsert(context: RequestContext, records: VectorRecord[], indexConfig?: VectorIndexOptions): void | Promise<void>;
  deleteKnowledgeBase(context: RequestContext, knowledgeBaseId: string): void | Promise<void>;
  deleteDocument(context: RequestContext, knowledgeBaseId: string, documentId: string): void | Promise<void>;
  deleteChunk(context: RequestContext, knowledgeBaseId: string, chunkId: string): void | Promise<void>;
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
  deleteDocument(context: RequestContext, knowledgeBaseId: string, documentId: string) { this.database.prepare("DELETE FROM knowledge_vectors WHERE knowledge_base_id=? AND document_id=? AND tenant_id=? AND account_set_id=? AND user_id=?").run(knowledgeBaseId, documentId, context.tenantId, context.accountSetId, context.userId); }
  deleteChunk(context: RequestContext, knowledgeBaseId: string, chunkId: string) { this.database.prepare("DELETE FROM knowledge_vectors WHERE knowledge_base_id=? AND id=? AND tenant_id=? AND account_set_id=? AND user_id=?").run(knowledgeBaseId, chunkId, context.tenantId, context.accountSetId, context.userId); }
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
type MilvusClientLike = Pick<MilvusClient, "hasCollection" | "createCollection" | "dropCollection" | "loadCollection" | "upsert" | "delete" | "search" | "closeConnection"> & { connectPromise?: Promise<void> };
type MilvusClientFactory = () => MilvusClientLike;

/** Production vector adapter backed by one ownership-filtered Milvus collection per knowledge base. */
export class MilvusVectorStore implements VectorStore {
  readonly provider = "milvus" as const;
  private readonly initializedCollections = new Map<string, number>();
  private client?: MilvusClientLike;
  private availabilityState: "unknown" | "available" | "unavailable" = "unknown";
  private readonly clientFactory: MilvusClientFactory;

  constructor(readonly config: MilvusVectorStoreConfig, clientOrFactory?: MilvusClientLike | MilvusClientFactory) {
    this.clientFactory = typeof clientOrFactory === "function"
      ? clientOrFactory
      : clientOrFactory
        ? () => clientOrFactory
        : () => new MilvusClient({ address: config.address, token: config.token, database: config.database });
  }

  get availability() { return this.availabilityState; }

  async upsert(context: RequestContext, records: VectorRecord[], indexConfig: VectorIndexOptions = defaultIndexConfig) {
    if (!records.length) return;
    const dimension = records[0].embedding.length;
    if (!dimension || records.some((record) => record.embedding.length !== dimension)) throw new Error("Milvus vector dimensions must match");
    await this.withClient("upsert", async (client) => {
      const collection = collectionName(this.config.collection, records[0].knowledgeBaseId);
      await this.ensureCollection(client, collection, dimension, indexConfig);
      await client.upsert({ collection_name: collection, data: records.map((record) => ({
        chunk_id: record.id, tenant_id: context.tenantId, account_set_id: context.accountSetId, user_id: context.userId,
        knowledge_base_id: record.knowledgeBaseId, document_id: record.documentId, content: record.content.slice(0, 65_535),
        embedding: record.embedding, metadata: record.metadata, enabled: record.enabled,
      })) });
    });
  }

  async deleteKnowledgeBase(context: RequestContext, knowledgeBaseId: string) {
    await this.withClient("delete", async (client) => {
      const collection = collectionName(this.config.collection, knowledgeBaseId);
      const exists = await client.hasCollection({ collection_name: collection });
      if (exists.value) await client.dropCollection({ collection_name: collection });
      this.initializedCollections.delete(collection);
    });
  }
  async deleteDocument(context: RequestContext, knowledgeBaseId: string, documentId: string) {
    await this.withClient("delete", (client) => this.deleteByFilter(client, collectionName(this.config.collection, knowledgeBaseId), `${ownerFilter(context, knowledgeBaseId)} and document_id == ${literal(documentId)}`));
  }
  async deleteChunk(context: RequestContext, knowledgeBaseId: string, chunkId: string) {
    await this.withClient("delete", (client) => this.deleteByFilter(client, collectionName(this.config.collection, knowledgeBaseId), `${ownerFilter(context, knowledgeBaseId)} and chunk_id == ${literal(chunkId)}`));
  }
  async search(context: RequestContext, knowledgeBaseId: string, queryEmbedding: number[], options: VectorSearchOptions) {
    return this.withClient("search", async (client) => {
      const indexConfig = options.indexConfig || defaultIndexConfig;
      const collection = collectionName(this.config.collection, knowledgeBaseId);
      await this.ensureCollection(client, collection, queryEmbedding.length, indexConfig);
      const filter = [ownerFilter(context, knowledgeBaseId), "enabled == true", ...metadataExpressions(options.metadataFilter || {})].join(" and ");
      const response = await client.search({ collection_name: collection, data: queryEmbedding, anns_field: "embedding",
        limit: options.limit, metric_type: indexConfig.metricType, params: { ef: 64 }, filter,
        output_fields: ["chunk_id", "knowledge_base_id", "document_id", "content", "metadata", "enabled"] });
      const results = response.results as SearchResultData[];
      return results.map((item) => ({ id: String(item.chunk_id || item.id), knowledgeBaseId: String(item.knowledge_base_id), documentId: String(item.document_id),
        content: String(item.content || ""), embedding: [], metadata: normalizeMetadata(item.metadata), enabled: Boolean(item.enabled), score: normalizeScore(Number(item.score), indexConfig.metricType) }));
    });
  }
  close() {
    const client = this.client;
    this.client = undefined;
    if (client) void Promise.resolve(client.closeConnection()).catch(() => undefined);
  }

  private async deleteByFilter(client: MilvusClientLike, collection: string, filter: string) {
    const exists = await client.hasCollection({ collection_name: collection });
    if (exists.value) await client.delete({ collection_name: collection, filter });
  }
  private async ensureCollection(client: MilvusClientLike, collection: string, dimension: number, indexConfig: VectorIndexOptions) {
    const initializedDimension = this.initializedCollections.get(collection);
    if (initializedDimension) {
      if (initializedDimension !== dimension) throw new Error(`Milvus collection dimension is ${initializedDimension}, received ${dimension}`);
      return;
    }
    const exists = await client.hasCollection({ collection_name: collection });
    if (!exists.value) {
      await client.createCollection({ collection_name: collection, consistency_level: "Session", enable_dynamic_field: false,
        fields: [varchar("chunk_id", 256, true), varchar("tenant_id", 256), varchar("account_set_id", 256), varchar("user_id", 256),
          varchar("knowledge_base_id", 256), varchar("document_id", 256), varchar("content", 65_535),
          { name: "embedding", data_type: DataType.FloatVector, dim: dimension }, { name: "metadata", data_type: DataType.JSON }, { name: "enabled", data_type: DataType.Bool }],
        index_params: { field_name: "embedding", index_name: `embedding_hnsw_${indexConfig.metricType.toLowerCase()}`, index_type: indexConfig.indexType, metric_type: indexConfig.metricType, params: { M: indexConfig.hnswM, efConstruction: indexConfig.hnswEfConstruction } } });
    }
    await client.loadCollection({ collection_name: collection });
    this.initializedCollections.set(collection, dimension);
  }
  private getClient() {
    if (!this.client) {
      this.client = this.clientFactory();
      // Milvus starts an eager server-info request in its constructor. Observe that
      // promise immediately so a refused connection cannot become a process-level
      // unhandled rejection before the requested operation reports its own error.
      void this.client.connectPromise?.catch(() => undefined);
    }
    return this.client;
  }
  private async withClient<T>(operation: string, action: (client: MilvusClientLike) => Promise<T>): Promise<T> {
    let client: MilvusClientLike | undefined;
    try {
      client = this.getClient();
      const result = await action(client);
      this.availabilityState = "available";
      return result;
    } catch (error) {
      this.availabilityState = "unavailable";
      this.initializedCollections.clear();
      this.client = undefined;
      if (client) void Promise.resolve(client.closeConnection()).catch(() => undefined);
      console.warn(`[knowledge] Milvus unavailable during ${operation}: ${errorMessage(error)}`);
      throw new MilvusUnavailableError(error);
    }
  }
}

export function createVectorStore(): VectorStore {
  const provider = (process.env.VECTOR_STORE_PROVIDER || (process.env.NODE_ENV === "test" ? "local" : "milvus")).toLowerCase();
  if (provider === "local") {
    if (process.env.NODE_ENV === "production") throw new Error("Production must use Milvus; LocalVectorStore is restricted to development and tests");
    return new LocalVectorStore();
  }
  return new MilvusVectorStore({ address: process.env.MILVUS_ADDRESS || "http://localhost:19530", token: process.env.MILVUS_TOKEN,
    database: process.env.MILVUS_DATABASE || "default", collection: process.env.MILVUS_COLLECTION || "datapilot_knowledge_chunks" });
}

function varchar(name: string, maxLength: number, primary = false) { return { name, data_type: DataType.VarChar, max_length: maxLength, is_primary_key: primary, autoID: false }; }
function collectionName(base: string, knowledgeBaseId: string) {
  const safeBase = base.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^[^a-zA-Z_]/, "_$&").slice(0, 180);
  const safeId = knowledgeBaseId.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 64);
  return `${safeBase}_${safeId}`;
}
function ownerFilter(context: RequestContext, knowledgeBaseId?: string) { return [`tenant_id == ${literal(context.tenantId)}`, `account_set_id == ${literal(context.accountSetId)}`, `user_id == ${literal(context.userId)}`, ...(knowledgeBaseId ? [`knowledge_base_id == ${literal(knowledgeBaseId)}`] : [])].join(" and "); }
function metadataExpressions(filter: Metadata) { return Object.entries(filter).map(([key, value]) => `metadata[${literal(key)}] == ${literal(value)}`); }
function literal(value: MetadataValue) { return typeof value === "string" ? JSON.stringify(value) : String(value); }
function normalizeMetadata(value: unknown): Metadata { if (!value || typeof value !== "object" || Array.isArray(value)) return {}; return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => ["string", "number", "boolean"].includes(typeof item))) as Metadata; }
function metadataMatches(metadata: Metadata, filter: Metadata) { return Object.entries(filter).every(([key, value]) => metadata[key] === value); }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function normalizeScore(score: number, metric: VectorIndexOptions["metricType"]) { return metric === "L2" ? 1 / (1 + Math.max(0, score)) : score; }
function cosine(left: number[], right: number[]) { let dot = 0; let leftNorm = 0; let rightNorm = 0; const length = Math.min(left.length, right.length); for (let index = 0; index < length; index += 1) { dot += left[index] * right[index]; leftNorm += left[index] ** 2; rightNorm += right[index] ** 2; } return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0; }
