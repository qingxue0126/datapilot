import assert from "node:assert/strict";
import test from "node:test";
import { financeMetrics, searchMetrics, toMetricPrompt } from "./metrics.js";

const cases: [question: string, expectedIds: string[]][] = [
  ["本月营业收入是多少", ["operating_revenue"]],
  ["主营业务收入同比", ["main_business_revenue", "yoy"]],
  ["当前应收账款余额", ["accounts_receivable"]],
  ["本月期间费用", ["period_expense"]],
  ["净利润环比", ["net_profit", "mom"]],
];

for (const [question, expectedIds] of cases) {
  test(`metric semantic search: ${question}`, () => {
    assert.deepEqual(searchMetrics(question).map((metric) => metric.id), expectedIds);
  });
}

test("semantic aliases retrieve receivables without using the metric name", () => {
  assert.equal(searchMetrics("客户还有多少款尚未收回")[0]?.id, "accounts_receivable");
});

test("unrelated questions do not inject default finance metrics", () => {
  assert.deepEqual(searchMetrics("显示凭证表前十行"), []);
});

test("all phase-one metrics expose the structured semantic contract", () => {
  assert.deepEqual(financeMetrics.map((metric) => metric.id), [
    "operating_revenue",
    "main_business_revenue",
    "cost",
    "period_expense",
    "accounts_receivable",
    "accounts_payable",
    "gross_profit",
    "net_profit",
    "yoy",
    "mom",
  ]);
  for (const metric of financeMetrics) {
    assert.ok(metric.aliases.length);
    assert.ok(metric.businessDefinition);
    assert.ok(metric.calculationRule.expression);
    assert.ok(metric.accountScope.includeRule);
    assert.ok(metric.debitCreditDirection.amountRule);
    assert.ok(metric.timeFieldHints.length);
    assert.ok(metric.dimensions.length);
    assert.ok(metric.currencyRule.rule);
    assert.ok(metric.statusRule.rule);
    assert.ok(metric.applicableErp.length);
    assert.ok(metric.requiredTables.length);
    assert.ok(metric.requiredFields.length);
    assert.ok(metric.sqlHints.length);
  }
});

test("LLM metric context is compact and omits retrieval-only aliases", () => {
  const compact = toMetricPrompt(financeMetrics[0]);
  assert.equal("aliases" in compact, false);
  assert.equal("keywords" in compact, false);
  assert.equal(compact.id, "operating_revenue");
  assert.ok(compact.sqlHints.length);
});
