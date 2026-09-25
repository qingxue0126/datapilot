import type { ChatTurn } from "../../core/types.js";
import type { SchemaTable } from "../../database.js";
import type { ModelProvider } from "../../llm/model-provider.js";
import type { FinanceMetricPrompt } from "./metrics.js";

type SqlPlan = { status?: "ready" | "insufficient"; sql: string; title: string; reasoning?: string; message?: string };
type Answer = { summary: string };

export class ErpQueryService {
  constructor(private readonly model: ModelProvider) {}

  async generateSql(input: {
    question: string;
    schema: SchemaTable[];
    metrics: FinanceMetricPrompt[];
    history: ChatTurn[];
    previousError?: string;
  }) {
    validateMetricContext(input.metrics, input.schema);
    const schema = input.schema.map((table) => ({
      table: table.name,
      columns: table.columns.map((column) => ({ name: column.name, type: column.type, comment: column.comment })),
    }));
    const plan = await this.model.structured<SqlPlan>([
      {
        role: "system",
        content: [
          "你是 ERP 财务 Text2SQL 规划器，只输出 JSON。",
          "只允许生成一条 MySQL SELECT 或 WITH...SELECT；禁止写操作、DDL、注释、存储过程和危险函数。",
          "只能使用提供的表和字段；不要猜测不存在的结构。多表查询必须使用可解释的业务键关联。",
          "metrics 是经过语义检索得到的权威财务指标定义。生成 SQL 时必须逐项遵守 businessDefinition、calculationRule、accountScope、debitCreditDirection、currencyRule、statusRule、requiredTables、requiredFields 和 sqlHints。",
          "不得自行发明、简化或替换财务口径；不得用名称相似的字段猜测科目范围，也不得用本期发生额替代期末余额。",
          "先确认提供的 Schema 能否无歧义地映射指标要求的业务表、字段、科目范围、状态、币种与期间。标准科目编码只是候选提示，客户明确的科目映射优先。",
          "如果用户询问财务指标但 metrics 为空，或 Schema 无法满足指标定义，status 必须为 insufficient，sql 必须为空，并在 message 中用“口径信息不足：”开头说明缺少的映射；绝对不要猜。",
          "同比和环比必须与明确的基础指标共同使用，并同时返回本期值、对比期值及变化率；对比期值为零时变化率返回 NULL。",
          "金额聚合注意借贷方向和 NULL；日期条件使用明确边界。结果字段使用清晰中文别名。",
          "JSON 格式：{\"status\":\"ready|insufficient\",\"sql\":\"...\",\"title\":\"...\",\"reasoning\":\"不超过80字\",\"message\":\"...\"}",
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
    if (plan.status !== "ready" || !plan.sql?.trim()) {
      const message = String(plan.message || plan.reasoning || "缺少完成查询所需的指标或 Schema 映射");
      throw new Error(message.startsWith("口径信息不足：") ? message : `口径信息不足：${message}`);
    }
    return plan;
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

function validateMetricContext(metrics: FinanceMetricPrompt[], schema: SchemaTable[]) {
  if (!metrics.length) return;
  const comparisonMetrics = metrics.filter((metric) => metric.calculationRule.metricType === "comparison");
  const baseMetrics = metrics.filter((metric) => metric.calculationRule.metricType !== "comparison");
  if (comparisonMetrics.length && !baseMetrics.length) {
    throw new Error(`口径信息不足：${comparisonMetrics.map((metric) => metric.name).join("、")}必须指定营业收入、净利润等基础指标`);
  }

  const columns = new Set(schema.flatMap((table) => table.columns.map((column) => column.name.toLowerCase())));
  for (const metric of baseMetrics) {
    const missing = metric.requiredFields
      .filter((field) => field.required && !field.candidates.some((candidate) => columns.has(candidate.toLowerCase())))
      .map((field) => field.semantic);
    if (missing.length) throw new Error(`口径信息不足：指标“${metric.name}”缺少字段映射：${missing.join("、")}`);
  }
}
