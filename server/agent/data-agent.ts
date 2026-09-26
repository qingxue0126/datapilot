import { randomUUID } from "node:crypto";
import type { AgentTraceEvent, RequestContext } from "../core/types.js";
import type { DatabaseConfig } from "../database.js";
import type { PermissionService } from "../auth/permission-service.js";
import type { SessionStore } from "../context/session-store.js";
import type { ErpQueryService } from "../domain/erp/erp-query-service.js";
import type { FinanceMetricPrompt } from "../domain/erp/metrics.js";
import type { JoinPathDefinition, SchemaSearchResult, SemanticEntityMapping } from "../domain/erp/schema-mapping/types.js";
import type { ToolRegistry } from "../tools/tool-registry.js";

type QueryResult = {
  sql: string;
  rows: Record<string, unknown>[];
  columns: { key: string; label: string }[];
  rowCount: number;
  executionMs: number;
};

export class DataAgent {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly permissions: PermissionService,
    private readonly sessions: SessionStore,
    private readonly erp: ErpQueryService,
  ) {}

  async run(input: { question: string; context: RequestContext; sessionId: string; datasourceId: string; connection: DatabaseConfig }) {
    const started = Date.now();
    const runId = randomUUID();
    const trace: AgentTraceEvent[] = [];
    const toolContext = { request: input.context, datasourceId: input.datasourceId, connection: input.connection };
    this.permissions.require(input.context, "agent:query");
    assertSafeQuestion(input.question);

    const metrics = await this.step(trace, "metric.search", () =>
      this.tools.call<{ question: string }, FinanceMetricPrompt[]>("metric.search", { question: input.question }, toolContext));
    const schema = await this.step(trace, "schema.search", () =>
      this.tools.call<{ question: string; includeSamples: boolean }, SchemaSearchResult>("schema.search", { question: input.question, includeSamples: true }, toolContext));
    if (!schema.rawSchema.length) throw new Error("当前权限范围内没有可查询的业务表");

    const history = this.sessions.history(input.context, input.sessionId);
    let previousError: string | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const plan = await this.step(trace, `sql.generate.${attempt}`, () =>
          this.erp.generateSql({ question: input.question, schema, metrics, history, previousError }));
        if (!plan.sql?.trim()) throw new Error("模型没有生成 SQL");
        const result = await this.step(trace, `database.query.${attempt}`, () =>
          this.tools.call<{ sql: string }, QueryResult>("database.query", { sql: plan.sql }, toolContext));
        const summary = await this.step(trace, "result.analyze", () =>
          this.erp.analyze({ question: input.question, sql: result.sql, rows: result.rows, rowCount: result.rowCount }));
        const queryResult = {
          question: input.question,
          summary,
          sql: result.sql,
          columns: result.columns,
          rows: result.rows,
          chart: buildChart(result.rows),
          rowCount: result.rowCount,
          executionMs: Date.now() - started,
          sessionId: input.sessionId,
          explanation: buildExplanation(result.sql, metrics, schema),
          agent: { runId, attempts: attempt, tools: this.tools.list(), trace },
        };
        const persisted = this.sessions.appendExchange(input.context, input.sessionId, {
          question: input.question,
          answer: summary,
          datasourceId: input.datasourceId,
          result: queryResult,
        });
        return { ...queryResult, session: persisted.session, persistedMessages: persisted.messages };
      } catch (error) {
        previousError = safeError(error);
        if (attempt === 3) throw error;
      }
    }
    throw new Error("智能问数执行失败");
  }

  private async step<T>(trace: AgentTraceEvent[], step: string, action: () => Promise<T>) {
    const started = Date.now();
    trace.push({ step, status: "started" });
    try {
      const value = await action();
      trace.push({ step, status: "succeeded", durationMs: Date.now() - started });
      return value;
    } catch (error) {
      trace.push({ step, status: "failed", detail: safeError(error), durationMs: Date.now() - started });
      throw error;
    }
  }
}

export function assertSafeQuestion(question: string) {
  const normalized = question.trim();
  const writeOrDdl = /\b(drop|delete|update|insert|alter|truncate|create|grant|revoke|replace|call|execute)\b/i;
  const multiStatementIntent = /;[\s\S]*\b(select|with|drop|delete|update|insert|alter|truncate|create|grant|revoke|replace|call|execute)\b/i;
  if (writeOrDdl.test(normalized) || multiStatementIntent.test(normalized)) throw new Error("安全拒答：数据问答仅允许只读分析，不接受写操作、DDL 或多语句 SQL 意图");
  return question;
}

function buildExplanation(sql: string, metrics: FinanceMetricPrompt[], schema: SchemaSearchResult) {
  const mappingsUsed = schema.semanticSchema.filter((mapping) => hasIdentifier(sql, mapping.table));
  const joinPathsUsed = schema.joinPaths.filter((path) => path.validated && joinAppearsInSql(sql, path, schema.semanticSchema));
  return {
    metrics,
    semanticEntities: mappingsUsed.map((mapping) => mapping.entity),
    mappingsUsed,
    joinPathsUsed,
    mappingValidation: schema.mappingValidation,
    registryVersion: schema.registryVersion,
    mappingStatus: schema.mappingStatus,
    publishedVersion: schema.publishedVersion,
  };
}

function joinAppearsInSql(sql: string, path: JoinPathDefinition, mappings: SemanticEntityMapping[]) {
  const left = mappings.find((item) => item.entity === path.leftEntity);
  const right = mappings.find((item) => item.entity === path.rightEntity);
  return Boolean(left && right && hasIdentifier(sql, path.leftTable) && hasIdentifier(sql, path.rightTable)
    && path.fields.every((pair) => hasIdentifier(sql, left.fields[pair.leftField] || "") && hasIdentifier(sql, right.fields[pair.rightField] || "")));
}

function hasIdentifier(sql: string, identifier: string) {
  if (!identifier) return false;
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:\\\`${escaped}\\\`|\\b${escaped}\\b)`, "i").test(sql);
}

function safeError(error: unknown) { return (error instanceof Error ? error.message : "未知错误").slice(0, 300); }
function buildChart(rows: Record<string, unknown>[]) {
  if (rows.length < 2 || rows.length > 20) return undefined;
  const keys = Object.keys(rows[0] || {});
  const labelKey = keys.find((key) => typeof rows[0][key] === "string");
  const valueKey = keys.find((key) => typeof rows[0][key] === "number");
  if (!labelKey || !valueKey) return undefined;
  return rows.map((row) => ({ label: String(row[labelKey]).slice(0, 20), value: Number(row[valueKey]) })).filter((item) => Number.isFinite(item.value));
}
