import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RequestContext } from "../core/types.js";

export type VectorRecord = {
  id: string;
  knowledgeBaseId: string;
  documentId: string;
  content: string;
  embedding: number[];
  metadata: Record<string, string | number>;
};

export type VectorSearchResult = VectorRecord & { score: number };

export interface VectorStore {
  readonly provider: "chroma" | "milvus";
  upsert(context: RequestContext, records: VectorRecord[]): void | Promise<void>;
  deleteKnowledgeBase(context: RequestContext, knowledgeBaseId: string): void | Promise<void>;
  deleteDocument(context: RequestContext, documentId: string): void | Promise<void>;
  search(context: RequestContext, knowledgeBaseId: string, queryEmbedding: number[], limit: number): VectorSearchResult[] | Promise<VectorSearchResult[]>;
  close?(): void;
}

type VectorRow = {
  id: string;
  knowledge_base_id: string;
  document_id: string;
  content: string;
  embedding_json: string;
  metadata_json: string;
};

/** Embedded local vector store used as the zero-config Chroma development adapter. */
export class ChromaVectorStore implements VectorStore {
  readonly provider = "chroma" as const;
  private readonly database: DatabaseSync;

  constructor(path = process.env.CHROMA_DB_PATH || resolve(".data", "chroma.sqlite")) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_vectors (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        account_set_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        knowledge_base_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS knowledge_vectors_owner_kb_idx
        ON knowledge_vectors (tenant_id, account_set_id, user_id, knowledge_base_id);
      CREATE INDEX IF NOT EXISTS knowledge_vectors_document_idx ON knowledge_vectors (document_id);
    `);
  }

  upsert(context: RequestContext, records: VectorRecord[]) {
    const statement = this.database.prepare(`
      INSERT OR REPLACE INTO knowledge_vectors
        (id, tenant_id, account_set_id, user_id, knowledge_base_id, document_id, content, embedding_json, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const record of records) statement.run(
        record.id, context.tenantId, context.accountSetId, context.userId,
        record.knowledgeBaseId, record.documentId, record.content,
        JSON.stringify(record.embedding), JSON.stringify(record.metadata),
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  deleteKnowledgeBase(context: RequestContext, knowledgeBaseId: string) {
    this.database.prepare(`DELETE FROM knowledge_vectors WHERE knowledge_base_id = ? AND tenant_id = ? AND account_set_id = ? AND user_id = ?`)
      .run(knowledgeBaseId, context.tenantId, context.accountSetId, context.userId);
  }

  deleteDocument(context: RequestContext, documentId: string) {
    this.database.prepare(`DELETE FROM knowledge_vectors WHERE document_id = ? AND tenant_id = ? AND account_set_id = ? AND user_id = ?`)
      .run(documentId, context.tenantId, context.accountSetId, context.userId);
  }

  search(context: RequestContext, knowledgeBaseId: string, queryEmbedding: number[], limit: number) {
    const rows = this.database.prepare(`
      SELECT id, knowledge_base_id, document_id, content, embedding_json, metadata_json
      FROM knowledge_vectors
      WHERE knowledge_base_id = ? AND tenant_id = ? AND account_set_id = ? AND user_id = ?
    `).all(knowledgeBaseId, context.tenantId, context.accountSetId, context.userId) as unknown as VectorRow[];
    return rows.map((row) => {
      const embedding = JSON.parse(row.embedding_json) as number[];
      return {
        id: row.id,
        knowledgeBaseId: row.knowledge_base_id,
        documentId: row.document_id,
        content: row.content,
        embedding,
        metadata: JSON.parse(row.metadata_json) as Record<string, string | number>,
        score: cosine(queryEmbedding, embedding),
      };
    }).sort((a, b) => b.score - a.score).slice(0, limit);
  }

  close() { this.database.close(); }
}

/** Configuration seam for a remote Milvus adapter; deliberately not exposed as a navigation datasource. */
export type MilvusVectorStoreConfig = {
  address: string;
  token?: string;
  collectionPrefix?: string;
};

export class MilvusVectorStore implements VectorStore {
  readonly provider = "milvus" as const;
  constructor(readonly config: MilvusVectorStoreConfig) {}
  private unavailable(): never { throw new Error("Milvus 适配器尚未连接；请配置服务端实现后启用 VECTOR_STORE_PROVIDER=milvus"); }
  upsert(): never { return this.unavailable(); }
  deleteKnowledgeBase(): never { return this.unavailable(); }
  deleteDocument(): never { return this.unavailable(); }
  search(): never { return this.unavailable(); }
}

export function createVectorStore(): VectorStore {
  if ((process.env.VECTOR_STORE_PROVIDER || "chroma").toLowerCase() === "milvus") {
    return new MilvusVectorStore({
      address: process.env.MILVUS_ADDRESS || "http://localhost:19530",
      token: process.env.MILVUS_TOKEN,
      collectionPrefix: process.env.MILVUS_COLLECTION_PREFIX || "datapilot",
    });
  }
  return new ChromaVectorStore();
}

function cosine(left: number[], right: number[]) {
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}
