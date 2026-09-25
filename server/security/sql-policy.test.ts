import assert from "node:assert/strict";
import test from "node:test";
import type { PermissionPolicy } from "../core/types.js";
import { assertAgentSql } from "./sql-policy.js";

const policy: PermissionPolicy = {
  capabilities: ["database:read"],
  allowedTables: ["voucher"],
  deniedColumns: ["bank_account"],
  rowScopes: [],
};

test("agent SQL policy permits a scoped SELECT", () => {
  assert.equal(assertAgentSql("SELECT id, debit FROM voucher", policy), "SELECT id, debit FROM voucher");
});

test("agent SQL policy rejects writes, unauthorized tables and fields", () => {
  assert.throws(() => assertAgentSql("DELETE FROM voucher WHERE id = 1", policy), /SELECT/);
  assert.throws(() => assertAgentSql("SELECT id FROM users", policy), /users/);
  assert.throws(() => assertAgentSql("SELECT id FROM finance_db.voucher", policy), /跨数据库/);
  assert.throws(() => assertAgentSql("SELECT bank_account FROM voucher", policy), /bank_account/);
  assert.throws(() => assertAgentSql("SELECT * FROM voucher", policy), /SELECT \*/);
  assert.doesNotThrow(() => assertAgentSql("SELECT COUNT(*) AS count FROM voucher", policy));
});

test("agent SQL policy enforces configured data scope", () => {
  const scoped = { ...policy, rowScopes: [{ table: "voucher", column: "company_id", allowedValues: ["company-a"] }] };
  assert.equal(
    assertAgentSql("SELECT id FROM voucher WHERE company_id = 'company-a'", scoped),
    "SELECT id FROM voucher WHERE company_id = 'company-a'",
  );
  assert.throws(() => assertAgentSql("SELECT id FROM voucher", scoped), /company_id/);
  assert.throws(() => assertAgentSql("SELECT id FROM voucher WHERE company_id = 'company-b'", scoped), /company_id/);
});
