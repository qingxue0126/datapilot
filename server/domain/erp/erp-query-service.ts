import type { ChatTurn } from "../../core/types.js";
import type { SchemaTable } from "../../database.js";
import type { ModelProvider } from "../../llm/model-provider.js";
import type { FinanceMetric } from "./metrics.js";

type SqlPlan = { sql: string; title: string; reasoning?: string };
type Answer = { summary: string };

export class ErpQueryService {
  constructor(private readonly model: ModelProvider) {}

  generateSql(input: {
    question: string;
    schema: SchemaTable[];
    metrics: FinanceMetric[];
    history: ChatTurn[];
    previousError?: string;
  }) {
    const schema = input.schema.map((table) => ({
      table: table.name,
      columns: table.columns.map((column) => ({ name: column.name, type: column.type, comment: column.comment })),
    }));
    return this.model.structured<SqlPlan>([
      {
        role: "system",
        content: [
          "你是 ERP 财务 Text2SQL 规划器，只输出 JSON。",
          "只允许生成一条 MySQL SELECT 或 WITH...SELECT；禁止写操作、DDL、注释、存储过程和危险函数。",
          "只能使用提供的表和字段；不要猜测不存在的结构。多表查询必须使用可解释的业务键关联。",
          "收入、费用、应收、应付、利润口径优先遵循提供的指标定义；同比和环比必须同时返回本期、对比期及变化率。",
          "金额聚合注意借贷方向和 NULL；日期条件使用明确边界。结果字段使用清晰中文别名。",
          "JSON 格式：{\"sql\":\"...\",\"title\":\"...\",\"reasoning\":\"不超过80字\"}",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          question: input.question,
          metrics: input.metrics,
          schema,
          recentContext: input.history.slice(-4).map(({ question, answer, sql }) => ({ question, answer, sql })),
          previousError: input.previousError,
        }),
      },
    ]);
  }

  async analyze(input: { question: string; sql: string; rows: Record<string, unknown>[]; rowCount: number }) {
    const answer = await this.model.structured<Answer>([
      {
        role: "system",
        content: "你是 ERP 财务分析助手。基于真实查询结果给出简洁中文结论，不虚构原因或数据。若结果为空要明确说明。只输出 JSON：{\"summary\":\"...\"}。",
      },
      {
        role: "user",
        content: JSON.stringify({ question: input.question, sql: input.sql, rowCount: input.rowCount, rows: input.rows.slice(0, 50) }),
      },
    ]);
    return String(answer.summary || "查询已完成。").slice(0, 2000);
  }
}
