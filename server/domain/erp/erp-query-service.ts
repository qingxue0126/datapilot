import type { ChatTurn } from "../../core/types.js";
import type { ModelProvider } from "../../llm/model-provider.js";
import type { FinanceMetricPrompt } from "./metrics.js";
import { assertSqlUsesValidatedJoinPaths } from "./schema-mapping/join-policy.js";
import type { SchemaSearchResult, SemanticEntityMapping } from "./schema-mapping/types.js";

type SqlPlan = { status?: "ready" | "insufficient"; sql: string; title: string; reasoning?: string; message?: string };
type Answer = { summary: string };

export class ErpQueryService {
  constructor(private readonly model: ModelProvider) {}

  async generateSql(input: {
    question: string;
    schema: SchemaSearchResult;
    metrics: FinanceMetricPrompt[];
    history: ChatTurn[];
    previousError?: string;
    model?: string;
  }) {
    validateMetricContext(input.metrics, input.schema);
    validateRequiredJoinPaths(input.question, input.metrics, input.schema);
    const rawSchema = input.schema.rawSchema.map((table) => ({
      table: table.name,
      columns: table.columns.map((column) => ({ name: column.name, type: column.type, comment: column.comment })),
    }));
    const semanticSchema = input.schema.semanticSchema.map((mapping) => ({
      entity: mapping.entity,
      table: mapping.table,
      confidence: mapping.confidence,
      mappingSource: mapping.mappingSource,
      fields: mapping.fields,
      unresolvedFields: mapping.unresolvedFields,
    }));
    const joinPaths = input.schema.joinPaths.filter((path) => path.validated).map((path) => ({
      id: path.id,
      leftEntity: path.leftEntity,
      rightEntity: path.rightEntity,
      leftTable: path.leftTable,
      rightTable: path.rightTable,
      joinType: path.joinType,
      confidence: path.confidence,
      requiredContextFields: path.requiredContextFields,
      fields: path.fields.map((field) => ({
        ...field,
        leftColumn: input.schema.semanticSchema.find((item) => item.entity === path.leftEntity)?.fields[field.leftField],
        rightColumn: input.schema.semanticSchema.find((item) => item.entity === path.rightEntity)?.fields[field.rightField],
      })),
    }));
    const plan = await this.model.structured<SqlPlan>([
      {
        role: "system",
        content: [
          "你是 ERP 财务 Text2SQL 规划器，只输出 JSON。",
          "只允许生成一条 MySQL SELECT 或 WITH...SELECT；禁止写操作、DDL、注释、存储过程和危险函数。",
          "只能使用提供的表和字段；不要猜测不存在的结构。多表查询必须使用可解释的业务键关联。",
          "semanticSchema 是经过规则与置信度控制的 ERP 业务实体映射，生成 SQL 时必须优先且只能按其中的业务字段到真实字段映射使用。rawSchema 仅用于确认字段类型和处理用户明确点名的原始表字段，不得据此自行发明 ERP 字段映射。",
          "若业务查询依赖的实体或关键字段未出现在 semanticSchema，status 必须为 insufficient，并以“Schema 映射不足：”说明缺失项；不得根据相似表名或字段名猜 SQL。",
          "多表查询只能使用提供的 validated joinPaths，并完整使用其中列出的全部关联字段和 joinType。如果所需实体之间没有经过验证的 joinPath，必须返回 status=insufficient。不得根据字段名相似度自行生成 JOIN 条件。",
          "mappingSamples 给出了当前数据源真实的状态、币种和科目编码样本。生成过滤条件时必须优先使用样本中的真实取值，禁止凭经验猜测 approved、posted、void 等枚举值。",
          "默认状态过滤必须使用样本中代表有效已过账数据的正向等值条件（例如 status='POSTED'），不要只用 status<>'VOID' 之类排除条件，因为还可能存在 DRAFT 或未知状态。",
          "如果 semanticSchema 已映射 Receivable/Payable 且具有 balance 字段，应优先直接汇总该余额表；不得无故退回 VoucherEntry 重建余额。",
          "同比、环比必须在同一条明细扫描中使用条件聚合计算本期和对比期；当前数据库需要兼容 MySQL 5.7，不要生成 WITH/CTE，也不要把两个标量子查询做 CROSS JOIN。",
          "WHERE 中只要出现 OR，必须用括号包住完整 OR 组，再与日期、状态、维度等 AND 条件组合，避免 SQL 运算符优先级改变业务口径。",
          "VoucherEntry 已有 voucherDate、fiscalYear、accountingPeriod 和 status 时优先直接过滤这些字段，不要为了日期或状态额外关联 Voucher。必须关联时严格使用 joinPaths 指定的 LEFT JOIN 和全部等值字段。",
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
          semanticSchema,
          joinPaths,
          rawSchema,
          mappingConfidence: input.schema.mappingConfidence,
          mappingSource: input.schema.mappingSource,
          unresolvedFields: input.schema.unresolvedFields,
          mappingSamples: input.schema.mappingSamples,
          recentContext: input.history.map(({ question, answer, sql }) => ({ question, answer, sql })),
          previousError: input.previousError,
        }),
      },
    ], { model: input.model });
    if (plan.status !== "ready" || !plan.sql?.trim()) {
      const message = String(plan.message || plan.reasoning || "缺少完成查询所需的指标或 Schema 映射");
      if (message.startsWith("口径信息不足：") || message.startsWith("Schema 映射不足：")) throw new Error(message);
      throw new Error(`口径信息不足：${message}`);
    }
    assertGroupedMetricFilters(plan.sql);
    assertSqlUsesValidatedJoinPaths(plan.sql, input.schema);
    return plan;
  }

  async analyze(input: { question: string; sql: string; rows: Record<string, unknown>[]; rowCount: number; model?: string }) {
    const answer = await this.model.structured<Answer>([
      {
        role: "system",
        content: "你是 ERP 财务分析助手。基于真实查询结果给出简洁中文结论，不虚构原因或数据。若结果为空要明确说明。只输出 JSON：{\"summary\":\"...\"}。",
      },
      {
        role: "user",
        content: JSON.stringify({ question: input.question, sql: input.sql, rowCount: input.rowCount, rows: input.rows.slice(0, 50) }),
      },
    ], { model: input.model });
    return String(answer.summary || "查询已完成。").slice(0, 2000);
  }
}

