import assert from "node:assert/strict";
import test from "node:test";
import type { SchemaTable } from "../../../database.js";
import { createErpAdapter, mapErpSchema } from "./adapters.js";
import { buildValidatedMapping, type MappingProbe } from "./mapping-validation.js";
import type { ErpSchemaMappingConfig } from "./types.js";

const column = (name: string, type = "varchar(50)") => ({ name, type, nullable: true, key: "", comment: "" });
const table = (name: string, columns: SchemaTable["columns"]): SchemaTable => ({ name, rows: 20, columns });
const fullSchema = () => [
  table("voucher_entry", [column("voucher_id", "bigint"), column("voucher_no"), column("accounting_period", "int"), column("voucher_date", "date"), column("account_code"), column("debit_amount", "decimal(18,2)"), column("credit_amount", "decimal(18,2)")]),
  table("voucher", [column("id", "bigint"), column("voucher_no"), column("accounting_period", "int"), column("voucher_date", "date")]),
  table("account", [column("id", "bigint"), column("code"), column("name")]),
];

class FakeProbe implements MappingProbe {
  constructor(private readonly matchRate = 1, private readonly rightUniqueRate = 1) {}
  async foreignKeys() { return []; }
  async uniqueness(tableName: string) { return tableName === "account" || tableName === "voucher" ? this.rightUniqueRate : 0.7; }
  async joinMatchRate() { return this.matchRate; }
  async sampleValues() { return ["sample"]; }
}

test("validates VoucherEntry.accountCode to Account.code", async () => {
  const schema = fullSchema(); const mapped = mapErpSchema(schema);
  const result = await buildValidatedMapping({ schema, mappings: mapped.semanticSchema, adapterCandidates: [], probe: new FakeProbe() });
  const join = result.joinPaths.find((item) => item.leftEntity === "VoucherEntry" && item.rightEntity === "Account");
  assert.ok(join?.validated);
  assert.deepEqual(join.fields, [{ leftField: "accountCode", rightField: "code" }]);
  assert.equal(join.validation?.matchRate, 1);
});

test("rejects a configured field that does not exist in the database", async () => {
  const schema = fullSchema();
  const config: ErpSchemaMappingConfig = { erpType: "generic", mappings: { Account: { table: "account", fields: { code: "ccode" } } } };
  const mapped = mapErpSchema(schema, config);
  const result = await buildValidatedMapping({ schema, mappings: mapped.semanticSchema, config, adapterCandidates: [], probe: new FakeProbe() });
  assert.equal(result.mappingValidation.valid, false);
  assert.match(result.mappingValidation.errors.join(" "), /Account\.code.*ccode.*不存在/);
});

test("validates a composite voucher number and accounting period join", async () => {
  const schema = fullSchema();
  const config: ErpSchemaMappingConfig = {
    erpType: "generic", mappings: {},
    joins: [{ leftEntity: "VoucherEntry", rightEntity: "Voucher", fields: [{ leftField: "voucherNo", rightField: "voucherNo" }, { leftField: "accountingPeriod", rightField: "accountingPeriod" }] }],
  };
  const mapped = mapErpSchema(schema, config);
  const result = await buildValidatedMapping({ schema, mappings: mapped.semanticSchema, config, adapterCandidates: createErpAdapter("generic").joinCandidates(mapped.semanticSchema), probe: new FakeProbe() });
  const composite = result.joinPaths.find((item) => item.source === "manual" && item.rightEntity === "Voucher");
  assert.equal(composite?.fields.length, 2);
  assert.equal(composite?.validated, true);
});

test("does not validate a low match-rate join", async () => {
  const schema = fullSchema(); const mapped = mapErpSchema(schema);
  const result = await buildValidatedMapping({ schema, mappings: mapped.semanticSchema, adapterCandidates: [], probe: new FakeProbe(0.2, 1) });
  assert.equal(result.joinPaths.some((item) => item.rightEntity === "Account"), false);
  const rejected = result.rejectedJoinPaths.find((item) => item.rightEntity === "Account");
  assert.equal(rejected?.validated, false);
  assert.match(rejected?.validation?.errors?.join(" ") || "", /命中率过低/);
});
