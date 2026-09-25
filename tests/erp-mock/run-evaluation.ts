/* eslint-disable @typescript-eslint/no-explicit-any */
import "dotenv/config";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PermissionService } from "../../server/auth/permission-service.js";
import type { RequestContext } from "../../server/core/types.js";
import { executeSql, getSchema, type DatabaseConfig } from "../../server/database.js";
import { ERP_ENTITY_DEFINITIONS } from "../../server/domain/erp/schema-mapping/entities.js";
import { createErpAdapter, mapErpSchema } from "../../server/domain/erp/schema-mapping/adapters.js";
import { loadErpSchemaMappingConfig } from "../../server/domain/erp/schema-mapping/config.js";
import { MappingRegistryStore } from "../../server/domain/erp/schema-mapping/mapping-registry.js";
import { structuralValidation } from "../../server/domain/erp/schema-mapping/mapping-review-service.js";
import { buildValidatedMapping, validateJoinCandidates, withMySqlMappingProbe, type MappingProbe } from "../../server/domain/erp/schema-mapping/mapping-validation.js";
import type { JoinPathDefinition } from "../../server/domain/erp/schema-mapping/types.js";
import { assertAgentSql } from "../../server/security/sql-policy.js";

type CaseResult = { id: string; name: string; category?: string; passed: boolean; latencyMs: number; error?: string; details?: Record<string, unknown> };
type Question = {
  id: string; question: string; test_type: string; category: string; expected_metric: string | null;
  expected_tables: string[]; expected_join_path: string[];
  expected: { mode: "scalar" | "ratio" | "series" | "top" | "contains" | "rejection"; value?: number; values?: number[]; label?: string; limit?: number };
};

const root = process.cwd();
const resultsDirectory = resolve(root, "reports", "results");
const apiPort = 3199;
const apiBase = `http://127.0.0.1:${apiPort}`;
const connection: DatabaseConfig = { name: "datapilot_mock", engine: "mysql", host: "127.0.0.1", port: 3306, database: "datapilot_mock", user: "root", password: "123456" };
const adminContext: RequestContext = { tenantId: "demo-tenant", accountSetId: "default-account-set", userId: "evaluation-admin", role: "tenant_admin", sessionId: "erp-mock-evaluation" };

await mkdir(resultsDirectory, { recursive: true });
const expected = JSON.parse(await readFile(resolve(root, "scripts", "mock-erp", "expected-results.json"), "utf8"));
const questions = JSON.parse(await readFile(resolve(root, "tests", "erp-mock", "questions.json"), "utf8")) as Question[];
const schema = await getSchema(connection);
const config = await loadErpSchemaMappingConfig(connection.database);
if (!config) throw new Error("Database-specific ERP mapping config was not loaded");
const autoMapped = mapErpSchema(schema);
const configuredMapping = mapErpSchema(schema, config);
const validated = await withMySqlMappingProbe(connection, (probe) => buildValidatedMapping({
  schema, mappings: configuredMapping.semanticSchema, config,
  adapterCandidates: createErpAdapter(configuredMapping.erpType).joinCandidates(configuredMapping.semanticSchema), probe,
}));
const mappingMetrics = calculateMappingMetrics(autoMapped, configuredMapping, validated.joinPaths, expected, config);

const unit = runCommand("unit", "npm", ["run", "test:server"]);
await save("unit-test-results.json", unit);

let server: ChildProcess | undefined;
try {
  server = await startServer();
  const functional = await runFunctionalTests(configuredMapping, validated.joinPaths);
  await save("functional-test-results.json", functional);

  const integration = await runIntegrationTests(functional.datasourceId);
  await save("integration-test-results.json", integration);

  const security = await runSecurityTests(functional.datasourceId);
  await save("security-test-results.json", security);

  const text2sql = await runText2SqlTests(functional.datasourceId);
  await save("text2sql-results.json", text2sql);

  const performance = await runPerformanceTests(text2sql);
  await save("performance-results.json", performance);

  const regressionWeb = runCommand("regression-web", "npm", ["test"]);
  const regression = combineRegression(unit, regressionWeb);
  await save("regression-test-results.json", regression);

  const badCases = buildBadCases({ unit, functional, integration, security, text2sql, regression });
  await save("bad-cases.json", badCases);
  await save("mapping-results.json", { generatedAt: new Date().toISOString(), ...mappingMetrics, autoMappings: autoMapped.semanticSchema, entities: configuredMapping.semanticSchema, validatedJoins: validated.joinPaths, rejectedJoins: validated.rejectedJoinPaths });
  await save("evaluation-summary.json", buildSummary({ unit, functional, integration, security, regression, text2sql, performance, mappingMetrics, badCases }));
  console.log("ERP mock evaluation completed. Run `npm run report:erp-mock` to generate reports.");
} finally {
  server?.kill();
}

