import assert from "node:assert/strict";
import test from "node:test";
import { structuralValidation } from "./mapping-review-service.js";
import type { SemanticEntityMapping } from "./types.js";

const schema = [{ name: "accounts", rows: 2, columns: [
  { name: "id", type: "bigint", nullable: false, key: "PRI", comment: "科目ID" },
  { name: "code", type: "varchar(30)", nullable: false, key: "UNI", comment: "科目编码" },
  { name: "name", type: "varchar(100)", nullable: false, key: "", comment: "科目名称" },
] }];

function account(fields: Record<string, string>): SemanticEntityMapping {
  return { entity: "Account", table: "accounts", confidence: 1, fields, fieldMappings: {}, mappingSource: "manual", matchReasons: ["人工确认"], unresolvedFields: [] };
}

test("a nonexistent physical field cannot pass publish validation", () => {
  const result = structuralValidation(schema, [account({ id: "id", code: "missing_code", name: "name" })], []);
  assert.equal(result.valid, false); assert.match(result.errors.join(" "), /missing_code.*不存在/);
});

test("an account code mapped to a name column fails semantic validation", () => {
  const result = structuralValidation(schema, [account({ id: "id", code: "name", name: "name" })], []);
  assert.equal(result.valid, false); assert.match(result.errors.join(" "), /Account.code.*业务语义/);
});
