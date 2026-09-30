import assert from "node:assert/strict";
import test from "node:test";
import type { StructuredModelClient } from "../../llm/model-service.js";
import { assertGroupedMetricFilters, ErpQueryService } from "./erp-query-service.js";
import { searchMetrics, toMetricPrompt } from "./metrics.js";
import { mapErpSchema } from "./schema-mapping/adapters.js";
import type { JoinPathDefinition } from "./schema-mapping/types.js";

const context = { tenantId: "tenant", accountSetId: "books", userId: "user", role: "tenant_admin" as const, sessionId: "session" };

test("ERP query service propagates an explicit insufficient-definition error", async () => {
  let systemPrompt = "";
  const model: StructuredModelClient = {
    async structured<T>(messages: { role: "system" | "user"; content: string }[]) {
      systemPrompt = messages[0]?.content || "";
      return {
        status: "insufficient",
        sql: "",
        title: "无法生成",
        message: "口径信息不足：缺少主营业务科目映射",
      } as T;
    },
  };
  const service = new ErpQueryService(model);
  const metrics = searchMetrics("主营业务收入同比").map(toMetricPrompt);
  const rawSchema = [{
    name: "voucher",
    rows: 0,
    columns: [
      { name: "account_code", type: "varchar(100)", nullable: false, key: "", comment: "" },
      { name: "debit", type: "decimal(18,2)", nullable: false, key: "", comment: "" },
      { name: "credit", type: "decimal(18,2)", nullable: false, key: "", comment: "" },
      { name: "voucher_date", type: "date", nullable: false, key: "", comment: "" },
    ],
  }];
  const schema = mapErpSchema(rawSchema);
  await assert.rejects(
    service.generateSql({ question: "主营业务收入同比", schema, metrics, history: [], context }),
    /口径信息不足：缺少主营业务科目映射/,
  );
  assert.match(systemPrompt, /不得自行发明、简化或替换财务口径/);
  assert.match(systemPrompt, /requiredFields/);
});

test("comparison metrics require an explicit base metric", async () => {
  const model: StructuredModelClient = { async structured() { throw new Error("model should not be called"); } };
  const service = new ErpQueryService(model);
  const metrics = searchMetrics("同比").map(toMetricPrompt);
  await assert.rejects(service.generateSql({ question: "同比", schema: mapErpSchema([]), metrics, history: [], context }), /必须指定.*基础指标/);
});

test("ERP query service rejects missing critical semantic fields before calling the model", async () => {
  const model: StructuredModelClient = { async structured() { throw new Error("model should not be called"); } };
  const service = new ErpQueryService(model);
  const schema = mapErpSchema([{
    name: "voucher_entry", rows: 0,
    columns: [
      { name: "voucher_id", type: "bigint", nullable: false, key: "", comment: "" },
      { name: "voucher_date", type: "date", nullable: false, key: "", comment: "" },
      { name: "account_code", type: "varchar(50)", nullable: false, key: "", comment: "" },
    ],
  }]);
  const metrics = searchMetrics("本月营业收入是多少").map(toMetricPrompt);
  await assert.rejects(service.generateSql({ question: "本月营业收入是多少", schema, metrics, history: [], context }), /Schema 映射不足.*debitAmount.*creditAmount/);
});

test("ERP query service refuses a required multi-entity query without a validated join path", async () => {
  const model: StructuredModelClient = { async structured() { throw new Error("model should not be called"); } };
  const service = new ErpQueryService(model);
  const schema = ledgerWithAccountSchema();
  const metrics = searchMetrics("本月营业收入是多少").map(toMetricPrompt);
  await assert.rejects(service.generateSql({ question: "本月营业收入是多少", schema, metrics, history: [], context }), /VoucherEntry 与 Account.*没有经过验证的 Join Path/);
});

test("ERP query service accepts SQL that uses the full validated join path", async () => {
  const model: StructuredModelClient = {
    async structured<T>() {
      return { status: "ready", sql: "SELECT SUM(ve.credit_amount - ve.debit_amount) AS revenue FROM voucher_entry ve LEFT JOIN account a ON ve.account_code = a.code", title: "营业收入" } as T;
    },
  };
  const service = new ErpQueryService(model);
  const schema = ledgerWithAccountSchema();
  const join: JoinPathDefinition = {
    id: "test-account", leftEntity: "VoucherEntry", rightEntity: "Account", leftTable: "voucher_entry", rightTable: "account",
    fields: [{ leftField: "accountCode", rightField: "code" }], joinType: "left", confidence: 0.99, source: "manual", validated: true,
    validation: { checked: true, matchRate: 1, rightUniqueRate: 1 },
  };
  schema.joinPaths = [join];
  const plan = await service.generateSql({ question: "本月营业收入是多少", schema, metrics: searchMetrics("本月营业收入是多少").map(toMetricPrompt), history: [], context });
  assert.match(plan.sql, /LEFT JOIN account/);
});

test("metric filter validation rejects ungrouped account OR conditions", () => {
  assert.throws(() => assertGroupedMetricFilters("SELECT SUM(credit_amount) FROM voucher_entry WHERE account_code LIKE '6001%' OR account_code LIKE '6051%' AND status='POSTED'"), /OR 条件必须整体加括号/);
  assert.doesNotThrow(() => assertGroupedMetricFilters("SELECT SUM(credit_amount) FROM voucher_entry WHERE (account_code LIKE '6001%' OR account_code LIKE '6051%') AND status='POSTED'"));
});

test("ERP answer analysis forwards real streaming tokens", async () => {
  const tokens: string[] = [];
  const model = {
    async structured<T>() { return { summary: "非流式" } as T; },
    async text(_messages: unknown, options: { onToken: (token: string) => void }) {
      options.onToken("营业收入");
      options.onToken("为 100 元");
      return "营业收入为 100 元";
    },
  };
  const service = new ErpQueryService(model);
  const result = await service.analyze({ question: "营业收入？", sql: "SELECT 100", rows: [{ value: 100 }], rowCount: 1, context, onToken: (token) => tokens.push(token) });
  assert.equal(result, "营业收入为 100 元");
  assert.deepEqual(tokens, ["营业收入", "为 100 元"]);
});

function ledgerWithAccountSchema() {
  return mapErpSchema([
    { name: "voucher_entry", rows: 10, columns: [
      { name: "voucher_id", type: "bigint", nullable: false, key: "", comment: "" },
      { name: "voucher_date", type: "date", nullable: false, key: "", comment: "" },
      { name: "account_code", type: "varchar(50)", nullable: false, key: "", comment: "" },
      { name: "debit_amount", type: "decimal(18,2)", nullable: false, key: "", comment: "" },
      { name: "credit_amount", type: "decimal(18,2)", nullable: false, key: "", comment: "" },
    ] },
    { name: "account", rows: 10, columns: [
      { name: "id", type: "bigint", nullable: false, key: "PRI", comment: "" },
      { name: "code", type: "varchar(50)", nullable: false, key: "UNI", comment: "" },
      { name: "name", type: "varchar(100)", nullable: false, key: "", comment: "" },
    ] },
  ]);
}
