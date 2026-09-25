import assert from "node:assert/strict";
import test from "node:test";
import type { SchemaTable } from "../../../database.js";
import { GenericErpAdapter, YongyouAdapter, mapErpSchema } from "./adapters.js";
import type { ErpSchemaMappingConfig } from "./types.js";

const column = (name: string, comment = "", type = "varchar(50)") => ({ name, type, nullable: true, key: "", comment });
const table = (name: string, columns: SchemaTable["columns"]): SchemaTable => ({ name, rows: 0, columns });

test("maps a generic English voucher-entry schema", () => {
  const result = new GenericErpAdapter().map([
    table("journal_lines", [column("voucher_id"), column("posting_date", "记账日期", "date"), column("account_code"), column("debit_amount", "", "decimal(18,2)"), column("credit_amount", "", "decimal(18,2)"), column("currency_code")]),
  ]);
  const entry = result.semanticSchema.find((item) => item.entity === "VoucherEntry");
  assert.ok(entry);
  assert.equal(entry.fields.accountCode, "account_code");
  assert.equal(entry.fields.debitAmount, "debit_amount");
  assert.equal(entry.fields.creditAmount, "credit_amount");
  assert.equal(entry.fields.voucherDate, "posting_date");
  assert.ok(entry.confidence >= 0.8);
});

test("maps Yongyou-like GL_accvouch names through the dedicated adapter", () => {
  const result = new YongyouAdapter().map([
    table("GL_accvouch", [column("ino_id"), column("dbill_date", "", "date"), column("ccode"), column("md", "", "decimal(18,2)"), column("mc", "", "decimal(18,2)"), column("ccus_id"), column("csup_id")]),
  ]);
  const entry = result.semanticSchema.find((item) => item.entity === "VoucherEntry");
  assert.deepEqual({ table: entry?.table, account: entry?.fields.accountCode, debit: entry?.fields.debitAmount, credit: entry?.fields.creditAmount },
    { table: "GL_accvouch", account: "ccode", debit: "md", credit: "mc" });
  assert.equal(result.erpType, "yongyou");
});

test("reports unresolved debit and credit fields instead of guessing", () => {
  const result = mapErpSchema([
    table("voucher_entry", [column("voucher_id"), column("voucher_date", "", "date"), column("account_code"), column("amount")]),
  ]);
  const entry = result.semanticSchema.find((item) => item.entity === "VoucherEntry");
  assert.ok(entry);
  assert.ok(entry.unresolvedFields.includes("debitAmount"));
  assert.ok(entry.unresolvedFields.includes("creditAmount"));
  assert.ok(result.unresolvedFields.includes("VoucherEntry.debitAmount"));
});

test("manual configuration overrides automatic table and field mapping", () => {
  const schema = [table("fin_lines", [column("v_ref"), column("biz_day", "", "date"), column("subject_ref"), column("dr_value", "", "decimal(18,2)"), column("cr_value", "", "decimal(18,2)")])];
  const config: ErpSchemaMappingConfig = {
    erpType: "generic",
    mappings: { VoucherEntry: { table: "fin_lines", fields: { voucherId: "v_ref", voucherDate: "biz_day", accountCode: "subject_ref", debitAmount: "dr_value", creditAmount: "cr_value" } } },
  };
  const entry = mapErpSchema(schema, config).semanticSchema.find((item) => item.entity === "VoucherEntry");
  assert.equal(entry?.mappingSource, "manual");
  assert.equal(entry?.fields.debitAmount, "dr_value");
  assert.equal(entry?.fieldMappings.debitAmount.source, "manual");
  assert.deepEqual(entry?.unresolvedFields, []);
});

test("does not create a semantic entity for low-confidence schema", () => {
  const result = mapErpSchema([table("misc_data", [column("x_value"), column("y_value"), column("remark")])]);
  assert.deepEqual(result.semanticSchema, []);
  assert.equal(result.mappingConfidence, 0);
});

test("field comments take precedence over weak field names", () => {
  const result = mapErpSchema([
    table("voucher_entry", [column("c1", "凭证ID"), column("c2", "凭证日期", "date"), column("c3", "科目编码"), column("c4", "借方金额", "decimal"), column("c5", "贷方金额", "decimal")]),
  ]);
  const entry = result.semanticSchema.find((item) => item.entity === "VoucherEntry");
  assert.equal(entry?.fields.accountCode, "c3");
  assert.equal(entry?.fieldMappings.accountCode.reason.includes("字段注释"), true);
});

test("does not mislabel an account name as an account code", () => {
  const result = mapErpSchema([
    table("voucher", [column("id", "凭证编号"), column("voucher_date", "凭证日期", "date"), column("account_name", "会计科目"), column("debit", "借方金额", "decimal"), column("credit", "贷方金额", "decimal")]),
  ]);
  const entry = result.semanticSchema.find((item) => item.entity === "VoucherEntry");
  assert.equal(entry?.fields.accountName, "account_name");
  assert.equal(entry?.fields.accountCode, undefined);
  assert.ok(entry?.unresolvedFields.includes("accountCode"));
});
