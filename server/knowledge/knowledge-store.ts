import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RequestContext } from "../core/types.js";

export type RetrievalConfig = {
  chunkSize: number;
  chunkOverlap: number;
  embeddingModel: string;
  topK: number;
  scoreThreshold: number;
  rerank: boolean;
  rerankModel: string;
};

export type KnowledgeBase = {
  id: string;
  name: string;
  description: string;
  documentCount: number;
  chunkCount: number;
  config: RetrievalConfig;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeDocument = {
  id: string;
  knowledgeBaseId: string;
  filename: string;
  fileType: string;
  size: number;
  status: "uploaded" | "parsing" | "chunking" | "embedding" | "ready" | "failed";
  error?: string;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
};

type KnowledgeBaseRow = {
  id: string; name: string; description: string; config_json: string; created_at: string; updated_at: string;
  document_count?: number; chunk_count?: number;
};
type DocumentRow = {
  id: string; knowledge_base_id: string; filename: string; file_type: string; size: number; status: KnowledgeDocument["status"];
  error: string | null; chunk_count: number; created_at: string; updated_at: string;
};

export class KnowledgeStoreError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export class KnowledgeStore {
  private readonly database: DatabaseSync;

  constructor(path = process.env.KNOWLEDGE_DB_PATH || resolve(".data", "knowledge.sqlite")) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON");
    if (path !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_bases (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        account_set_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS knowledge_bases_owner_updated_idx
        ON knowledge_bases (tenant_id, account_set_id, user_id, updated_at);
      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id TEXT PRIMARY KEY NOT NULL,
        knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        file_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS knowledge_documents_kb_created_idx
        ON knowledge_documents (knowledge_base_id, created_at);
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id TEXT PRIMARY KEY NOT NULL,
        knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS knowledge_chunks_document_idx ON knowledge_chunks (document_id, chunk_index);
    `);
  }

  list(context: RequestContext) {
    const rows = this.database.prepare(`
      SELECT kb.id, kb.name, kb.description, kb.config_json, kb.created_at, kb.updated_at,
        COUNT(DISTINCT d.id) AS document_count, COUNT(c.id) AS chunk_count
      FROM knowledge_bases kb
      LEFT JOIN knowledge_documents d ON d.knowledge_base_id = kb.id
      LEFT JOIN knowledge_chunks c ON c.document_id = d.id
      WHERE kb.tenant_id = ? AND kb.account_set_id = ? AND kb.user_id = ?
      GROUP BY kb.id ORDER BY kb.updated_at DESC, kb.id DESC
    `).all(context.tenantId, context.accountSetId, context.userId) as unknown as KnowledgeBaseRow[];
    return rows.map(toKnowledgeBase);
  }

  create(context: RequestContext, input: { name: string; description?: string; config?: Partial<RetrievalConfig> }) {
    const name = cleanName(input.name);
    if (!name) throw new KnowledgeStoreError("知识库名称不能为空");
    const id = randomUUID(); const now = new Date().toISOString();
    const config = normalizeConfig(input.config);
    this.database.prepare(`INSERT INTO knowledge_bases (id, tenant_id, account_set_id, user_id, name, description, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, context.tenantId, context.accountSetId, context.userId, name, String(input.description || "").trim().slice(0, 500), JSON.stringify(config), now, now);
    return this.get(context, id).knowledgeBase;
  }

  get(context: RequestContext, id: string) {
    const row = this.ownedBase(context, id);
    const documents = this.database.prepare(`SELECT id, knowledge_base_id, filename, file_type, size, status, error, chunk_count, created_at, updated_at FROM knowledge_documents WHERE knowledge_base_id = ? ORDER BY created_at DESC, id DESC`)
      .all(id) as unknown as DocumentRow[];
    return { knowledgeBase: { ...toKnowledgeBase(row), documentCount: documents.length, chunkCount: documents.reduce((sum, item) => sum + Number(item.chunk_count), 0) }, documents: documents.map(toDocument) };
  }

  update(context: RequestContext, id: string, input: { name?: string; description?: string; config?: Partial<RetrievalConfig> }) {
    const current = this.ownedBase(context, id); const now = new Date().toISOString();
    const name = input.name === undefined ? current.name : cleanName(input.name);
    if (!name) throw new KnowledgeStoreError("知识库名称不能为空");
    const description = input.description === undefined ? current.description : String(input.description).trim().slice(0, 500);
    const config = normalizeConfig({ ...parseConfig(current.config_json), ...input.config });
    this.database.prepare(`UPDATE knowledge_bases SET name = ?, description = ?, config_json = ?, updated_at = ? WHERE id = ?`)
      .run(name, description, JSON.stringify(config), now, id);
    return this.get(context, id).knowledgeBase;
  }

  delete(context: RequestContext, id: string) {
    this.ownedBase(context, id);
    this.database.prepare(`DELETE FROM knowledge_bases WHERE id = ?`).run(id);
  }

  createDocument(context: RequestContext, knowledgeBaseId: string, input: { filename: string; fileType: string; size: number }) {
    this.ownedBase(context, knowledgeBaseId);
    const id = randomUUID(); const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO knowledge_documents (id, knowledge_base_id, filename, file_type, size, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'uploaded', ?, ?)`)
      .run(id, knowledgeBaseId, input.filename, input.fileType, input.size, now, now);
    return this.document(context, id);
  }

  setDocumentStatus(context: RequestContext, id: string, status: KnowledgeDocument["status"], error?: string) {
    this.ownedDocument(context, id);
    this.database.prepare(`UPDATE knowledge_documents SET status = ?, error = ?, updated_at = ? WHERE id = ?`)
      .run(status, error || null, new Date().toISOString(), id);
  }

  replaceChunks(context: RequestContext, documentId: string, chunks: { id: string; content: string }[]) {
    const document = this.ownedDocument(context, documentId); const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`DELETE FROM knowledge_chunks WHERE document_id = ?`).run(documentId);
      const insert = this.database.prepare(`INSERT INTO knowledge_chunks (id, knowledge_base_id, document_id, chunk_index, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
      chunks.forEach((chunk, index) => insert.run(chunk.id, document.knowledge_base_id, documentId, index, chunk.content, now));
      this.database.prepare(`UPDATE knowledge_documents SET chunk_count = ?, updated_at = ? WHERE id = ?`).run(chunks.length, now, documentId);
      this.database.prepare(`UPDATE knowledge_bases SET updated_at = ? WHERE id = ?`).run(now, document.knowledge_base_id);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  document(context: RequestContext, id: string) { return toDocument(this.ownedDocument(context, id)); }

  deleteDocument(context: RequestContext, id: string) {
    const document = this.ownedDocument(context, id);
    this.database.prepare(`DELETE FROM knowledge_documents WHERE id = ?`).run(id);
    this.database.prepare(`UPDATE knowledge_bases SET updated_at = ? WHERE id = ?`).run(new Date().toISOString(), document.knowledge_base_id);
    return document.knowledge_base_id;
  }

  close() { this.database.close(); }

  private ownedBase(context: RequestContext, id: string) {
    const row = this.database.prepare(`SELECT id, name, description, config_json, created_at, updated_at FROM knowledge_bases WHERE id = ? AND tenant_id = ? AND account_set_id = ? AND user_id = ?`)
      .get(id, context.tenantId, context.accountSetId, context.userId) as unknown as KnowledgeBaseRow | undefined;
    if (!row) throw new KnowledgeStoreError("知识库不存在或无权访问", 404);
    return row;
  }

  private ownedDocument(context: RequestContext, id: string) {
    const row = this.database.prepare(`
      SELECT d.id, d.knowledge_base_id, d.filename, d.file_type, d.size, d.status, d.error, d.chunk_count, d.created_at, d.updated_at
      FROM knowledge_documents d JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
      WHERE d.id = ? AND kb.tenant_id = ? AND kb.account_set_id = ? AND kb.user_id = ?
    `).get(id, context.tenantId, context.accountSetId, context.userId) as unknown as DocumentRow | undefined;
    if (!row) throw new KnowledgeStoreError("文档不存在或无权访问", 404);
    return row;
  }
}

export const defaultRetrievalConfig: RetrievalConfig = {
  chunkSize: 800,
  chunkOverlap: 120,
  embeddingModel: "local-hash-embedding-v1",
  topK: 5,
  scoreThreshold: 0.2,
  rerank: false,
  rerankModel: "local-keyword-reranker-v1",
};

export function normalizeConfig(input: Partial<RetrievalConfig> = {}): RetrievalConfig {
  const chunkSize = integer(input.chunkSize, defaultRetrievalConfig.chunkSize, 100, 4000);
  return {
    chunkSize,
    chunkOverlap: integer(input.chunkOverlap, defaultRetrievalConfig.chunkOverlap, 0, Math.max(0, chunkSize - 1)),
    embeddingModel: cleanModel(input.embeddingModel, defaultRetrievalConfig.embeddingModel),
    topK: integer(input.topK, defaultRetrievalConfig.topK, 1, 50),
    scoreThreshold: decimal(input.scoreThreshold, defaultRetrievalConfig.scoreThreshold, -1, 1),
    rerank: input.rerank === undefined ? defaultRetrievalConfig.rerank : Boolean(input.rerank),
    rerankModel: cleanModel(input.rerankModel, defaultRetrievalConfig.rerankModel),
  };
}

function toKnowledgeBase(row: KnowledgeBaseRow): KnowledgeBase {
  return { id: row.id, name: row.name, description: row.description, documentCount: Number(row.document_count || 0), chunkCount: Number(row.chunk_count || 0), config: parseConfig(row.config_json), createdAt: row.created_at, updatedAt: row.updated_at };
}
function toDocument(row: DocumentRow): KnowledgeDocument {
  return { id: row.id, knowledgeBaseId: row.knowledge_base_id, filename: row.filename, fileType: row.file_type, size: Number(row.size), status: row.status, error: row.error || undefined, chunkCount: Number(row.chunk_count), createdAt: row.created_at, updatedAt: row.updated_at };
}
function parseConfig(value: string) { try { return normalizeConfig(JSON.parse(value) as Partial<RetrievalConfig>); } catch { return { ...defaultRetrievalConfig }; } }
function cleanName(value: unknown) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, 80); }
function cleanModel(value: unknown, fallback: string) { return String(value || fallback).trim().slice(0, 120) || fallback; }
function integer(value: unknown, fallback: number, min: number, max: number) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback; }
function decimal(value: unknown, fallback: number, min: number, max: number) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback; }
