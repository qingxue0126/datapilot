import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadErpSchemaMappingConfig } from "./config.js";

test("database-specific mapping config takes precedence without changing the generic fallback", async () => {
  const directory = mkdtempSync(join(tmpdir(), "datapilot-config-"));
  const genericPath = join(directory, "erp-schema-mapping.json");
  try {
    writeFileSync(genericPath, JSON.stringify({ erpType: "generic", mappings: { Account: { table: "generic_account" } }, joins: [] }));
    writeFileSync(join(directory, "erp-schema-mapping.datapilot_mock.json"), JSON.stringify({ erpType: "generic", database: "datapilot_mock", mappings: { Account: { table: "mock_account" } }, joins: [] }));
    assert.equal((await loadErpSchemaMappingConfig("datapilot_mock", genericPath))?.mappings.Account?.table, "mock_account");
    assert.equal((await loadErpSchemaMappingConfig("finance_db", genericPath))?.mappings.Account?.table, "generic_account");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
