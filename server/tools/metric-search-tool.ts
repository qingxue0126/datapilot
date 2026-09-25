import { searchMetrics, type FinanceMetric } from "../domain/erp/metrics.js";
import type { AgentTool, ToolContext } from "./tool-registry.js";

export class MetricSearchTool implements AgentTool<{ question: string }, FinanceMetric[]> {
  name = "metric.search";
  description = "检索 ERP 财务指标定义，包括收入、费用、应收、应付、利润、同比和环比";
  async execute(input: { question: string }, _context: ToolContext) { return searchMetrics(input.question); }
}