export function assertGroupedMetricFilters(sql: string) {
  const scopes = sql.split(/\bwhere\b/i).slice(1).map((part) => part.split(/\b(group\s+by|order\s+by|having|limit|union)\b/i)[0]);
  const accountOr = /(?:\b\w+\.)?account_code\s+like\s+'[^']+'(?:\s+or\s+(?:\b\w+\.)?account_code\s+like\s+'[^']+')+/ig;
  for (const scope of scopes) for (const match of scope.matchAll(accountOr)) {
    if (!/\band\b/i.test(scope)) continue;
    const before = scope.slice(0, match.index).trimEnd();
    const after = scope.slice((match.index || 0) + match[0].length).trimStart();
    if (!before.endsWith("(") || !after.startsWith(")")) throw new Error("SQL 生成错误：多个科目 OR 条件必须整体加括号后再与时间、状态和维度条件组合");
  }
  return sql;
}

function validateMetricContext(metrics: FinanceMetricPrompt[], schema: SchemaSearchResult) {
  if (!schema.mappingValidation.valid) throw new Error(`Schema 映射不足：${schema.mappingValidation.errors.join("；")}`);
  if (!metrics.length) return;
  const comparisonMetrics = metrics.filter((metric) => metric.calculationRule.metricType === "comparison");
  const baseMetrics = metrics.filter((metric) => metric.calculationRule.metricType !== "comparison");
  if (comparisonMetrics.length && !baseMetrics.length) {
    throw new Error(`口径信息不足：${comparisonMetrics.map((metric) => metric.name).join("、")}必须指定营业收入、净利润等基础指标`);
  }

  for (const metric of baseMetrics) {
    const directEntity = metric.id === "accounts_receivable" ? findEntity(schema, "Receivable") : metric.id === "accounts_payable" ? findEntity(schema, "Payable") : undefined;
    if (directEntity && hasDirectBalanceFields(metric.id, directEntity)) continue;
    const entry = findEntity(schema, "VoucherEntry");
    if (!entry) throw new Error(`Schema 映射不足：指标“${metric.name}”未映射 VoucherEntry（凭证明细）实体`);
    const missing = ["accountCode", "debitAmount", "creditAmount"].filter((field) => !entry.fields[field]);
    const hasEntryDate = Boolean(entry.fields.voucherDate);
    const voucher = findEntity(schema, "Voucher");
    const hasVoucherDateJoin = Boolean(entry.fields.voucherId && voucher?.fields.id && voucher.fields.voucherDate);
    if (!hasEntryDate && !hasVoucherDateJoin) missing.push("voucherDate（或 Voucher 关联日期）");
    if (missing.length) throw new Error(`Schema 映射不足：指标“${metric.name}”的 VoucherEntry 缺少关键字段：${missing.join("、")}`);
  }
}