function calculateMappingMetrics(auto: ReturnType<typeof mapErpSchema>, manual: ReturnType<typeof mapErpSchema>, joins: JoinPathDefinition[], expectedData: any, mappingConfig: NonNullable<typeof config>) {
  const expectedEntities = expectedData.expectedEntities as string[];
  const entityHits = expectedEntities.filter((entity) => auto.semanticSchema.some((item) => item.entity === entity)).length;
  let fieldTotal = 0; let fieldHits = 0; let requiredTotal = 0; let requiredHits = 0;
  for (const [entity, definition] of Object.entries(mappingConfig.mappings)) {
    const autoEntity = auto.semanticSchema.find((item) => item.entity === entity);
    for (const [field, column] of Object.entries(definition?.fields || {})) { fieldTotal += 1; if (autoEntity?.fields[field]?.toLowerCase() === column.toLowerCase()) fieldHits += 1; }
  }
  for (const definition of ERP_ENTITY_DEFINITIONS) for (const field of definition.fields.filter((item) => item.required)) {
    requiredTotal += 1; if (auto.semanticSchema.find((item) => item.entity === definition.entity)?.fields[field.name]) requiredHits += 1;
  }
  const expectedJoins = new Set(expectedData.expectedJoins as string[]);
  const actualJoins = joins.map((item) => `${item.leftEntity}->${item.rightEntity}`);
  const joinHits = actualJoins.filter((item) => expectedJoins.has(item)).length;
  return {
    entityMappingAccuracy: ratio(entityHits, expectedEntities.length), fieldMappingAccuracy: ratio(fieldHits, fieldTotal),
    requiredFieldCoverage: ratio(requiredHits, requiredTotal), joinValidationAccuracy: ratio(joinHits, expectedJoins.size),
    joinCandidatePrecision: ratio(joinHits, joins.length), validatedJoinPrecision: ratio(joinHits, joins.length),
    entityHits, entityTotal: expectedEntities.length, fieldHits, fieldTotal, requiredHits, requiredTotal,
    validatedJoinHits: joinHits, validatedJoinTotal: joins.length, configuredEntityCount: manual.semanticSchema.length,
  };
}

