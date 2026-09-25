import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MappingRegistryStore } from "./mapping-registry.js";

test("mapping registry isolates tenant, datasource and database keys and increments versions", () => {
  const directory = mkdtempSync(join(tmpdir(), "datapilot-mapping-registry-"));
  try {
    const store = new MappingRegistryStore(join(directory, "registry.json"));
    const base = { accountSetId: "book-1", database: "finance", erpType: "generic", entities: [], joinPaths: [], schemaFingerprint: "v1" };
    const first = store.save({ ...base, tenantId: "tenant-a", datasourceId: "source-a" });
    store.save({ ...base, tenantId: "tenant-b", datasourceId: "source-a" });
    const second = store.save({ ...base, tenantId: "tenant-a", datasourceId: "source-a", schemaFingerprint: "v2" });
    assert.equal(first.version, 1);
    assert.equal(second.version, 2);
    assert.equal(store.get({ tenantId: "tenant-b", accountSetId: "book-1", datasourceId: "source-a", database: "finance", erpType: "generic" })?.version, 1);
    assert.equal(store.get({ tenantId: "tenant-a", accountSetId: "book-1", datasourceId: "missing", database: "finance", erpType: "generic" }), undefined);
    const reloaded = new MappingRegistryStore(join(directory, "registry.json"));
    assert.equal(reloaded.get({ tenantId: "tenant-a", accountSetId: "book-1", datasourceId: "source-a", database: "finance", erpType: "generic" })?.schemaFingerprint, "v2");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
