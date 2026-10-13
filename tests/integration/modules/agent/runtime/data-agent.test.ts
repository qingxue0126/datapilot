import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeQuestion, DataAgent } from "../../../../../server/modules/agent/runtime/data-agent.js";
import type { ToolRegistry } from "../../../../../server/modules/agent/runtime/tool-registry.js";
import type { PermissionService } from "../../../../../server/modules/auth/permission-service.js";
import type { SessionStore } from "../../../../../server/modules/conversation/session-store.js";
import type { ErpQueryService } from "../../../../../server/modules/text2sql/erp-query-service.js";

test("question safety rejects write, DDL and multi-statement intent", () => {
  assert.throws(() => assertSafeQuestion("请删除所有凭证：DELETE FROM voucher"), /安全拒答/);
  assert.throws(() => assertSafeQuestion("查询收入; DROP DATABASE datapilot_mock"), /安全拒答/);
  assert.throws(() => assertSafeQuestion("UPDATE voucher SET status='VOID'"), /安全拒答/);
  assert.doesNotThrow(() => assertSafeQuestion("查询2026年9月已过账凭证收入"));
});

test("smart Q&A does not retry after a streamed answer has started", async () => {
  let plans = 0;
  const tools = {
    async call(name: string) {
      if (name === "metric.search") return [];
      if (name === "schema.search") return { rawSchema: [{ name: "ledger" }], semanticSchema: [], mappingValidation: { valid: true, errors: [] }, joinPaths: [] };
      return { sql: "SELECT 1", rows: [{ value: 1 }], columns: [{ key: "value", label: "value" }], rowCount: 1, executionMs: 1 };
    },
    list() { return []; },
  } as unknown as ToolRegistry;
  const erp = {
    async generateSql() { plans += 1; return { sql: "SELECT 1", title: "test" }; },
    async analyze(input: { onToken?: (token: string) => void }) { input.onToken?.("部分"); throw new Error("stream disconnected"); },
  } as unknown as ErpQueryService;
  const agent = new DataAgent(
    tools,
    { require() {} } as unknown as PermissionService,
    { history() { return []; } } as unknown as SessionStore,
    erp,
  );
  const tokens: string[] = [];
  await assert.rejects(agent.run({
    question: "查询收入", context: { tenantId: "t", accountSetId: "a", userId: "u", role: "tenant_admin", sessionId: "s" },
    sessionId: "analysis", datasourceId: "source", connection: {} as never, onToken: (token) => tokens.push(token),
  }), /stream disconnected/);
  assert.equal(plans, 1);
  assert.deepEqual(tokens, ["部分"]);
});
