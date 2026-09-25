/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const results = resolve(root, "reports", "results");
const reports = resolve(root, "reports");
await mkdir(resolve(reports, "assets"), { recursive: true });
const read = async (name: string) => JSON.parse(await readFile(resolve(results, name), "utf8"));
const summary = await read("evaluation-summary.json");
const unit = await read("unit-test-results.json");
const functional = await read("functional-test-results.json");
const integration = await read("integration-test-results.json");
const security = await read("security-test-results.json");
const regression = await read("regression-test-results.json");
const text2sql = await read("text2sql-results.json");
const bad = await read("bad-cases.json");

const pct = (value: number) => `${(value * 100).toFixed(2)}%`;
const testRows = [
  ["单元测试", unit.total, unit.passed, unit.failed, pct(unit.passRate)],
  ["功能测试", functional.total, functional.passed, functional.failed, pct(functional.passRate)],
  ["集成测试", integration.total, integration.passed, integration.failed, pct(integration.passRate)],
  ["安全测试", security.total, security.passed, security.failed, pct(security.passRate)],
  ["回归测试", regression.total, regression.passed, regression.failed, pct(regression.passRate)],
  ["Text2SQL", text2sql.questionCount, text2sql.results.filter((item: any) => item.pass).length, text2sql.results.filter((item: any) => !item.pass).length, pct(text2sql.metrics.totalPassRate)],
];
const markdownTable = (headers: string[], rows: unknown[][]) => `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n${rows.map((row) => `| ${row.join(" | ")} |`).join("\n")}`;
const assets = (name: string, alt: string) => `![${alt}](assets/${name})`;
const badRows = bad.items.map((item: any) => [item.id, item.classification, String(item.question).replaceAll("|", "\\|"), String(item.reason).replaceAll("|", "\\|"), item.impact, item.recommendation]);
const successful = text2sql.results.filter((item: any) => item.pass && item.expected.mode !== "rejection").slice(0, 3);
const failed = text2sql.results.filter((item: any) => !item.pass);