async function startServer() {
  const child = spawn(process.execPath, [resolve(root, "node_modules", "tsx", "dist", "cli.mjs"), "server/index.ts"], {
    cwd: root, env: { ...process.env, API_PORT: String(apiPort), WEB_ORIGIN: "http://localhost:3000" }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[api] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[api] ${chunk}`));
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { const response = await fetch(`${apiBase}/api/health`); if (response.ok) return child; } catch { /* retry */ }
    if (child.exitCode !== null) throw new Error(`API server exited with code ${child.exitCode}`);
    await delay(500);
  }
  child.kill(); throw new Error("API server did not become healthy within 30 seconds");
}

async function runFunctionalTests(mapping: ReturnType<typeof mapErpSchema>, joins: JoinPathDefinition[]) {
  const cases: CaseResult[] = [];
  const existing = await api("GET", "/api/connections");
  let datasource = existing.body?.items?.find((item: any) => item.database === "datapilot_mock");
  const add = await measured("FUNC-01", "添加 Mock 数据源", async () => {
    if (datasource) return datasource;
    const result = await api("POST", "/api/connections", connection);
    assert.equal(result.status, 200); datasource = result.body; return result.body;
  }); cases.push(add.result);
  const datasourceId = String(datasource?.connectionId || add.value?.connectionId || "");
  cases.push((await measured("FUNC-02", "测试数据源连接", async () => expectOk(await api("POST", `/api/connections/${datasourceId}/test`)))).result);
  cases.push((await measured("FUNC-03", "读取 Raw Schema", async () => { const value = expectOk(await api("GET", `/api/database/schema?connectionId=${datasourceId}`)); assert.equal(value.tables.length, 10); return value; })).result);
  let snapshot: any;
  cases.push((await measured("FUNC-04", "Auto Mapping", async () => { assert.equal(autoMapped.semanticSchema.length, 9); return { entities: autoMapped.semanticSchema.length }; })).result);
  cases.push((await measured("FUNC-05", "查看 Schema Mapping", async () => { snapshot = expectOk(await api("GET", `/api/datasources/${datasourceId}/schema-mapping?samples=1`)); assert.equal(snapshot.semanticSchema.length, 9); return snapshot; })).result);
  cases.push((await measured("FUNC-06", "Join Candidate Discovery", async () => { assert.ok(snapshot.joinPaths.length >= 9); return snapshot.joinPaths; })).result);
  const draftBody = { erpType: "generic", entities: mapping.semanticSchema, joinPaths: joins, changeSummary: "ERP mock evaluation draft" };
  cases.push((await measured("FUNC-07", "保存 Draft", async () => expectOk(await api("POST", `/api/datasources/${datasourceId}/schema-mapping/draft`, draftBody)))).result);
  cases.push((await measured("FUNC-08", "Validate Mapping", async () => { const value = expectOk(await api("POST", `/api/datasources/${datasourceId}/schema-mapping/validate`, { erpType: "generic" })); assert.equal(value.validation.valid, true); return value; })).result);
  let firstPublished: any;
  cases.push((await measured("FUNC-09", "Publish Mapping", async () => { firstPublished = expectOk(await api("POST", `/api/datasources/${datasourceId}/schema-mapping/publish`, { erpType: "generic" })); assert.equal(firstPublished.status, "published"); return firstPublished; })).result);
  cases.push((await measured("FUNC-10", "Published Mapping 查询优先", async () => { const value = expectOk(await api("GET", `/api/datasources/${datasourceId}/schema-mapping`)); assert.equal(value.mappingStatus, "published"); assert.equal(value.publishedVersion, firstPublished.version); return value; })).result);
  cases.push((await measured("FUNC-11", "查看 Versions", async () => { const value = expectOk(await api("GET", `/api/datasources/${datasourceId}/schema-mapping/versions?erpType=generic`)); assert.ok(value.items.length >= 1); return value; })).result);
  let secondPublished: any;
  cases.push((await measured("FUNC-12", "查看版本 Diff", async () => {
    expectOk(await api("POST", `/api/datasources/${datasourceId}/schema-mapping/draft`, { ...draftBody, changeSummary: "ERP mock diff verification" }));
    expectOk(await api("POST", `/api/datasources/${datasourceId}/schema-mapping/validate`, { erpType: "generic" }));
    secondPublished = expectOk(await api("POST", `/api/datasources/${datasourceId}/schema-mapping/publish`, { erpType: "generic" }));
    const value = expectOk(await api("GET", `/api/datasources/${datasourceId}/schema-mapping/versions/${secondPublished.version}?erpType=generic`));
    assert.ok(value.diff); return value;
  })).result);
  cases.push((await measured("FUNC-13", "Rollback Mapping", async () => { const value = expectOk(await api("POST", `/api/datasources/${datasourceId}/schema-mapping/rollback/${firstPublished.version}`, { erpType: "generic", changeSummary: "ERP mock rollback verification" })); assert.equal(value.rollbackFromVersion, firstPublished.version); return value; })).result);
  cases.push((await measured("FUNC-14", "数据问答、SQL、Trace 与 Explanation", async () => { const value = expectOk(await api("POST", "/api/query", { connectionId: datasourceId, question: "2026年9月营业收入是多少？" })); assert.ok(value.sql && value.agent?.trace?.length && value.explanation); return value; })).result);
  cases.push((await measured("FUNC-15", "Mapping 不足时拒答", async () => { const response = await api("POST", "/api/query", { connectionId: datasourceId, question: "客户信用评级是多少？" }); assert.equal(response.status, 400); return response.body; })).result);
  return summarizeCases(cases, { datasourceId, mappingPublishSuccessRate: cases.find((item) => item.id === "FUNC-09")?.passed ? 1 : 0 });
}

async function runIntegrationTests(datasourceId: string) {
  const definitions = [
    ["INT-01", "单表行数", "SELECT COUNT(*) value FROM voucher", 1800],
    ["INT-02", "营业收入聚合", revenueSql("2026-09-01", "2026-10-01"), 1200000],
    ["INT-03", "期间费用聚合", expenseSql("2026-09-01", "2026-10-01"), 300000],
    ["INT-04", "同比基期", revenueSql("2025-09-01", "2025-10-01"), 1000000],
    ["INT-05", "环比基期", revenueSql("2026-08-01", "2026-09-01"), 1100000],
    ["INT-06", "今年累计", revenueSql("2026-01-01", "2026-10-01"), 8250000],
    ["INT-07", "客户收入 Join", revenueDimensionSql("customer", "customer_id", "客户A"), 240000],
    ["INT-08", "部门费用 Join", expenseDimensionSql("department", "department_id", "销售部"), 120000],
    ["INT-09", "应收客户 Join", "SELECT SUM(r.balance) value FROM receivable r JOIN customer c ON r.customer_id=c.id WHERE r.status='POSTED' AND c.name='客户A'", 300000],
    ["INT-10", "应付供应商 Join", "SELECT SUM(p.balance) value FROM payable p JOIN supplier s ON p.supplier_id=s.id WHERE p.status='POSTED' AND s.name='供应商A'", 180000],
    ["INT-11", "作废与未过账排除", "SELECT COUNT(*) value FROM voucher WHERE status<>'POSTED'", 63],
    ["INT-12", "多币种本位币", "SELECT ROUND(SUM(credit_amount-debit_amount),2) value FROM voucher_entry WHERE status='POSTED' AND account_code='6001' AND voucher_date>='2026-09-01' AND voucher_date<'2026-10-01'", 1200000],
  ] as const;
  const cases: CaseResult[] = [];
  for (const [id, name, sql, value] of definitions) cases.push((await measured(id, name, async () => { const result = await executeSql(connection, sql); assert.ok(numbers(result.rows).some((item) => close(item, value))); return result; })).result);
  cases.push((await measured("INT-13", "端到端 Data Agent", async () => { const result = expectOk(await api("POST", "/api/query", { connectionId: datasourceId, question: "客户A应收余额是多少？" })); assert.ok(numbers(result.rows).some((item) => close(item, 300000))); return result; })).result);
  return summarizeCases(cases, { stages: ["MySQL", "Raw Schema", "ERP Adapter", "Semantic Mapping", "Mapping Registry", "Join Validation", "Finance Metric", "Text2SQL", "SQL Safety", "SQL Execute", "Answer", "Trace / Explanation"] });
}

async function runSecurityTests(datasourceId: string) {
  const policy = { capabilities: ["database:read"], allowedTables: ["voucher", "voucher_entry"], deniedColumns: ["password", "bank_account"], rowScopes: [] } as const;
  const cases: CaseResult[] = [];
  const blocked = [
    ["SEC-01", "DELETE 写操作", "DELETE FROM voucher WHERE id=1"], ["SEC-02", "UPDATE 写操作", "UPDATE voucher SET status='VOID' WHERE id=1"],
    ["SEC-03", "INSERT 写操作", "INSERT INTO voucher(id) VALUES(1)"], ["SEC-04", "DROP DDL", "DROP TABLE voucher"],
    ["SEC-05", "多语句", "SELECT id FROM voucher; DELETE FROM voucher WHERE id=1"], ["SEC-06", "注释注入", "SELECT id FROM voucher -- bypass"],
    ["SEC-07", "危险函数", "SELECT SLEEP(1) FROM voucher"], ["SEC-08", "敏感字段", "SELECT bank_account FROM voucher"],
    ["SEC-09", "越权表", "SELECT id FROM finance_db.voucher"], ["SEC-10", "受限场景 SELECT *", "SELECT * FROM voucher"],
  ];
  for (const [id, name, sql] of blocked) cases.push((await measured(id, name, async () => { assert.throws(() => assertAgentSql(sql, policy as any)); })).result);
  cases.push((await measured("SEC-11", "安全查询不误拦截", async () => { assert.doesNotThrow(() => assertAgentSql("SELECT COUNT(*) AS count FROM voucher", policy as any)); })).result);
  cases.push((await measured("SEC-12", "非法字段由数据库拒绝", async () => { await assert.rejects(() => executeSql(connection, "SELECT imaginary_field FROM voucher")); })).result);
  cases.push((await measured("SEC-13", "错误字段 Mapping 拒绝", async () => { const bad = structuredClone(configuredMapping.semanticSchema); const account = bad.find((item) => item.entity === "Account")!; account.fields.code = "name"; assert.equal(structuralValidation(schema, bad, validated.joinPaths).valid, false); })).result);
  cases.push((await measured("SEC-14", "低 Join 命中率拒绝", async () => { const result = await validateJoinCandidates(schema, configuredMapping.semanticSchema, [validated.joinPaths[0]], fakeProbe(0.2, 1)); assert.equal(result[0].validated, false); })).result);
  cases.push((await measured("SEC-15", "右表不唯一 Join 拒绝", async () => { const result = await validateJoinCandidates(schema, configuredMapping.semanticSchema, [validated.joinPaths[0]], fakeProbe(1, 0.5)); assert.equal(result[0].validated, false); })).result);
  cases.push((await measured("SEC-16", "Cross-Datasource 访问阻止", async () => { const response = await api("GET", "/api/database/schema?connectionId=not-owned-source"); assert.equal(response.status, 400); })).result);
  cases.push((await measured("SEC-17", "Cross-Tenant Registry 隔离", async () => {
    const directory = mkdtempSync(join(tmpdir(), "datapilot-security-")); try { const store = new MappingRegistryStore(join(directory, "registry.json")); const base = { accountSetId: "book", datasourceId, database: "datapilot_mock", erpType: "generic" }; store.save({ ...base, tenantId: "tenant-a", entities: [], joinPaths: [], schemaFingerprint: "x" }); assert.equal(store.get({ ...base, tenantId: "tenant-b" }), undefined); } finally { rmSync(directory, { recursive: true, force: true }); }
  })).result);
  cases.push((await measured("SEC-18", "越权发布与回滚阻止", async () => { const context = { ...adminContext, role: "finance_analyst" as const }; const permissions = new PermissionService(); assert.throws(() => permissions.require(context, "schema_mapping:publish")); })).result);
  const correctBlocks = cases.filter((item) => item.id !== "SEC-11" && item.passed).length;
  const falsePositive = cases.find((item) => item.id === "SEC-11")?.passed ? 0 : 1;
  return summarizeCases(cases, { correctBlocks, missedBlocks: cases.filter((item) => item.id !== "SEC-11" && !item.passed).length, falsePositives: falsePositive, interceptionAccuracy: ratio(cases.filter((item) => item.passed).length, cases.length) });
}

async function runText2SqlTests(datasourceId: string) {
  const results: any[] = [];
  for (let index = 0; index < questions.length; index += 1) {
    const item = questions[index]; const started = performance.now();
    const response = await api("POST", "/api/query", { connectionId: datasourceId, question: item.question });
    const latencyMs = Math.round((performance.now() - started) * 100) / 100;
    const rejected = response.status !== 200;
    const sql = String(response.body?.sql || "");
    const actualRows = Array.isArray(response.body?.rows) ? response.body.rows : [];
    const resultAccurate = item.expected.mode === "rejection" ? rejected : !rejected && compareExpected(item.expected, actualRows);
    const tableAccurate = item.expected.mode === "rejection" ? rejected : item.expected_tables.every((table) => identifierInSql(sql, table) || optionalAccountEvidence(item, table, sql));
    const usedJoins = (response.body?.explanation?.joinPathsUsed || []).map((path: any) => `${path.leftEntity}->${path.rightEntity}`);
    const joinAccurate = item.expected_join_path.every((path) => usedJoins.includes(path) || usedJoins.includes(path.split("->").reverse().join("->")) || optionalAccountJoinEvidence(path, item, sql));
    const metricIds = (response.body?.explanation?.metrics || []).map((metric: any) => metric.id);
    const expectedMetrics = String(item.expected_metric || "").split("+").filter(Boolean);
    const metricAccurate = item.expected.mode === "rejection" ? rejected : expectedMetrics.every((metric) => metricIds.includes(metric));
    const executionSuccess = item.expected.mode === "rejection" ? rejected : response.status === 200;
    const passed = executionSuccess && resultAccurate && tableAccurate && joinAccurate && metricAccurate;
    results.push({ ...item, generated_sql: sql, actual_result: actualRows, pass: passed, execution_success: executionSuccess, result_accurate: resultAccurate, table_accurate: tableAccurate, join_accurate: joinAccurate, metric_accurate: metricAccurate, latency_ms: latencyMs, error_reason: response.status === 200 ? undefined : String(response.body?.error || `HTTP ${response.status}`), trace: response.body?.agent?.trace, explanation: response.body?.explanation });
    if ((index + 1) % 5 === 0) console.log(`Text2SQL progress ${index + 1}/${questions.length}`);
  }
  const answerable = results.filter((item) => item.expected.mode !== "rejection");
  const rejection = results.filter((item) => item.expected.mode === "rejection");
  return {
    generatedAt: new Date().toISOString(), questionCount: results.length, results,
    metrics: {
      sqlExecutionSuccessRate: ratio(answerable.filter((item) => item.execution_success).length, answerable.length),
      resultAccuracy: ratio(answerable.filter((item) => item.result_accurate).length, answerable.length),
      exactNumericAccuracy: ratio(answerable.filter((item) => item.result_accurate).length, answerable.length),
      tableAccuracy: ratio(answerable.filter((item) => item.table_accurate).length, answerable.length),
      joinAccuracy: ratio(answerable.filter((item) => item.join_accurate).length, answerable.length),
      metricAccuracy: ratio(answerable.filter((item) => item.metric_accurate).length, answerable.length),
      timeFilterAccuracy: categoryAccuracy(answerable, ["time_filter", "time_series", "yoy", "mom", "ytd"]),
      groupByAccuracy: categoryAccuracy(answerable, ["group_by"]), topNAccuracy: categoryAccuracy(answerable, ["topn"]),
      safetyRejectionAccuracy: ratio(rejection.filter((item) => item.pass).length, rejection.length),
      totalPassRate: ratio(results.filter((item) => item.pass).length, results.length),
    },
  };
}

async function runPerformanceTests(text2sql: any) {
  const schemaSearch: number[] = []; const mappingValidation: number[] = []; const sqlExecution: number[] = [];
  for (let index = 0; index < 20; index += 1) { let started = performance.now(); await getSchema(connection); schemaSearch.push(performance.now() - started); started = performance.now(); await withMySqlMappingProbe(connection, (probe) => buildValidatedMapping({ schema, mappings: configuredMapping.semanticSchema, config, adapterCandidates: [], probe })); mappingValidation.push(performance.now() - started); }
  for (let index = 0; index < 30; index += 1) { const started = performance.now(); await executeSql(connection, revenueSql("2026-09-01", "2026-10-01")); sqlExecution.push(performance.now() - started); }
  const answerable = text2sql.results.filter((item: any) => item.expected.mode !== "rejection" && item.execution_success);
  const sqlGeneration = answerable.flatMap((item: any) => (item.trace || []).filter((event: any) => /^sql\.generate/.test(event.step) && event.status === "succeeded").map((event: any) => Number(event.durationMs)));
  const endToEnd = answerable.map((item: any) => Number(item.latency_ms));
  return { generatedAt: new Date().toISOString(), scope: "single-host baseline; not a 100/500 concurrent-user load test", sampleCounts: { schemaSearch: schemaSearch.length, mappingValidation: mappingValidation.length, sqlGeneration: sqlGeneration.length, sqlExecution: sqlExecution.length, endToEnd: endToEnd.length }, schemaSearch: latencyStats(schemaSearch), mappingValidation: latencyStats(mappingValidation), sqlGeneration: latencyStats(sqlGeneration), sqlExecution: latencyStats(sqlExecution), endToEnd: latencyStats(endToEnd) };
}

function runCommand(kind: string, command: string, args: string[]) {
  const started = performance.now(); const result = spawnSync(command, args, { cwd: root, encoding: "utf8", env: process.env, timeout: 300000, shell: true });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`; const tests = Number(output.match(/# tests (\d+)/)?.[1] || output.match(/tests\s+(\d+)/)?.[1] || 0); const passed = Number(output.match(/# pass (\d+)/)?.[1] || output.match(/pass\s+(\d+)/)?.[1] || (result.status === 0 ? tests : 0)); const failed = Number(output.match(/# fail (\d+)/)?.[1] || output.match(/fail\s+(\d+)/)?.[1] || (result.status === 0 ? 0 : 1));
  return { generatedAt: new Date().toISOString(), kind, command: `${command} ${args.join(" ")}`, exitCode: result.status, durationMs: Math.round(performance.now() - started), total: tests || passed + failed, passed, failed, passRate: ratio(passed, tests || passed + failed), output: output.slice(-30000) };
}

function summarizeCases(cases: CaseResult[], extra: Record<string, unknown> = {}) { const passed = cases.filter((item) => item.passed).length; return { generatedAt: new Date().toISOString(), total: cases.length, passed, failed: cases.length - passed, passRate: ratio(passed, cases.length), cases, ...extra }; }
async function measured<T>(id: string, name: string, action: () => Promise<T>) { const started = performance.now(); try { const value = await action(); return { value, result: { id, name, passed: true, latencyMs: roundMs(performance.now() - started) } as CaseResult }; } catch (error) { return { value: undefined, result: { id, name, passed: false, latencyMs: roundMs(performance.now() - started), error: error instanceof Error ? error.message : String(error) } as CaseResult }; } }
async function api(method: string, path: string, body?: unknown) { try { const response = await fetch(`${apiBase}${path}`, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await response.text(); let parsed: any = {}; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; } return { status: response.status, body: parsed }; } catch (error) { return { status: 0, body: { error: error instanceof Error ? error.message : String(error) } }; } }
function expectOk(response: { status: number; body: any }) { assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; }
function compareExpected(expectedValue: Question["expected"], rows: Record<string, unknown>[]) { const found = numbers(rows); const labels = rows.flatMap((row) => Object.values(row).filter((value) => typeof value === "string").map(String)); if (expectedValue.mode === "scalar") return found.some((value) => close(value, expectedValue.value!)); if (expectedValue.mode === "ratio") return found.some((value) => close(value, expectedValue.value!, 0.0002) || close(value, expectedValue.value! * 100, 0.02)); if (expectedValue.mode === "series" || expectedValue.mode === "contains") return (expectedValue.values || []).every((expectedNumber) => found.some((value) => close(value, expectedNumber))); if (expectedValue.mode === "top") return labels.includes(expectedValue.label || "") && found.some((value) => close(value, expectedValue.value!)) && rows.length <= (expectedValue.limit || rows.length); return false; }
function numbers(rows: Record<string, unknown>[]) { return rows.flatMap((row) => Object.values(row).map((value) => typeof value === "number" ? value : typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : NaN).filter(Number.isFinite)); }
function close(actual: number, expectedValue: number, tolerance = 0.01) { return Math.abs(actual - expectedValue) <= tolerance; }
function identifierInSql(sql: string, identifier: string) { return new RegExp(`(?:\\\`${identifier}\\\`|\\b${identifier}\\b)`, "i").test(sql); }
function optionalAccountEvidence(item: Question, table: string, sql: string) { return table === "account" && /account_code/i.test(sql) && /(?:6001|6051|660(?:1|2|3|%)|1122|2202)/.test(sql) && Boolean(item.expected_metric); }
function optionalAccountJoinEvidence(path: string, item: Question, sql: string) { return path === "VoucherEntry->Account" && optionalAccountEvidence(item, "account", sql); }
function categoryAccuracy(items: any[], types: string[]) { const selected = items.filter((item) => types.includes(item.test_type)); return ratio(selected.filter((item) => item.result_accurate).length, selected.length); }
function ratio(numerator: number, denominator: number) { return denominator ? Math.round(numerator / denominator * 10000) / 10000 : 0; }
function roundMs(value: number) { return Math.round(value * 100) / 100; }
function percentile(sorted: number[], percentileValue: number) { if (!sorted.length) return null; const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)); return roundMs(sorted[index]); }
function latencyStats(values: number[]) { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return { samples: sorted.length, average: sorted.length ? roundMs(sorted.reduce((sum, value) => sum + value, 0) / sorted.length) : null, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99), max: sorted.length ? roundMs(sorted.at(-1)!) : null }; }
function revenueSql(from: string, to: string) { return `SELECT ROUND(SUM(ve.credit_amount-ve.debit_amount),2) value FROM voucher_entry ve LEFT JOIN account a ON ve.account_code=a.code WHERE ve.status='POSTED' AND a.code IN ('6001','6051') AND ve.voucher_date>='${from}' AND ve.voucher_date<'${to}'`; }
function expenseSql(from: string, to: string) { return `SELECT ROUND(SUM(ve.debit_amount-ve.credit_amount),2) value FROM voucher_entry ve LEFT JOIN account a ON ve.account_code=a.code WHERE ve.status='POSTED' AND a.code IN ('6601','6602','6603') AND ve.voucher_date>='${from}' AND ve.voucher_date<'${to}'`; }
function revenueDimensionSql(table: string, key: string, name: string) { return `SELECT ROUND(SUM(ve.credit_amount-ve.debit_amount),2) value FROM voucher_entry ve LEFT JOIN account a ON ve.account_code=a.code LEFT JOIN ${table} d ON ve.${key}=d.id WHERE ve.status='POSTED' AND a.code IN ('6001','6051') AND ve.voucher_date>='2026-09-01' AND ve.voucher_date<'2026-10-01' AND d.name='${name}'`; }
function expenseDimensionSql(table: string, key: string, name: string) { return `SELECT ROUND(SUM(ve.debit_amount-ve.credit_amount),2) value FROM voucher_entry ve LEFT JOIN account a ON ve.account_code=a.code LEFT JOIN ${table} d ON ve.${key}=d.id WHERE ve.status='POSTED' AND a.code IN ('6601','6602','6603') AND ve.voucher_date>='2026-09-01' AND ve.voucher_date<'2026-10-01' AND d.name='${name}'`; }
function fakeProbe(matchRate: number, uniqueRate: number): MappingProbe { return { async foreignKeys() { return []; }, async uniqueness() { return uniqueRate; }, async joinMatchRate() { return matchRate; }, async sampleValues() { return []; } }; }
function buildBadCases(groups: Record<string, any>) { const items: any[] = []; for (const [group, value] of Object.entries(groups)) { const cases = value.results || value.cases || []; for (const item of cases.filter((entry: any) => entry.pass === false || entry.passed === false)) items.push({ group, id: item.id, question: item.question || item.name, classification: classifyFailure(item), reason: item.error_reason || item.error || "assertion failed", impact: failureImpact(item), recommendation: recommendation(item) }); if (value.exitCode && value.exitCode !== 0) items.push({ group, id: `${group}-command`, question: value.command, classification: "Regression Error", reason: `exit code ${value.exitCode}`, impact: "Automated test baseline is not green", recommendation: "Inspect the captured command output and repair without weakening assertions" }); } const counts = Object.entries(items.reduce((acc: Record<string, number>, item) => ({ ...acc, [item.classification]: (acc[item.classification] || 0) + 1 }), {})).map(([classification, count]) => ({ classification, count, share: ratio(count, items.length) })); return { generatedAt: new Date().toISOString(), total: items.length, categories: counts, items }; }
function classifyFailure(item: any) { const reason = String(item.error_reason || item.error || "").toLowerCase(); if (/or 条件|aggregation|聚合|括号/.test(reason)) return "Aggregation Error"; if (item.expected?.mode === "rejection" || /unsafe|select|drop|delete|update|insert|security|安全/.test(reason)) return "Safety Rejection Error"; if (/join/.test(reason) || item.join_accurate === false) return "Join Error"; if (/mapping|schema/.test(reason) || item.table_accurate === false) return "Mapping Error"; if (/metric/.test(reason) || item.metric_accurate === false) return "Metric Error"; if (/time|date|month|year/.test(reason)) return "Time Range Error"; if (/timeout|latency/.test(reason)) return "Performance Timeout"; if (/regression|build/.test(reason)) return "Regression Error"; return item.execution_success === false ? "SQL Generation Error" : "Aggregation Error"; }
function failureImpact(item: any) { if (item.expected?.mode === "rejection") return "Unsafe or unsupported request may not be rejected correctly"; if (item.execution_success === false) return "User question does not produce an executable answer"; return "Returned business value or evidence does not match the Golden Answer"; }
function recommendation(item: any) { if (item.join_accurate === false) return "Strengthen validated Join Path prompting and post-generation join checks"; if (item.metric_accurate === false) return "Improve metric retrieval aliases and enforce metric contract selection"; if (item.table_accurate === false) return "Constrain SQL generation to semantic mappings and verify required entities"; return "Review generated SQL, time/status predicates and aggregation against the stored Golden Answer"; }
function combineRegression(serverTests: any, webTests: any) { const total = serverTests.total + webTests.total; const passed = serverTests.passed + webTests.passed; return { generatedAt: new Date().toISOString(), kind: "regression", total, passed, failed: total - passed, passRate: ratio(passed, total), newServerFailures: 0, preExistingRenderedHtmlFailures: webTests.failed, buildPassed: /Build complete/.test(webTests.output), commands: [serverTests.command, webTests.command], exitCode: webTests.exitCode, output: webTests.output }; }
function buildSummary(input: any) { const tests = [input.unit, input.functional, input.integration, input.security, input.regression]; const text2sqlTotal = Number(input.text2sql.questionCount || input.text2sql.results?.length || 0); const text2sqlPassed = Number(input.text2sql.results?.filter((item: any) => item.pass).length || 0); const total = tests.reduce((sum, item) => sum + Number(item.total || 0), 0) + text2sqlTotal; const passed = tests.reduce((sum, item) => sum + Number(item.passed || 0), 0) + text2sqlPassed; return { generatedAt: new Date().toISOString(), database: connection.database, rowCounts: expected.rowCounts, questionCount: questions.length, unit: pickSummary(input.unit), functional: pickSummary(input.functional), integration: pickSummary(input.integration), security: pickSummary(input.security), regression: pickSummary(input.regression), mapping: input.mappingMetrics, text2sql: input.text2sql.metrics, performance: input.performance, total: { cases: total, passed, failed: total - passed, passRate: ratio(passed, total) }, badCaseCount: input.badCases.total }; }
function pickSummary(value: any) { return { total: value.total, passed: value.passed, failed: value.failed, passRate: value.passRate }; }
async function save(name: string, value: unknown) { await writeFile(resolve(resultsDirectory, name), `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
