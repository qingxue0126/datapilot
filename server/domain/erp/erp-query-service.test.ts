import assert from "node:assert/strict";
import test from "node:test";
import type { ModelProvider } from "../../llm/model-provider.js";
import { ErpQueryService } from "./erp-query-service.js";
import { searchMetrics, toMetricPrompt } from "./metrics.js";

test("ERP query service propagates an explicit insufficient-definition error", async () => {
  let systemPrompt = "";
  const model: ModelProvider = {
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
  const schema = [{
    name: "voucher",
    rows: 0,
    columns: [
      { name: "account_name", type: "varchar(100)", nullable: false, key: "", comment: "" },
      { name: "debit", type: "decimal(18,2)", nullable: false, key: "", comment: "" },
      { name: "credit", type: "decimal(18,2)", nullable: false, key: "", comment: "" },
      { name: "voucher_date", type: "date", nullable: false, key: "", comment: "" },
    ],
  }];
  await assert.rejects(
    service.generateSql({ question: "主营业务收入同比", schema, metrics, history: [] }),
    /口径信息不足：缺少主营业务科目映射/,
  );
  assert.match(systemPrompt, /不得自行发明、简化或替换财务口径/);
  assert.match(systemPrompt, /requiredFields/);
});

test("comparison metrics require an explicit base metric", async () => {
  const model: ModelProvider = { async structured<T>() { throw new Error("model should not be called") as never; } };
  const service = new ErpQueryService(model);
  const metrics = searchMetrics("同比").map(toMetricPrompt);
  await assert.rejects(service.generateSql({ question: "同比", schema: [], metrics, history: [] }), /必须指定.*基础指标/);
});