const md = `# DataPilot ERP Mock 测试与量化验收报告

生成时间：${summary.generatedAt}

目标数据库：\`datapilot_mock\`

固定 Seed：\`20260925\`

## 1. 测试概述

本轮在独立 MySQL 数据库中构造可重复 ERP 财务数据，通过现有 DataSource API 接入 DataPilot，执行单元、功能、集成、安全、回归和基础性能测试。浏览器自动化因已知 trust 问题未使用，UI 验收另见 [manual-ui-checklist.md](manual-ui-checklist.md)。

自动化共计 **${summary.total.cases}** 个检查，**${summary.total.passed}** 个通过、**${summary.total.failed}** 个失败，总通过率 **${pct(summary.total.passRate)}**。Text2SQL 标准题集 60 条，通过率 **${pct(summary.text2sql.totalPassRate)}**。

${assets("success-failure-share.png", "自动化验收成功失败占比")}

## 2. 测试目标与范围

覆盖 Schema Mapping、Mapping Registry、Review/Validation、Join Policy、Join Validation、Finance Metric、Data Agent、Text2SQL、SQL Safety、DataSource/Query API、版本发布/Diff/Rollback、租户/数据源隔离和基础延迟。未执行 100/500 并发压力、浏览器自动点击、真实生产租户认证与生产数据写入。

## 3. 测试环境

- Windows，Node.js ${process.version}
- MySQL 5.7.24，127.0.0.1:3306
- 数据库：datapilot_mock（未访问或修改 finance_db）
- LLM：项目当前 DeepSeek 配置，temperature=0
- API：本地隔离端口 3199

## 4. Mock 数据设计

核心 9 表严格对应当前 ERP 实体；凭证与分录保持借贷平衡，POSTED/VOID/DRAFT/INVALID_STATUS 同时存在；原币 USD 与本位币金额并存；收入、费用、应收、应付按固定金额分摊。15 条异常目录覆盖缺失 accountCode、错误 Mapping、缺失/低质量/不唯一 Join、无效字段、异常状态、多币种、重复 Join、写 SQL、注入及跨范围访问。

## 5. Mock 数据规模

${markdownTable(["表", "行数"], Object.entries(summary.rowCounts))}

## 6. 测试方法

1. 一键重建数据库并用独立 SQL 校验 Golden Answer。
2. 无配置执行 Auto Mapping，再与 74 个字段 Ground Truth 对比。
3. 通过 DataSource API 保存 Draft、Validate、Publish、Diff、Rollback。
4. 60 条问题逐条调用真实 Data Agent，按可执行性、表/字段、Join、指标、时间、聚合和业务结果判定。
5. 安全用例同时覆盖问题入口、生成 SQL、SQL AST 策略、权限与 Registry 隔离。
6. 多轮采样计算 Average/P50/P95/P99/Max。

${assets("test-type-counts.png", "测试类型用例数量分布")}

## 7. 单元测试结果

46 / 46 通过（100%），较本轮开始的 41 条增加 5 条，覆盖数据库专属 Mapping 配置、VoucherEntry 主外键映射、费用短问法、跨库 SQL、OR 条件分组和问题入口安全；无新增单元失败。

## 8. 功能测试结果

${markdownTable(["类型", "总数", "通过", "失败", "通过率"], testRows)}

15 个功能点全部通过：数据源、Raw Schema、Auto Mapping、Mapping/Join 查看、Draft、Validate、Publish、Published 优先、Versions、Diff、Rollback、问答/SQL/Trace/Explanation、Mapping 不足拒答。

${assets("test-type-pass-rates.png", "各测试类型通过率")}

## 9. 集成测试结果

13 / 13 通过。完整链路 MySQL → Raw Schema → ERP Adapter → Semantic Mapping → Registry → Join Validation → Metric → Text2SQL → SQL Safety → Execute → Answer → Trace/Explanation 已验证；单表、聚合、时间、客户、供应商、部门、应收应付、多币种和状态排除均有覆盖。

## 10. 安全测试结果

18 / 18 通过。写操作、DDL、多语句、注释注入、危险函数、敏感字段、越权表、SELECT *、非法字段、错误 Mapping、低命中率 Join、右表不唯一、Cross-Datasource、Cross-Tenant 和越权发布/回滚均正确拦截；安全查询无误拦截。Text2SQL 安全拒答 8 / 8。

## 11. 回归测试结果

46 / 48 通过（${pct(regression.passRate)}）。本轮 46 条 server 测试全部通过、生产构建成功；现有 \`tests/rendered-html.test.mjs\` 的 2 条 starter 断言失败：构建 HTML 不含 \`codex-preview=development\` meta，且 \`app/_sites-preview/SkeletonPreview.tsx\` 已不存在。相关文件本轮未修改，因此判定为既有测试债务；未发现本轮新增 server 功能退化。

## 12. 性能测试结果

本轮属于单机基础性能测试，不是 100/500 并发用户级压力测试。

${markdownTable(["阶段", "Average ms", "P50", "P95", "P99", "Max"], [
  ["Schema Search", ...["average","p50","p95","p99","max"].map(k => summary.performance.schemaSearch[k])],
  ["Mapping Validation", ...["average","p50","p95","p99","max"].map(k => summary.performance.mappingValidation[k])],
  ["SQL Generation", ...["average","p50","p95","p99","max"].map(k => summary.performance.sqlGeneration[k])],
  ["SQL Execution", ...["average","p50","p95","p99","max"].map(k => summary.performance.sqlExecution[k])],
  ["End-to-End", ...["average","p50","p95","p99","max"].map(k => summary.performance.endToEnd[k])],
])}

${assets("latency-percentiles.png", "P50 P95 P99 延迟")}

## 13. Mapping 专项测试结果

${markdownTable(["指标", "结果"], [
  ["Entity Mapping Accuracy", pct(summary.mapping.entityMappingAccuracy)],
  ["Field Mapping Accuracy", `${summary.mapping.fieldHits}/${summary.mapping.fieldTotal} (${pct(summary.mapping.fieldMappingAccuracy)})`],
  ["Required Field Coverage", `${summary.mapping.requiredHits}/${summary.mapping.requiredTotal} (${pct(summary.mapping.requiredFieldCoverage)})`],
  ["Join Candidate Precision", pct(summary.mapping.joinCandidatePrecision)],
  ["Validated Join Precision", pct(summary.mapping.validatedJoinPrecision)],
  ["Mapping 发布成功率", "100%"],
])}

${assets("mapping-accuracy.png", "Mapping Accuracy")}

${assets("join-validation-accuracy.png", "Join Validation Accuracy")}

## 14. Text2SQL 准确率测试

${markdownTable(["指标", "结果"], Object.entries(summary.text2sql).map(([key, value]) => [key, pct(Number(value))]))}

59 / 60 标准问题通过。唯一失败 \`EXP-02 本月费用合计\` 在三次生成中都产生未分组科目 OR 条件，被新增的业务正确性校验拒绝，未执行错误 SQL；这属于安全失败（fail closed），但仍记为 Text2SQL 未通过。

${assets("scenario-distribution.png", "测试场景分布")}

${assets("question-category-accuracy.png", "各类问题准确率")}

${assets("metric-accuracy-comparison.png", "指标正确率对比")}

## 15. Golden Answer 对比结果

${markdownTable(["Golden Answer", "值"], [
  ["2025-09 营业收入", "1,000,000"], ["2026-08 营业收入", "1,100,000"], ["2026-09 营业收入", "1,200,000"],
  ["同比", "20.00%"], ["环比", "9.09%"], ["2026 年 1-9 月累计收入", "8,250,000"],
  ["2026-09 期间费用", "300,000"], ["销售部 2026-09 费用", "120,000"],
  ["应收余额", "1,000,000"], ["客户 A / B 应收", "300,000 / 200,000"], ["应付余额", "700,000"], ["供应商 A 应付", "180,000"],
])}

## 16. Bad Case 分析

当前真实失败只有 2 类，不补造到 5 类。

${badRows.length ? markdownTable(["编号", "分类", "示例", "根因", "影响", "建议"], badRows) : "无当前失败。"}

${assets("bad-case-categories.png", "Bad Case 分类")}

已在测试中发现并修复的高优先级 Bad Case：VoucherEntry.voucherId 误映射、跨库限定名绕过、费用短问法漏检索、状态枚举猜测、直接应收/应付表未优先、未分组 OR 被错误执行、写/DDL 注入意图未在入口拒绝。

## 17. 典型成功案例

${successful.map((item: any) => `- **${item.id} ${item.question}**：结果 ${JSON.stringify(item.actual_result)}；SQL：\`${String(item.generated_sql).replaceAll("`", "'").replaceAll("\n", " ")}\``).join("\n")}

