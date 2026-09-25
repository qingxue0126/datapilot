import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MappingRegistryStore } from "./mapping-registry.js";
import type { JoinPathDefinition, SemanticEntityMapping } from "./types.js";

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

const key = { tenantId: "tenant-a", accountSetId: "book-1", datasourceId: "source-a", database: "finance", erpType: "generic" };
const entity: SemanticEntityMapping = { entity: "Account", table: "accounts", confidence: 1, fields: { id: "id", code: "code", name: "name" }, fieldMappings: {}, mappingSource: "manual", matchReasons: ["人工确认"], unresolvedFields: [] };
const compositeJoin: JoinPathDefinition = { id: "manual:entry-account", leftEntity: "VoucherEntry", rightEntity: "Account", leftTable: "entries", rightTable: "accounts", fields: [{ leftField: "accountCode", rightField: "code" }, { leftField: "organizationId", rightField: "organizationId" }], joinType: "left", confidence: 1, source: "manual", validated: true, validation: { checked: true, matchRate: 1, rightUniqueRate: 1 } };

function temporaryStore(run: (store: MappingRegistryStore) => void) {
  const directory = mkdtempSync(join(tmpdir(), "datapilot-version-registry-"));
  try { run(new MappingRegistryStore(join(directory, "registry.json"))); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("draft can be saved without affecting the published mapping", () => temporaryStore((store) => {
  const draft = store.saveDraft(key, { entities: [entity], joinPaths: [], schemaFingerprint: "schema-1", validation: { valid: false, errors: ["待校验"] }, changeSummary: "确认科目表" }, "user-a");
  assert.equal(draft.status, "draft");
  assert.equal(store.getDraft(key)?.version, 1);
  assert.equal(store.getPublished(key), undefined);
  assert.equal(store.listAudits(key)[0]?.action, "draft_saved");
}));

test("version registry keeps tenant and datasource drafts isolated", () => temporaryStore((store) => {
  const tenantB = { ...key, tenantId: "tenant-b" }; const sourceB = { ...key, datasourceId: "source-b" };
  store.saveDraft(key, { entities: [entity], joinPaths: [], schemaFingerprint: "a" }, "user-a");
  store.saveDraft(tenantB, { entities: [{ ...entity, table: "tenant_b_accounts" }], joinPaths: [], schemaFingerprint: "b" }, "user-b");
  store.saveDraft(sourceB, { entities: [{ ...entity, table: "source_b_accounts" }], joinPaths: [], schemaFingerprint: "c" }, "user-a");
  assert.equal(store.getDraft(key)?.entities[0].table, "accounts");
  assert.equal(store.getDraft(tenantB)?.entities[0].table, "tenant_b_accounts");
  assert.equal(store.getDraft(sourceB)?.entities[0].table, "source_b_accounts");
}));

test("validation failure prevents publishing", () => temporaryStore((store) => {
  store.saveDraft(key, { entities: [entity], joinPaths: [], schemaFingerprint: "schema-1", validation: { valid: false, errors: ["字段不存在"] } }, "user-a");
  assert.throws(() => store.publishDraft(key, "admin"), /无法发布 Mapping/);
}));

test("publishing activates draft and a later publication archives the old version", () => temporaryStore((store) => {
  store.saveDraft(key, { entities: [entity], joinPaths: [], schemaFingerprint: "schema-1", validation: { valid: true, errors: [] } }, "user-a");
  const first = store.publishDraft(key, "admin");
  const changed = { ...entity, fields: { ...entity.fields, category: "category" } };
  store.saveDraft(key, { entities: [changed], joinPaths: [], schemaFingerprint: "schema-1", validation: { valid: true, errors: [] } }, "user-a");
  const second = store.publishDraft(key, "admin");
  assert.equal(first.version, 1); assert.equal(second.version, 2);
  assert.equal(store.getVersion(key, 1)?.status, "archived");
  assert.equal(store.getPublished(key)?.version, 2);
}));

test("query resolution uses published mapping instead of the latest automatic mapping", () => temporaryStore((store) => {
  store.save({ ...key, entities: [{ ...entity, table: "auto_accounts" }], joinPaths: [], schemaFingerprint: "schema-auto" });
  store.saveDraft(key, { entities: [{ ...entity, table: "published_accounts" }], joinPaths: [], schemaFingerprint: "schema-published", validation: { valid: true, errors: [] } }, "user-a");
  store.publishDraft(key, "admin");
  const active = store.resolveForQuery(key);
  assert.equal(active.status, "published");
  assert.equal(active.record?.entities[0].table, "published_accounts");
}));

test("rollback creates a new published version and preserves history", () => temporaryStore((store) => {
  store.saveDraft(key, { entities: [entity], joinPaths: [], schemaFingerprint: "schema-1", validation: { valid: true, errors: [] } }, "user-a"); store.publishDraft(key, "admin");
  const changed = { ...entity, fields: { ...entity.fields, category: "category" } };
  store.saveDraft(key, { entities: [changed], joinPaths: [], schemaFingerprint: "schema-1", validation: { valid: true, errors: [] } }, "user-a"); store.publishDraft(key, "admin");
  const rolledBack = store.rollback(key, 1, { valid: true, errors: [] }, "admin");
  assert.equal(rolledBack.version, 3); assert.equal(rolledBack.rollbackFromVersion, 1);
  assert.deepEqual(rolledBack.entities[0].fields, entity.fields);
  assert.equal(store.getVersion(key, 1)?.status, "archived");
  assert.equal(store.listAudits(key)[0]?.action, "rolled_back");
}));

test("historical versions are immutable when a draft is edited", () => temporaryStore((store) => {
  store.saveDraft(key, { entities: [entity], joinPaths: [], schemaFingerprint: "schema-1", validation: { valid: true, errors: [] } }, "user-a"); store.publishDraft(key, "admin");
  const before = store.getVersion(key, 1);
  store.saveDraft(key, { entities: [{ ...entity, table: "new_accounts" }], joinPaths: [], schemaFingerprint: "schema-2", validation: { valid: false, errors: ["待校验"] } }, "user-a");
  assert.deepEqual(store.getVersion(key, 1), before);
}));

test("composite joins survive draft and publish lifecycle", () => temporaryStore((store) => {
  store.saveDraft(key, { entities: [entity], joinPaths: [compositeJoin], schemaFingerprint: "schema-1", validation: { valid: true, errors: [] } }, "user-a");
  const published = store.publishDraft(key, "admin");
  assert.equal(published.joinPaths[0].fields.length, 2);
}));

test("mapping diff reports field and join changes", () => temporaryStore((store) => {
  store.saveDraft(key, { entities: [entity], joinPaths: [], schemaFingerprint: "schema-1", validation: { valid: true, errors: [] } }, "user-a"); store.publishDraft(key, "admin");
  store.saveDraft(key, { entities: [{ ...entity, fields: { ...entity.fields, category: "category" } }], joinPaths: [compositeJoin], schemaFingerprint: "schema-1", validation: { valid: true, errors: [] } }, "user-a"); store.publishDraft(key, "admin");
  const diff = store.diff(key, 2);
  assert.deepEqual(diff.addedMappings, ["Account.category → category"]);
  assert.equal(diff.addedJoins.length, 1);
}));
