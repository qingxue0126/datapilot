import { randomUUID } from "node:crypto";
import type { AgentTraceEvent, RequestContext } from "../core/types.js";
import type { DatabaseConfig } from "../database.js";
import type { PermissionService } from "../auth/permission-service.js";
import type { SessionStore } from "../context/session-store.js";
import type { ErpQueryService } from "../domain/erp/erp-query-service.js";
import type { FinanceMetricPrompt } from "../domain/erp/metrics.js";
import type { SchemaSearchResult } from "../domain/erp/schema-mapping/types.js";
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

  async run(input: { question: string; context: RequestContext; datasourceId: string; connection: DatabaseConfig }) {
    const started = Date.now();
    const runId = randomUUID();
    const trace: AgentTraceEvent[] = [];
    const toolContext = { request: input.context, datasourceId: input.datasourceId, connection: input.connection };
    this.permissions.require(input.context, "agent:query");

    const metrics = await this.step(trace, "metric.search", () =>
      this.tools.call<{ question: string }, FinanceMetricPrompt[]>("metric.search", { question: input.question }, toolContext));
    const schema = await this.step(trace, "schema.search", () =>
      this.tools.call<{ question: string }, SchemaSearchResult>("schema.search", { question: input.question }, toolContext));
    if (!schema.rawSchema.length) throw new Error("当前权限范围内没有可查询的业务表");

    const history = this.sessions.history(input.context);
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
        this.sessions.append(input.context, { question: input.question, answer: summary, sql: result.sql, createdAt: Date.now() });
        return {
          question: input.question,
          summary,
          sql: result.sql,
          columns: result.columns,
          rows: result.rows,
          chart: buildChart(result.rows),
          rowCount: result.rowCount,
          executionMs: Date.now() - started,
          sessionId: input.context.sessionId,
          agent: { runId, attempts: attempt, tools: this.tools.list(), trace },
        };
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

function safeError(error: unknown) { return (error instanceof Error ? error.message : "未知错误").slice(0, 300); }
function buildChart(rows: Record<string, unknown>[]) {
  if (rows.length < 2 || rows.length > 20) return undefined;
  const keys = Object.keys(rows[0] || {});
  const labelKey = keys.find((key) => typeof rows[0][key] === "string");
  const valueKey = keys.find((key) => typeof rows[0][key] === "number");
  if (!labelKey || !valueKey) return undefined;
  return rows.map((row) => ({ label: String(row[labelKey]).slice(0, 20), value: Number(row[valueKey]) })).filter((item) => Number.isFinite(item.value));
}