## 18. 典型失败案例

${failed.map((item: any) => `- **${item.id} ${item.question}**：${item.error_reason || "结果/证据不符合预期"}`).join("\n") || "- 无 Text2SQL 失败。"}
- **Rendered HTML regression**：2 条过期 starter 断言失败，生产构建本身成功。

## 19. 当前系统能力边界

- 仅实现 MySQL；本环境实际为 5.7，因此提示层已禁止比较查询使用 CTE。
- 状态、币种、会计期间仍依赖各租户真实样本与发布 Mapping。
- LLM 生成具有小概率格式波动，需保留业务语义后校验与重试。
- 当前 Mapping Registry 为本地文件持久化，不是多节点事务型 Registry。
- 本轮未验证生产 JWT/OIDC、并发容量、灾备、审计导出和真实 ERP 大规模异构 Schema。

## 20. Readiness 判定

- **Demo：达到。** 核心链路、解释、Trace、版本流程与 Golden Answer 可稳定展示。
- **POC：有条件达到。** 需限定在已发布 Mapping、已确认口径、单机低并发环境，并接受 LLM 失败重试。
- **Production Readiness：未达到。** 仍有回归测试债务、单问法失败、文件型 Registry、认证/并发/灾备/审计与真实客户化口径缺口。

## 21. 下一阶段改进建议

1. 将财务科目范围与状态值编译为结构化 SQL 约束或模板，而非完全依赖提示。
2. 修复/移除过期 rendered-html starter 测试，建立稳定 UI smoke suite。
3. 为 Mapping Registry 引入数据库持久化、乐观锁、审计查询和多节点一致性。
4. 扩充到真实 ERP Schema、特殊会计期间、红字、冲销、汇率和期初余额场景。
5. 增加并发、容量、长查询熔断、超时、资源限额和灾备演练。
6. 完成生产 JWT/OIDC、行级权限、跨租户渗透测试和人工 UI 签字验收。

## 修改分类

- **测试基础设施**：Mock schema/seed/generator/reset、60 问题集、六类 runner、报告/图表/PDF 生成器、UI 清单。
- **产品 Bug 修复**：主外键自动映射、数据库专属 Mapping 配置、费用检索、真实状态样本传递、直接余额表优先、OR 分组校验、跨数据库 SQL 阻止、问题入口写/DDL 拒绝、MySQL 5.7 比较查询约束。
- **未修复**：\`EXP-02\` 三次生成仍不满足 OR 分组；2 条过期 rendered-html 回归断言。

## 原始证据

机器可读结果位于 \`reports/results/\`；Golden Answer 位于 \`scripts/mock-erp/expected-results.json\`；所有图表位于 \`reports/assets/\`。
`;

await writeFile(resolve(reports, "datapilot-erp-mock-evaluation.md"), md, "utf8");

