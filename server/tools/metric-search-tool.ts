import { searchMetrics, toMetricPrompt, type FinanceMetricPrompt } from "../domain/erp/metrics.js";
import type { AgentTool, ToolContext } from "./tool-registry.js";

export class MetricSearchTool implements AgentTool<{ question: string }, FinanceMetricPrompt[]> {
  name = "metric.search";
  description = "按别名与业务语义检索最相关的 ERP 财务指标，并返回紧凑的结构化口径";
  async execute(input: { question: string }, _context: ToolContext) {
    return searchMetrics(input.question).map(toMetricPrompt);
  }
}