function validateRequiredJoinPaths(question: string, metrics: FinanceMetricPrompt[], schema: SchemaSearchResult) {
  const required: [SemanticEntityMapping["entity"], SemanticEntityMapping["entity"]][] = [];
  const needsLedger = metrics.some((metric) => {
    if (metric.calculationRule.metricType === "comparison") return false;
    if (metric.id === "accounts_receivable") { const mapping = findEntity(schema, "Receivable"); return !mapping || !hasDirectBalanceFields(metric.id, mapping); }
    if (metric.id === "accounts_payable") { const mapping = findEntity(schema, "Payable"); return !mapping || !hasDirectBalanceFields(metric.id, mapping); }
    return true;
  });
  if (needsLedger && findEntity(schema, "VoucherEntry") && findEntity(schema, "Account")) required.push(["VoucherEntry", "Account"]);
  if (metrics.some((metric) => metric.id === "accounts_receivable") && findEntity(schema, "Receivable") && findEntity(schema, "Customer")) required.push(["Receivable", "Customer"]);
  if (metrics.some((metric) => metric.id === "accounts_payable") && findEntity(schema, "Payable") && findEntity(schema, "Supplier")) required.push(["Payable", "Supplier"]);
  if (/客户/.test(question) && findEntity(schema, "VoucherEntry") && findEntity(schema, "Customer")) required.push(["VoucherEntry", "Customer"]);
  if (/供应商/.test(question) && findEntity(schema, "VoucherEntry") && findEntity(schema, "Supplier")) required.push(["VoucherEntry", "Supplier"]);
  if (/部门/.test(question) && findEntity(schema, "VoucherEntry") && findEntity(schema, "Department")) required.push(["VoucherEntry", "Department"]);
  for (const [left, right] of required) {
    const exists = schema.joinPaths.some((path) => path.validated && ((path.leftEntity === left && path.rightEntity === right) || (path.leftEntity === right && path.rightEntity === left)));
    if (!exists) throw new Error(`Schema 映射不足：${left} 与 ${right} 之间没有经过验证的 Join Path`);
  }
}

function findEntity(schema: SchemaSearchResult, entity: SemanticEntityMapping["entity"]) {
  return schema.semanticSchema.find((mapping) => mapping.entity === entity);
}

function hasDirectBalanceFields(metricId: string, mapping: SemanticEntityMapping) {
  const partyField = metricId === "accounts_receivable" ? "customerId" : "supplierId";
  return Boolean(mapping.fields[partyField] && (mapping.fields.balance || mapping.fields.amount));
}