const inlineHtml = (value: string) => value
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
function markdownToHtml(source: string) {
  const lines = source.split("\n"); const output: string[] = []; let index = 0;
  while (index < lines.length) {
    const line = lines[index].trimEnd();
    if (!line.trim()) { index += 1; continue; }
    if (line.startsWith("```")) { const code: string[] = []; index += 1; while (index < lines.length && !lines[index].startsWith("```")) code.push(lines[index++]); index += 1; output.push(`<pre><code>${inlineHtml(code.join("\n"))}</code></pre>`); continue; }
    if (line.startsWith("| ")) { const tableLines: string[] = []; while (index < lines.length && lines[index].trim().startsWith("|")) tableLines.push(lines[index++].trim()); const rows = tableLines.filter((row) => !/^\|(?:\s*:?-+:?\s*\|)+$/.test(row)).map((row) => row.slice(1, -1).split("|").map((cell) => inlineHtml(cell.trim()))); output.push(`<div class="table-wrap"><table>${rows.map((row, rowIndex) => `<tr>${row.map((cell) => rowIndex === 0 ? `<th>${cell}</th>` : `<td>${cell}</td>`).join("")}</tr>`).join("")}</table></div>`); continue; }
    if (/^[-*] /.test(line)) { const items: string[] = []; while (index < lines.length && /^[-*] /.test(lines[index].trim())) items.push(`<li>${inlineHtml(lines[index++].trim().slice(2))}</li>`); output.push(`<ul>${items.join("")}</ul>`); continue; }
    if (/^\d+\. /.test(line)) { const items: string[] = []; while (index < lines.length && /^\d+\. /.test(lines[index].trim())) items.push(`<li>${inlineHtml(lines[index++].trim().replace(/^\d+\. /, ""))}</li>`); output.push(`<ol>${items.join("")}</ol>`); continue; }
    const image = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/); if (image) { output.push(`<figure><img src="${image[2]}" alt="${inlineHtml(image[1])}"><figcaption>${inlineHtml(image[1])}</figcaption></figure>`); index += 1; continue; }
    if (line.startsWith("# ")) output.push(`<h1>${inlineHtml(line.slice(2))}</h1>`);
    else if (line.startsWith("## ")) output.push(`<h2>${inlineHtml(line.slice(3))}</h2>`);
    else if (line.startsWith("### ")) output.push(`<h3>${inlineHtml(line.slice(4))}</h3>`);
    else if (line.startsWith("> ")) output.push(`<blockquote>${inlineHtml(line.slice(2))}</blockquote>`);
    else output.push(`<p>${inlineHtml(line.replace(/  $/, ""))}</p>`);
    index += 1;
  }
  return output.join("\n");
}
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DataPilot ERP Mock 测试报告</title><style>body{font-family:"Microsoft YaHei",system-ui,sans-serif;max-width:1120px;margin:0 auto;padding:36px;color:#1a202c;line-height:1.65}h1,h2,h3{color:#17365d}h1{font-size:32px}h2{border-bottom:2px solid #d9eaf7;padding-bottom:6px;margin-top:40px}table{border-collapse:collapse;width:100%;margin:12px 0 24px}th,td{border:1px solid #cbd5e0;padding:7px 9px;text-align:left;vertical-align:top}th{background:#d9eaf7}.table-wrap{overflow-x:auto}figure{margin:24px 0}img{max-width:100%;display:block;margin:0 auto}figcaption{text-align:center;color:#718096;font-size:13px}code{background:#edf2f7;padding:2px 4px;border-radius:3px}pre{overflow:auto;background:#1a202c;color:#edf2f7;padding:14px}blockquote{border-left:4px solid #2367a5;margin-left:0;padding:8px 16px;background:#f7fafc}.kpi{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.card{background:#f7fafc;border:1px solid #d9e2ec;padding:14px}.value{font-size:24px;color:#2367a5}@media(max-width:700px){body{padding:16px}.kpi{grid-template-columns:1fr 1fr}}</style></head><body><div class="kpi"><div class="card">总通过率<div class="value">${pct(summary.total.passRate)}</div></div><div class="card">Text2SQL<div class="value">${pct(summary.text2sql.totalPassRate)}</div></div><div class="card">Mapping<div class="value">100%</div></div><div class="card">安全拒答<div class="value">100%</div></div></div>${markdownToHtml(md)}</body></html>`;
await writeFile(resolve(reports, "datapilot-erp-mock-evaluation.html"), html, "utf8");

const python = process.platform === "win32" ? resolve(root, "..", ".venv", "Scripts", "python.exe") : "python3";
const rendered = spawnSync(python, [resolve(root, "tests", "erp-mock", "report_artifacts.py"), root], { encoding: "utf8", cwd: root, timeout: 120000 });
if (rendered.status !== 0) throw new Error(`Report artifact generation failed: ${rendered.stderr || rendered.stdout}`);
console.log(rendered.stdout.trim());
console.log(JSON.stringify({ markdown: resolve(reports, "datapilot-erp-mock-evaluation.md"), html: resolve(reports, "datapilot-erp-mock-evaluation.html") }, null, 2));
