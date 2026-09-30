import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import type { ChatTurn, RequestContext } from "../core/types.js";

export type AnalysisSession = {
  id: string;
  title: string;
  pinned: boolean;
  datasourceId?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type AnalysisMessage = {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  result?: Record<string, unknown>;
  createdAt: string;
};

export type AnalysisSessionDetail = {
  session: AnalysisSession;
  messages: AnalysisMessage[];
};

export interface SessionStore {
  create(context: RequestContext, input?: { title?: string; datasourceId?: string }): AnalysisSession;
  list(context: RequestContext): AnalysisSession[];
  get(context: RequestContext, sessionId: string): AnalysisSessionDetail;
  update(context: RequestContext, sessionId: string, input: { title?: string; datasourceId?: string | null; pinned?: boolean }): AnalysisSession;
  delete(context: RequestContext, sessionId: string): void;
  history(context: RequestContext, sessionId: string): ChatTurn[];
  appendExchange(context: RequestContext, sessionId: string, input: {
    question: string;
    answer: string;
    datasourceId?: string;
    result: Record<string, unknown>;
  }): { session: AnalysisSession; messages: [AnalysisMessage, AnalysisMessage] };
}

type SessionRow = {
  id: string;
  title: string;
  pinned: number;
  datasource_id: string | null;
  created_at: string;
  updated_at: string;
  message_count?: number;
};

type MessageRow = {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  result_json: string | null;
  created_at: string;
};

export class SessionStoreError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** Persistent, ownership-scoped session repository for the Node API runtime. */
export class SqliteSessionStore implements SessionStore {
  private readonly database: DatabaseSync;
  private readonly contextTurns: number;

  constructor(databasePath = process.env.SESSION_DB_PATH || resolve(".data", "sessions.sqlite"), contextTurns = Number(process.env.SESSION_CONTEXT_TURNS || 10)) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.contextTurns = Number.isFinite(contextTurns) && contextTurns > 0 ? Math.floor(contextTurns) : 10;
    this.database.exec("PRAGMA foreign_keys = ON");
    if (databasePath !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  create(context: RequestContext, input: { title?: string; datasourceId?: string } = {}) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const title = cleanTitle(input.title) || "新分析";
    this.database.prepare(`
      INSERT INTO sessions (id, tenant_id, account_set_id, user_id, title, title_manually_edited, pinned, datasource_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(id, context.tenantId, context.accountSetId, context.userId, title, title !== "新分析" ? 1 : 0, input.datasourceId || null, now, now);
    return this.get(context, id).session;
  }

  list(context: RequestContext) {
    const rows = this.database.prepare(`
      SELECT s.id, s.title, s.pinned, s.datasource_id, s.created_at, s.updated_at, COUNT(m.id) AS message_count
      FROM sessions s LEFT JOIN messages m ON m.session_id = s.id
      WHERE s.tenant_id = ? AND s.account_set_id = ? AND s.user_id = ?
      GROUP BY s.id
      ORDER BY s.pinned DESC, s.updated_at DESC, s.id DESC
    `).all(context.tenantId, context.accountSetId, context.userId) as unknown as SessionRow[];
    return rows.map(toSession);
  }

  get(context: RequestContext, sessionId: string) {
    const row = this.ownedRow(context, sessionId);
    const messageRows = this.database.prepare(`
      SELECT id, session_id, role, content, result_json, created_at
      FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC
    `).all(sessionId) as unknown as MessageRow[];
    return { session: { ...toSession(row), messageCount: messageRows.length }, messages: messageRows.map(toMessage) };
  }

  update(context: RequestContext, sessionId: string, input: { title?: string; datasourceId?: string | null; pinned?: boolean }) {
    this.ownedRow(context, sessionId);
    const now = new Date().toISOString();
    if (input.title !== undefined) {
      const title = cleanTitle(input.title);
      if (!title) throw new SessionStoreError("分析标题不能为空");
      this.database.prepare(`UPDATE sessions SET title = ?, title_manually_edited = 1, updated_at = ? WHERE id = ?`).run(title, now, sessionId);
    }
    if (input.datasourceId !== undefined) {
      this.database.prepare(`UPDATE sessions SET datasource_id = ?, updated_at = ? WHERE id = ?`).run(input.datasourceId || null, now, sessionId);
    }
    if (input.pinned !== undefined) {
      this.database.prepare(`UPDATE sessions SET pinned = ?, updated_at = ? WHERE id = ?`).run(input.pinned ? 1 : 0, now, sessionId);
    }
    return this.get(context, sessionId).session;
  }

  delete(context: RequestContext, sessionId: string) {
    this.ownedRow(context, sessionId);
    this.database.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
  }

  history(context: RequestContext, sessionId: string) {
    this.ownedRow(context, sessionId);
    const rows = this.database.prepare(`
      SELECT content, result_json, created_at FROM messages
      WHERE session_id = ? AND role = 'assistant'
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(sessionId, this.contextTurns) as unknown as Pick<MessageRow, "content" | "result_json" | "created_at">[];
    return rows.reverse().map((row) => {
      const result = parseResult(row.result_json);
      return {
        question: typeof result?.question === "string" ? result.question : "",
        answer: row.content,
        sql: typeof result?.sql === "string" ? result.sql : undefined,
        createdAt: Date.parse(row.created_at),
      };
    }).filter((turn) => turn.question);
  }

  appendExchange(context: RequestContext, sessionId: string, input: { question: string; answer: string; datasourceId?: string; result: Record<string, unknown> }) {
    const owned = this.ownedRow(context, sessionId, true);
    const firstQuestion = Number(this.database.prepare(`SELECT COUNT(*) AS count FROM messages WHERE session_id = ? AND role = 'user'`).get(sessionId)?.count || 0) === 0;
    const userMessage: AnalysisMessage = {
      id: randomUUID(), sessionId, role: "user", content: input.question, createdAt: new Date().toISOString(),
    };
    const assistantMessage: AnalysisMessage = {
      id: randomUUID(), sessionId, role: "assistant", content: input.answer,
      result: input.result, createdAt: new Date(Date.now() + 1).toISOString(),
    };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`INSERT INTO messages (id, session_id, role, content, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(userMessage.id, sessionId, userMessage.role, userMessage.content, null, userMessage.createdAt);
      this.database.prepare(`INSERT INTO messages (id, session_id, role, content, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(assistantMessage.id, sessionId, assistantMessage.role, assistantMessage.content, JSON.stringify(input.result), assistantMessage.createdAt);
      const autoTitle = firstQuestion && Number(owned.title_manually_edited || 0) === 0;
      this.database.prepare(`UPDATE sessions SET title = ?, datasource_id = ?, updated_at = ? WHERE id = ?`)
        .run(autoTitle ? titleFromQuestion(input.question) : owned.title, input.datasourceId ?? owned.datasource_id, assistantMessage.createdAt, sessionId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { session: this.get(context, sessionId).session, messages: [userMessage, assistantMessage] as [AnalysisMessage, AnalysisMessage] };
  }

  close() { this.database.close(); }

  private ownedRow(context: RequestContext, sessionId: string, includeManual = false) {
    const row = this.database.prepare(`
      SELECT id, title, pinned, datasource_id, created_at, updated_at${includeManual ? ", title_manually_edited" : ""}
      FROM sessions WHERE id = ? AND tenant_id = ? AND account_set_id = ? AND user_id = ?
    `).get(sessionId, context.tenantId, context.accountSetId, context.userId) as unknown as (SessionRow & { title_manually_edited?: SQLOutputValue }) | undefined;
    if (!row) throw new SessionStoreError("分析不存在或无权访问", 404);
    return row;
  }

  private migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        account_set_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '新分析',
        title_manually_edited INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        datasource_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_owner_updated_idx ON sessions (tenant_id, account_set_id, user_id, updated_at);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_session_created_idx ON messages (session_id, created_at);
    `);
    const columns = this.database.prepare(`PRAGMA table_info(sessions)`).all() as unknown as { name: string }[];
    if (!columns.some((column) => column.name === "pinned")) {
      this.database.exec(`ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
    }
  }
}

function toSession(row: SessionRow): AnalysisSession {
  return {
    id: row.id,
    title: row.title,
    pinned: Boolean(row.pinned),
    datasourceId: row.datasource_id || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: Number(row.message_count || 0),
  };
}

function toMessage(row: MessageRow): AnalysisMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    result: parseResult(row.result_json),
    createdAt: row.created_at,
  };
}

function parseResult(value: string | null) {
  if (!value) return undefined;
  try { return JSON.parse(value) as Record<string, unknown>; }
  catch { return undefined; }
}

function cleanTitle(value?: string) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, 80); }
function titleFromQuestion(question: string) {
  const title = question.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().replace(/[？?。！!]+$/g, "");
  return title.slice(0, 20) || "新分析";
}
