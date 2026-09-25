import assert from "node:assert/strict";
import test from "node:test";
import { assertSqlUsesValidatedJoinPaths } from "./join-policy.js";
import type { SchemaSearchResult, SemanticEntityMapping } from "./types.js";

const entity = (name: "VoucherEntry" | "Voucher", table: string, fields: Record<string, string>): SemanticEntityMapping => ({
  entity: name, table, fields, confidence: 1, fieldMappings: {}, mappingSource: "manual", matchReasons: [], unresolvedFields: [],
});

const schema: SchemaSearchResult = {
  rawSchema: [], erpType: "generic", mappingConfidence: 1, mappingSource: "manual", unresolvedFields: [], mappingSamples: [], mappingValidation: { valid: true, errors: [] },
  semanticSchema: [entity("VoucherEntry", "voucher_entry", { voucherNo: "voucher_no", accountingPeriod: "period" }), entity("Voucher", "voucher", { voucherNo: "voucher_no", accountingPeriod: "period" })],
  joinPaths: [{
    id: "composite", leftEntity: "VoucherEntry", rightEntity: "Voucher", leftTable: "voucher_entry", rightTable: "voucher",
    fields: [{ leftField: "voucherNo", rightField: "voucherNo" }, { leftField: "accountingPeriod", rightField: "accountingPeriod" }],
    joinType: "left", confidence: 1, source: "manual", validated: true, validation: { checked: true, matchRate: 1, rightUniqueRate: 1 },
  }],
};

test("SQL join policy requires every field in a validated composite path", () => {
  assert.doesNotThrow(() => assertSqlUsesValidatedJoinPaths("SELECT ve.voucher_no FROM voucher_entry ve LEFT JOIN voucher v ON ve.voucher_no = v.voucher_no AND ve.period = v.period", schema));
  assert.throws(() => assertSqlUsesValidatedJoinPaths("SELECT ve.voucher_no FROM voucher_entry ve LEFT JOIN voucher v ON ve.voucher_no = v.voucher_no", schema), /已验证 Join Path/);
});
