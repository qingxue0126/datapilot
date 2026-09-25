import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeQuestion } from "./data-agent.js";

test("question safety rejects write, DDL and multi-statement intent", () => {
  assert.throws(() => assertSafeQuestion("请删除所有凭证：DELETE FROM voucher"), /安全拒答/);
  assert.throws(() => assertSafeQuestion("查询收入; DROP DATABASE datapilot_mock"), /安全拒答/);
  assert.throws(() => assertSafeQuestion("UPDATE voucher SET status='VOID'"), /安全拒答/);
  assert.doesNotThrow(() => assertSafeQuestion("查询2026年9月已过账凭证收入"));
});
