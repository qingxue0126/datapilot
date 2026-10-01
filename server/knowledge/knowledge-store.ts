import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RequestContext } from "../core/types.js";
import type { Metadata } from "./vector-store.js";

export type ParserType = "general" | "table" | "qa";
export type LegacyColumnRole = "index" | "metadata" | "both" | "ignore";
export type ColumnAttributes = { content: boolean; embedding: boolean; metadata: boolean };
export type ColumnRoleInput = LegacyColumnRole | ColumnAttributes;
export type ColumnMode = "auto" | "manual";
export type ChunkStrategy = "fixed" | "paragraph" | "heading" | "table-row" | "qa-pair";
export type VectorIndexType = "HNSW";
export type VectorMetricType = "COSINE" | "IP" | "L2";
export type KnowledgePermission = "private" | "team";

export type RetrievalConfig = {
  language: "zh-CN" | "en";
  parserType: ParserType;
  chunkStrategy: ChunkStrategy;
  chunkSize: number;
  chunkOverlap: number;
  questionColumn: string;
  answerColumn: string;
  metadataFields: string[];
  columnMode: ColumnMode;
  columnRoles: Record<string, ColumnAttributes>;
  embeddingModel: string;
  indexType: VectorIndexType;
  metricType: VectorMetricType;
  hnswM: number;
  hnswEfConstruction: number;
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
  requiresReindex: boolean;
  permission: KnowledgePermission;
  isOwner: boolean;
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
  parserType: ParserType;
  columns: string[];
  status: "uploaded" | "parsing" | "chunking" | "embedding" | "ready" | "failed";
  error?: string;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeChunk = {
  id: string;
  knowledgeBaseId: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  embeddingContent: string;
  metadata: Metadata;
  enabled: boolean;
  characterCount: number;
  tokenCount: number;
  createdAt: string;
  updatedAt: string;
};

type KnowledgeBaseRow = {
  id: string; user_id: string; name: string; description: string; permission: KnowledgePermission; config_json: string; requires_reindex: number;
  created_at: string; updated_at: string; document_count?: number; chunk_count?: number;
};
type DocumentRow = {
  id: string; knowledge_base_id: string; filename: string; file_type: string; size: number;
  parser_type: ParserType; columns_json: string; source_data?: Uint8Array | null;
  status: KnowledgeDocument["status"]; error: string | null; chunk_count: number;
  created_at: string; updated_at: string;
};
type ChunkRow = {
  id: string; knowledge_base_id: string; document_id: string; chunk_index: number; content: string;
  embedding_content: string; metadata_json: string; enabled: number; created_at: string; updated_at: string;
};
type ChunkMetadataRow = { metadata_json: string };

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
        permission TEXT NOT NULL DEFAULT 'private',
        config_json TEXT NOT NULL,
        requires_reindex INTEGER NOT NULL DEFAULT 0,
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
        parser_type TEXT NOT NULL DEFAULT 'general',
        columns_json TEXT NOT NULL DEFAULT '[]',
        source_data BLOB,
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
        embedding_content TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS knowledge_chunks_document_idx ON knowledge_chunks (document_id, chunk_index);
      CREATE TABLE IF NOT EXISTS knowledge_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
    `);
    this.ensureColumn("knowledge_bases", "requires_reindex", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("knowledge_bases", "permission", "TEXT NOT NULL DEFAULT 'private'");
    this.ensureColumn("knowledge_documents", "parser_type", "TEXT NOT NULL DEFAULT 'general'");
    this.ensureColumn("knowledge_documents", "columns_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("knowledge_documents", "source_data", "BLOB");
    this.ensureColumn("knowledge_chunks", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");
    const addedEmbeddingContent = this.ensureColumn("knowledge_chunks", "embedding_content", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("knowledge_chunks", "enabled", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("knowledge_chunks", "updated_at", "TEXT");
    this.database.exec("UPDATE knowledge_chunks SET updated_at = created_at WHERE updated_at IS NULL");
    if (addedEmbeddingContent) this.database.exec("UPDATE knowledge_chunks SET embedding_content = content");
    this.migrateVectorCollectionScope();
    this.repairDocumentFilenames();
  }

  list(context: RequestContext) {
    const rows = this.database.prepare(`
      SELECT kb.id, kb.user_id, kb.name, kb.description, kb.permission, kb.config_json, kb.requires_reindex, kb.created_at, kb.updated_at,
        COUNT(DISTINCT d.id) AS document_count, COUNT(c.id) AS chunk_count
      FROM knowledge_bases kb
      LEFT JOIN knowledge_documents d ON d.knowledge_base_id = kb.id
      LEFT JOIN knowledge_chunks c ON c.document_id = d.id
      WHERE kb.tenant_id = ? AND kb.account_set_id = ? AND (kb.user_id = ? OR kb.permission = 'team')
      GROUP BY kb.id ORDER BY kb.updated_at DESC, kb.id DESC
    `).all(context.tenantId, context.accountSetId, context.userId) as unknown as KnowledgeBaseRow[];
    return rows.map((row) => toKnowledgeBase(row, context.userId));
  }

  create(context: RequestContext, input: { name: string; description?: string; permission?: KnowledgePermission; config?: Partial<RetrievalConfig> }) {
    const name = cleanName(input.name);
    if (!name) throw new KnowledgeStoreError("知识库名称不能为空");
    const id = randomUUID(); const now = new Date().toISOString();
    const config = normalizeConfig(input.config);
    const permission = normalizePermission(input.permission);
    this.database.prepare(`INSERT INTO knowledge_bases
      (id, tenant_id, account_set_id, user_id, name, description, permission, config_json, requires_reindex, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
      .run(id, context.tenantId, context.accountSetId, context.userId, name, String(input.description || "").trim().slice(0, 500), permission, JSON.stringify(config), now, now);
    return this.get(context, id).knowledgeBase;
  }

  get(context: RequestContext, id: string) {
    const row = this.readableBase(context, id);
    const documents = this.database.prepare(`
      SELECT id, knowledge_base_id, filename, file_type, size, parser_type, columns_json, status, error,
        chunk_count, created_at, updated_at
      FROM knowledge_documents WHERE knowledge_base_id = ? ORDER BY created_at DESC, id DESC
    `).all(id) as unknown as DocumentRow[];
    return {
      knowledgeBase: {
        ...toKnowledgeBase(row, context.userId),
        documentCount: documents.length,
        chunkCount: documents.reduce((sum, item) => sum + Number(item.chunk_count), 0),
      },
      documents: documents.map(toDocument),
    };
  }

  update(context: RequestContext, id: string, input: { name?: string; description?: string; permission?: KnowledgePermission; config?: Partial<RetrievalConfig> }) {
    const current = this.ownedBase(context, id); const now = new Date().toISOString();
    const name = input.name === undefined ? current.name : cleanName(input.name);
    if (!name) throw new KnowledgeStoreError("知识库名称不能为空");
    const description = input.description === undefined ? current.description : String(input.description).trim().slice(0, 500);
    const permission = input.permission === undefined ? current.permission : normalizePermission(input.permission);
    const previousConfig = parseConfig(current.config_json);
    const config = normalizeConfig({ ...previousConfig, ...input.config });
    const vectorConfigChanged = config.embeddingModel !== previousConfig.embeddingModel
      || config.indexType !== previousConfig.indexType
      || config.metricType !== previousConfig.metricType
      || config.hnswM !== previousConfig.hnswM
      || config.hnswEfConstruction !== previousConfig.hnswEfConstruction;
    this.database.prepare(`
      UPDATE knowledge_bases SET name = ?, description = ?, permission = ?, config_json = ?,
        requires_reindex = CASE WHEN ? THEN 1 ELSE requires_reindex END, updated_at = ? WHERE id = ?
    `).run(name, description, permission, JSON.stringify(config), vectorConfigChanged ? 1 : 0, now, id);
    return this.get(context, id).knowledgeBase;
  }

  markReindexed(context: RequestContext, id: string) {
    this.ownedBase(context, id);
    this.database.prepare("UPDATE knowledge_bases SET requires_reindex = 0, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  markRequiresReindex(context: RequestContext, id: string) {
    this.ownedBase(context, id);
    this.database.prepare("UPDATE knowledge_bases SET requires_reindex = 1, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  private migrateVectorCollectionScope() {
    const key = "milvus_collection_scope_v2";
    const migrated = this.database.prepare("SELECT value FROM knowledge_meta WHERE key = ?").get(key);
    if (migrated) return;
    this.database.exec("UPDATE knowledge_bases SET requires_reindex = 1 WHERE id IN (SELECT DISTINCT knowledge_base_id FROM knowledge_chunks)");
    this.database.prepare("INSERT INTO knowledge_meta (key, value) VALUES (?, ?)").run(key, new Date().toISOString());
  }

  delete(context: RequestContext, id: string) {
    this.ownedBase(context, id);
    this.database.prepare("DELETE FROM knowledge_bases WHERE id = ?").run(id);
  }

  createDocument(context: RequestContext, knowledgeBaseId: string, input: {
    filename: string; fileType: string; size: number; parserType?: ParserType; source?: Buffer;
  }) {
    this.ownedBase(context, knowledgeBaseId);
    const id = randomUUID(); const now = new Date().toISOString();
    const filename = normalizeDocumentFilename(input.filename).slice(0, 240);
    this.database.prepare(`INSERT INTO knowledge_documents
      (id, knowledge_base_id, filename, file_type, size, parser_type, columns_json, source_data, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 'uploaded', ?, ?)`)
      .run(id, knowledgeBaseId, filename, input.fileType, input.size, input.parserType || "general", input.source || Buffer.alloc(0), now, now);
    return this.document(context, id);
  }

  setDocumentStatus(context: RequestContext, id: string, status: KnowledgeDocument["status"], error?: string) {
    this.ownedDocument(context, id);
    this.database.prepare("UPDATE knowledge_documents SET status = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(status, error || null, new Date().toISOString(), id);
  }

  setDocumentParsing(context: RequestContext, id: string, parserType: ParserType, columns: string[]) {
    this.ownedDocument(context, id);
    this.database.prepare("UPDATE knowledge_documents SET parser_type = ?, columns_json = ?, updated_at = ? WHERE id = ?")
      .run(parserType, JSON.stringify(uniqueStrings(columns)), new Date().toISOString(), id);
  }

  documentSource(context: RequestContext, id: string) {
    const row = this.readableDocument(context, id, true);
    if (!row.source_data) throw new KnowledgeStoreError("文档原始文件不存在，无法重新解析", 409);
    return Buffer.from(row.source_data);
  }

  replaceChunks(context: RequestContext, documentId: string, chunks: { id: string; content: string; embeddingContent?: string; metadata?: Metadata; enabled?: boolean }[]) {
    const document = this.ownedDocument(context, documentId); const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM knowledge_chunks WHERE document_id = ?").run(documentId);
      const insert = this.database.prepare(`INSERT INTO knowledge_chunks
        (id, knowledge_base_id, document_id, chunk_index, content, embedding_content, metadata_json, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      chunks.forEach((chunk, index) => insert.run(
        chunk.id, document.knowledge_base_id, documentId, index, chunk.content, chunk.embeddingContent ?? chunk.content,
        JSON.stringify(normalizeMetadata(chunk.metadata)), chunk.enabled === false ? 0 : 1, now, now,
      ));
      this.database.prepare("UPDATE knowledge_documents SET chunk_count = ?, updated_at = ? WHERE id = ?").run(chunks.length, now, documentId);
      this.database.prepare("UPDATE knowledge_bases SET updated_at = ? WHERE id = ?").run(now, document.knowledge_base_id);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  document(context: RequestContext, id: string) { return toDocument(this.readableDocument(context, id)); }

  listChunks(context: RequestContext, documentId: string) {
    this.readableDocument(context, documentId);
    const rows = this.database.prepare(`
      SELECT c.id, c.knowledge_base_id, c.document_id, c.chunk_index, c.content, c.embedding_content, c.metadata_json,
        c.enabled, c.created_at, c.updated_at
      FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
      JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
      WHERE c.document_id = ? AND kb.tenant_id = ? AND kb.account_set_id = ? AND (kb.user_id = ? OR kb.permission = 'team')
      ORDER BY c.chunk_index ASC
    `).all(documentId, context.tenantId, context.accountSetId, context.userId) as unknown as ChunkRow[];
    return rows.map(toChunk);
  }

  listBaseChunks(context: RequestContext, knowledgeBaseId: string) {
    this.readableBase(context, knowledgeBaseId);
    const rows = this.database.prepare(`
      SELECT id, knowledge_base_id, document_id, chunk_index, content, embedding_content, metadata_json, enabled, created_at, updated_at
      FROM knowledge_chunks WHERE knowledge_base_id = ? ORDER BY document_id, chunk_index
    `).all(knowledgeBaseId) as unknown as ChunkRow[];
    return rows.map(toChunk);
  }

  metadataSchema(context: RequestContext, knowledgeBaseId: string) {
    this.readableBase(context, knowledgeBaseId);
    const rows = this.database.prepare("SELECT metadata_json FROM knowledge_chunks WHERE knowledge_base_id=?")
      .all(knowledgeBaseId) as unknown as ChunkMetadataRow[];
    const schema = new Map<string, Set<string>>();
    for (const row of rows) {
      const metadata = JSON.parse(row.metadata_json) as Metadata;
      for (const [field, value] of Object.entries(metadata)) {
        const types = schema.get(field) || new Set<string>();
        types.add(typeof value); schema.set(field, types);
      }
    }
    return schema;
  }

  metadataFacets(context: RequestContext, knowledgeBaseId: string) {
    this.readableBase(context, knowledgeBaseId);
    const chunks = this.listBaseChunks(context, knowledgeBaseId);
    const facets = new Map<string, { types: Set<string>; values: Set<string | number | boolean> }>();
    for (const chunk of chunks) {
      for (const [field, value] of Object.entries(chunk.metadata)) {
        const facet = facets.get(field) || { types: new Set<string>(), values: new Set<string | number | boolean>() };
        facet.types.add(typeof value);
        if (facet.values.size < 100) facet.values.add(value);
        facets.set(field, facet);
      }
    }
    return [...facets.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([field, facet]) => ({
      field, types: [...facet.types].sort(), values: [...facet.values],
    }));
  }

  chunk(context: RequestContext, id: string) { return toChunk(this.readableChunk(context, id)); }

  retrievalContext(context: RequestContext, knowledgeBaseId: string): RequestContext {
    const row = this.readableBase(context, knowledgeBaseId);
    return row.user_id === context.userId ? context : { ...context, userId: row.user_id };
  }

  updateChunk(context: RequestContext, id: string, input: { content?: string; embeddingContent?: string; metadata?: Metadata; enabled?: boolean }) {
    const current = this.ownedChunk(context, id); const now = new Date().toISOString();
    const content = input.content === undefined ? current.content : String(input.content).trim();
    if (!content) throw new KnowledgeStoreError("Chunk 内容不能为空");
    const embeddingContent = input.embeddingContent === undefined
      ? input.content === undefined ? current.embedding_content : content
      : String(input.embeddingContent).trim();
    const metadata = input.metadata === undefined ? parseMetadata(current.metadata_json) : normalizeMetadata(input.metadata);
    const enabled = input.enabled === undefined ? Boolean(current.enabled) : Boolean(input.enabled);
    this.database.prepare("UPDATE knowledge_chunks SET content = ?, embedding_content = ?, metadata_json = ?, enabled = ?, updated_at = ? WHERE id = ?")
      .run(content, embeddingContent, JSON.stringify(metadata), enabled ? 1 : 0, now, id);
    this.database.prepare("UPDATE knowledge_bases SET updated_at = ? WHERE id = ?").run(now, current.knowledge_base_id);
    return this.chunk(context, id);
  }

  deleteDocument(context: RequestContext, id: string) {
    const document = this.ownedDocument(context, id);
    this.database.prepare("DELETE FROM knowledge_documents WHERE id = ?").run(id);
    this.database.prepare("UPDATE knowledge_bases SET updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), document.knowledge_base_id);
    return document.knowledge_base_id;
  }

  close() { this.database.close(); }

  private ownedBase(context: RequestContext, id: string) {
    const row = this.database.prepare(`
      SELECT id, user_id, name, description, permission, config_json, requires_reindex, created_at, updated_at
      FROM knowledge_bases WHERE id = ? AND tenant_id = ? AND account_set_id = ? AND user_id = ?
    `).get(id, context.tenantId, context.accountSetId, context.userId) as unknown as KnowledgeBaseRow | undefined;
    if (!row) throw new KnowledgeStoreError("知识库不存在或无权访问", 404);
    return row;
  }

  private readableBase(context: RequestContext, id: string) {
    const row = this.database.prepare(`
      SELECT id, user_id, name, description, permission, config_json, requires_reindex, created_at, updated_at
      FROM knowledge_bases
      WHERE id = ? AND tenant_id = ? AND account_set_id = ? AND (user_id = ? OR permission = 'team')
    `).get(id, context.tenantId, context.accountSetId, context.userId) as unknown as KnowledgeBaseRow | undefined;
    if (!row) throw new KnowledgeStoreError("知识库不存在或无权访问", 404);
    return row;
  }

  private ownedDocument(context: RequestContext, id: string, includeSource = false) {
    const source = includeSource ? ", d.source_data" : "";
    const row = this.database.prepare(`
      SELECT d.id, d.knowledge_base_id, d.filename, d.file_type, d.size, d.parser_type, d.columns_json,
        d.status, d.error, d.chunk_count, d.created_at, d.updated_at ${source}
      FROM knowledge_documents d JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
      WHERE d.id = ? AND kb.tenant_id = ? AND kb.account_set_id = ? AND kb.user_id = ?
    `).get(id, context.tenantId, context.accountSetId, context.userId) as unknown as DocumentRow | undefined;
    if (!row) throw new KnowledgeStoreError("文档不存在或无权访问", 404);
    return row;
  }

  private readableDocument(context: RequestContext, id: string, includeSource = false) {
    const source = includeSource ? ", d.source_data" : "";
    const row = this.database.prepare(`
      SELECT d.id, d.knowledge_base_id, d.filename, d.file_type, d.size, d.parser_type, d.columns_json,
        d.status, d.error, d.chunk_count, d.created_at, d.updated_at ${source}
      FROM knowledge_documents d JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
      WHERE d.id = ? AND kb.tenant_id = ? AND kb.account_set_id = ? AND (kb.user_id = ? OR kb.permission = 'team')
    `).get(id, context.tenantId, context.accountSetId, context.userId) as unknown as DocumentRow | undefined;
    if (!row) throw new KnowledgeStoreError("文档不存在或无权访问", 404);
    return row;
  }

  private ownedChunk(context: RequestContext, id: string) {
    const row = this.database.prepare(`
      SELECT c.id, c.knowledge_base_id, c.document_id, c.chunk_index, c.content, c.embedding_content, c.metadata_json,
        c.enabled, c.created_at, c.updated_at
      FROM knowledge_chunks c JOIN knowledge_bases kb ON kb.id = c.knowledge_base_id
      WHERE c.id = ? AND kb.tenant_id = ? AND kb.account_set_id = ? AND kb.user_id = ?
    `).get(id, context.tenantId, context.accountSetId, context.userId) as unknown as ChunkRow | undefined;
    if (!row) throw new KnowledgeStoreError("Chunk 不存在或无权访问", 404);
    return row;
  }

  private readableChunk(context: RequestContext, id: string) {
    const row = this.database.prepare(`
      SELECT c.id, c.knowledge_base_id, c.document_id, c.chunk_index, c.content, c.embedding_content, c.metadata_json,
        c.enabled, c.created_at, c.updated_at
      FROM knowledge_chunks c JOIN knowledge_bases kb ON kb.id = c.knowledge_base_id
      WHERE c.id = ? AND kb.tenant_id = ? AND kb.account_set_id = ? AND (kb.user_id = ? OR kb.permission = 'team')
    `).get(id, context.tenantId, context.accountSetId, context.userId) as unknown as ChunkRow | undefined;
    if (!row) throw new KnowledgeStoreError("Chunk 不存在或无权访问", 404);
    return row;
  }

  private ensureColumn(table: string, column: string, definition: string) {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    if (columns.some((item) => item.name === column)) return false;
    this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  }

  private repairDocumentFilenames() {
    const rows = this.database.prepare("SELECT id, filename FROM knowledge_documents").all() as unknown as { id: string; filename: string }[];
    const update = this.database.prepare("UPDATE knowledge_documents SET filename = ? WHERE id = ?");
    for (const row of rows) {
      const filename = normalizeDocumentFilename(row.filename);
      if (filename !== row.filename) update.run(filename, row.id);
    }
  }
}

/** Multer exposes UTF-8 multipart filenames as Latin-1; repair that lossless byte interpretation. */
export function normalizeDocumentFilename(value: string) {
  const filename = String(value || "").normalize("NFC");
  if (!/[\u0080-\u00ff]/.test(filename)) return filename;
  const decoded = Buffer.from(filename, "latin1").toString("utf8").normalize("NFC");
  return decoded.includes("\uFFFD") ? filename : decoded;
}

export const defaultRetrievalConfig: RetrievalConfig = {
  language: "zh-CN",
  parserType: "general",
  chunkStrategy: "fixed",
  chunkSize: 800,
  chunkOverlap: 120,
  questionColumn: "问题",
  answerColumn: "答案",
  metadataFields: [],
  columnMode: "auto",
  columnRoles: {},
  embeddingModel: process.env.NODE_ENV === "production" ? "" : "local-hash-embedding-v1",
  indexType: "HNSW",
  metricType: "IP",
  hnswM: 16,
  hnswEfConstruction: 200,
  topK: 5,
  scoreThreshold: 0.2,
  rerank: false,
  rerankModel: "local-keyword-reranker-v1",
};

export function normalizeConfig(input: Partial<RetrievalConfig> = {}): RetrievalConfig {
  const chunkSize = integer(input.chunkSize, defaultRetrievalConfig.chunkSize, 100, 4000);
  return {
    language: input.language === "en" ? "en" : "zh-CN",
    parserType: parserType(input.parserType),
    chunkStrategy: chunkStrategy(input.chunkStrategy, input.parserType),
    chunkSize,
    chunkOverlap: integer(input.chunkOverlap, defaultRetrievalConfig.chunkOverlap, 0, Math.max(0, chunkSize - 1)),
    questionColumn: cleanColumn(input.questionColumn, defaultRetrievalConfig.questionColumn),
    answerColumn: cleanColumn(input.answerColumn, defaultRetrievalConfig.answerColumn),
    metadataFields: uniqueStrings(input.metadataFields).slice(0, 100),
    columnMode: input.columnMode === "manual" || (!input.columnMode && Object.keys(input.columnRoles || {}).length > 0) ? "manual" : "auto",
    columnRoles: normalizeColumnRoles(input.columnRoles),
    embeddingModel: cleanModel(input.embeddingModel, defaultRetrievalConfig.embeddingModel),
    indexType: "HNSW",
    metricType: metricType(input.metricType),
    hnswM: integer(input.hnswM, defaultRetrievalConfig.hnswM, 4, 64),
    hnswEfConstruction: integer(input.hnswEfConstruction, defaultRetrievalConfig.hnswEfConstruction, 8, 512),
    topK: integer(input.topK, defaultRetrievalConfig.topK, 1, 50),
    scoreThreshold: decimal(input.scoreThreshold, defaultRetrievalConfig.scoreThreshold, -1, 1),
    rerank: input.rerank === undefined ? defaultRetrievalConfig.rerank : Boolean(input.rerank),
    rerankModel: cleanModel(input.rerankModel, defaultRetrievalConfig.rerankModel),
  };
}

function toKnowledgeBase(row: KnowledgeBaseRow, currentUserId: string): KnowledgeBase {
  return {
    id: row.id, name: row.name, description: row.description,
    documentCount: Number(row.document_count || 0), chunkCount: Number(row.chunk_count || 0),
    requiresReindex: Boolean(row.requires_reindex), permission: normalizePermission(row.permission), isOwner: row.user_id === currentUserId,
    config: parseConfig(row.config_json),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function toDocument(row: DocumentRow): KnowledgeDocument {
  return {
    id: row.id, knowledgeBaseId: row.knowledge_base_id, filename: row.filename, fileType: row.file_type,
    size: Number(row.size), parserType: parserType(row.parser_type), columns: parseStringArray(row.columns_json),
    status: row.status, error: row.error || undefined, chunkCount: Number(row.chunk_count),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function toChunk(row: ChunkRow): KnowledgeChunk {
  return {
    id: row.id, knowledgeBaseId: row.knowledge_base_id, documentId: row.document_id,
    chunkIndex: Number(row.chunk_index), content: row.content, embeddingContent: row.embedding_content, metadata: parseMetadata(row.metadata_json),
    enabled: Boolean(row.enabled), characterCount: row.content.length, tokenCount: estimateTokens(row.content),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function parseConfig(value: string) { try { return normalizeConfig(JSON.parse(value) as Partial<RetrievalConfig>); } catch { return { ...defaultRetrievalConfig }; } }
function parseMetadata(value: string): Metadata { try { return normalizeMetadata(JSON.parse(value)); } catch { return {}; } }
function parseStringArray(value: string) { try { return uniqueStrings(JSON.parse(value)); } catch { return []; } }
function normalizeMetadata(value: unknown): Metadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, item]) => ["string", "number", "boolean"].includes(typeof item) || item === null).slice(0, 100)) as Metadata;
}
function cleanName(value: unknown) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, 80); }
function normalizePermission(value: unknown): KnowledgePermission {
  if (value === undefined || value === null || value === "" || value === "private") return "private";
  if (value === "team") return "team";
  throw new KnowledgeStoreError("权限仅支持 private 或 team");
}
function cleanModel(value: unknown, fallback: string) { return String(value ?? fallback).trim().slice(0, 120) || fallback; }
function cleanColumn(value: unknown, fallback: string) { return String(value || fallback).trim().slice(0, 120) || fallback; }
function parserType(value: unknown): ParserType { return value === "table" || value === "qa" ? value : "general"; }
function chunkStrategy(value: unknown, parser: unknown): ChunkStrategy {
  const type = parserType(parser);
  if (type === "table") return "table-row";
  if (type === "qa") return "qa-pair";
  return value === "paragraph" || value === "heading" ? value : "fixed";
}
function metricType(value: unknown): VectorMetricType { return value === "COSINE" || value === "L2" ? value : "IP"; }
function normalizeColumnRoles(value: unknown): Record<string, ColumnAttributes> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([column, role]) => [column.trim(), normalizeColumnAttributes(role)] as const)
    .filter((entry): entry is [string, ColumnAttributes] => Boolean(entry[0] && entry[1]))
    .slice(0, 100));
}

export function normalizeColumnAttributes(value: unknown): ColumnAttributes | undefined {
  if (value === "index") return { content: true, embedding: true, metadata: false };
  if (value === "metadata") return { content: false, embedding: false, metadata: true };
  if (value === "both") return { content: true, embedding: true, metadata: true };
  if (value === "ignore") return { content: false, embedding: false, metadata: false };
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const attributes = value as Record<string, unknown>;
  return { content: attributes.content === true, embedding: attributes.embedding === true, metadata: attributes.metadata === true };
}

export function inferColumnAttributes(column: string): ColumnAttributes {
  const normalized = column.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (/^(id|uuid|序号|行号|编号|主键)$/.test(normalized) || /^(?:[a-z\u4e00-\u9fff][a-z0-9\u4e00-\u9fff]*)id$/.test(normalized) || /(?:^|业务|记录)(?:id|编号)$/.test(normalized)) {
    return { content: false, embedding: false, metadata: false };
  }
  if (/(product|module|category|classification|domain|questiontype|problemtype|产品|模块|领域|分类|类别|类型)/.test(normalized)) {
    return { content: false, embedding: false, metadata: true };
  }
  if (/(question|answer|description|content|text|title|问题|答案|描述|内容|正文|标题)/.test(normalized)) {
    return { content: true, embedding: true, metadata: false };
  }
  // Preserve the former Auto behavior for unknown business columns.
  return { content: true, embedding: true, metadata: true };
}
function uniqueStrings(value: unknown) { return Array.isArray(value) ? [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))] : []; }
function integer(value: unknown, fallback: number, min: number, max: number) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback; }
function decimal(value: unknown, fallback: number, min: number, max: number) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback; }
function estimateTokens(content: string) { const words = content.match(/[a-z0-9_]+|[\p{Script=Han}]/giu)?.length || 0; return Math.max(1, words); }
