import { chromium } from "@playwright/test";
import type { FullConfig, FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DIALOGUE_MODEL } from "../../server/modules/agent/presets/phone-support/dialogue-understanding.js";

type Row = {
  id: string;
  title: string;
  category: string;
  priority: string;
  status: "PASS" | "FAIL" | "BLOCKED" | "SKIPPED";
  durationMs: number;
  data?: Record<string, unknown>;
  error?: string;
  screenshot?: string;
};

export default class PhoneDialogueReporter implements Reporter {
  private rows: Row[] = [];
  private startedAt = new Date();
  private config?: FullConfig;

  onBegin(config: FullConfig) { this.config = config; }

  async onTestEnd(test: TestCase, result: TestResult) {
    const jsonAttachment = result.attachments.find((item) => item.name.endsWith(".json") && item.path);
    const screenshot = result.attachments.find((item) => item.contentType === "image/png");
    let data: Record<string, unknown> | undefined;
    if (jsonAttachment?.path) {
      try { data = JSON.parse(await readFile(jsonAttachment.path, "utf8")) as Record<string, unknown>; } catch { /* keep test result */ }
    }
    let image: string | undefined;
    if (screenshot?.body) image = `data:image/png;base64,${screenshot.body.toString("base64")}`;
    else if (screenshot?.path) {
      try { image = `data:image/png;base64,${(await readFile(screenshot.path)).toString("base64")}`; } catch { /* optional */ }
    }
    const blocked = test.annotations.some((item) => item.type === "blocked") || result.annotations.some((item) => item.type === "blocked");
    const status = blocked ? "BLOCKED" : result.status === "passed" ? "PASS" : result.status === "skipped" ? "SKIPPED" : "FAIL";
    const id = String(data?.id || data?.tcId || test.title.match(/^(?:TC-PHONE|DU)-\d+/)?.[0] || test.id);
    this.rows.push({
      id,
      title: test.title,
      category: String(data?.category || (id.startsWith("TC-PHONE") ? "第一阶段回归" : "未分类")),
      priority: String(data?.priority || (id.startsWith("TC-PHONE") ? "P0" : "-")),
      status,
      durationMs: result.duration,
      data,
      error: result.errors.map((item) => item.message).filter(Boolean).join("\n").slice(0, 2000) || undefined,
      screenshot: image,
    });
  }

  async onEnd(result: FullResult) {
    void result;
    const outputDir = resolve("reports", "tests", "e2e");
    await mkdir(outputDir, { recursive: true });
    const timestamp = formatReportTimestamp(this.startedAt);
    const htmlPath = resolve(outputDir, `phone-dialogue-e2e-${timestamp}.html`);
    const pdfPath = resolve(outputDir, `phone-dialogue-e2e-${timestamp}.pdf`);
    const html = renderReport(this.rows, this.startedAt, new Date(), this.config);
    await writeFile(htmlPath, html, "utf8");
    const browser = await chromium.launch({ channel: "msedge", headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`file:///${htmlPath.replace(/\\/g, "/")}`, { waitUntil: "load" });
      await page.emulateMedia({ media: "print" });
      await page.pdf({ path: pdfPath, format: "A4", printBackground: true, margin: { top: "12mm", right: "10mm", bottom: "14mm", left: "10mm" } });
    } finally { await browser.close(); }
  }
}

function formatReportTimestamp(value: Date) {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}${pad(value.getMonth() + 1)}${pad(value.getDate())}-${pad(value.getHours())}${pad(value.getMinutes())}`;
}

function renderReport(rows: Row[], startedAt: Date, endedAt: Date, config?: FullConfig) {
  const pass = rows.filter((item) => item.status === "PASS").length;
  const fail = rows.filter((item) => item.status === "FAIL").length;
  const blocked = rows.filter((item) => item.status === "BLOCKED").length;
  const skipped = rows.filter((item) => item.status === "SKIPPED").length;
  const executable = Math.max(1, rows.length - blocked - skipped);
  const rate = `${((pass / executable) * 100).toFixed(1)}%`;
  const metrics = collectMetrics(rows);
  const browserMode = String(config?.projects[0]?.use?.headless ?? "configured");
  const commit = git(["rev-parse", "--short", "HEAD"]);
  const dirty = git(["status", "--porcelain"]) ? " + working tree changes" : "";
  const detail = rows.map((row) => renderCase(row)).join("\n");
  const badCases = rows.filter((item) => item.status === "FAIL" || item.status === "BLOCKED").map((item) => {
    const reason = item.status === "BLOCKED" ? `${DIALOGUE_MODEL} 调用故障，未将规则降级结果冒充为模型理解结果` : conciseError(item.error);
    const suggestion = item.status === "BLOCKED" ? "为当前 API 账户充值或恢复额度后原样复测；禁止切换模型。" : "根据实际结构化输出修复 DialogueUnderstanding，不修改预期标准。";
    return `<tr><td>${h(item.id)}</td><td>${badge(item.status)}</td><td>${h(reason)}</td><td>${h(suggestion)}</td></tr>`;
  }).join("") || '<tr><td colspan="4">无 Bad Case</td></tr>';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Phone Dialogue Understanding E2E Report</title><style>
  :root{color-scheme:light;font-family:"Microsoft YaHei","Noto Sans CJK SC",Arial,sans-serif;color:#172033;background:#f4f7fb}*{box-sizing:border-box}body{margin:0}.page{max-width:1180px;margin:0 auto;padding:32px}.hero{background:linear-gradient(135deg,#172554,#1d4ed8);color:#fff;border-radius:18px;padding:30px}.hero h1{margin:0 0 8px;font-size:30px}.hero p{margin:5px 0;color:#dbeafe}.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin:20px 0}.metric{background:#fff;border:1px solid #dfe7f3;border-radius:12px;padding:16px}.metric strong{display:block;font-size:27px}.metric span{color:#64748b;font-size:13px}.card{background:#fff;border:1px solid #dfe7f3;border-radius:14px;padding:20px;margin:16px 0;break-inside:avoid}.card h2{margin:0 0 14px;font-size:20px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{border-bottom:1px solid #e5eaf2;padding:9px;text-align:left;vertical-align:top}th{background:#f8fafc;color:#475569}.badge{display:inline-block;border-radius:999px;padding:3px 9px;font-weight:700;font-size:11px}.PASS{background:#dcfce7;color:#166534}.FAIL{background:#fee2e2;color:#991b1b}.BLOCKED{background:#fef3c7;color:#92400e}.SKIPPED{background:#e2e8f0;color:#475569}details{margin:12px 0;border-top:1px solid #e5eaf2;padding-top:12px}summary{cursor:pointer;font-weight:700}pre{white-space:pre-wrap;word-break:break-word;background:#0f172a;color:#e2e8f0;border-radius:9px;padding:12px;max-height:440px;overflow:auto;font-size:11px}.shot{max-width:100%;border:1px solid #cbd5e1;border-radius:8px;margin-top:10px}.muted{color:#64748b}.break{break-before:page}@media print{body{background:#fff}.page{max-width:none;padding:0}.card,.hero{box-shadow:none}details{display:block}details>summary{list-style:none}.shot{max-height:155mm;object-fit:contain}pre{max-height:none}.page-break{break-before:page}}
  </style></head><body><main class="page"><section class="hero"><h1>电话客服对话理解 - 第二阶段 E2E 报告</h1><p>真实 Web / API / Session / Context / RAG · Microsoft Edge · 无业务接口 Mock</p><p>模型固定：${h(DIALOGUE_MODEL)}（禁止静默切换）</p></section>
  <section class="grid"><div class="metric"><strong>${rows.length}</strong><span>总用例</span></div><div class="metric"><strong>${pass}</strong><span>通过</span></div><div class="metric"><strong>${fail}</strong><span>失败</span></div><div class="metric"><strong>${blocked}</strong><span>BLOCKED</span></div><div class="metric"><strong>${rate}</strong><span>可执行通过率</span></div></section>
  <section class="card"><h2>测试环境与代码版本</h2><table><tbody><tr><th>Web / API</th><td>http://localhost:3000 / http://localhost:3001</td><th>浏览器</th><td>Microsoft Edge, channel=msedge, headless=${h(browserMode)}</td></tr><tr><th>代码版本</th><td>${h(commit + dirty)}</td><th>执行时间</th><td>${h(startedAt.toISOString())} - ${h(endedAt.toISOString())}</td></tr><tr><th>LLM</th><td>${h(DIALOGUE_MODEL)}</td><th>Playwright workers</th><td>${h(String(config?.workers || 1))}</td></tr><tr><th>平均模型耗时</th><td>${metrics.averageLatencyMs.toFixed(1)} ms</td><th>LLM 调用 / Token</th><td>${metrics.calls} 次 / ${metrics.totalTokens === null ? "供应商未返回" : metrics.totalTokens}</td></tr></tbody></table><p class="muted">通过率分母排除 BLOCKED/SKIPPED；模型故障不会归为业务缺陷，也不会伪造 PASS。</p></section>
  <section class="card"><h2>测试结论汇总</h2><table><thead><tr><th>测试用例编号</th><th>场景</th><th>结论</th></tr></thead><tbody>${rows.map((item) => `<tr><td>${h(item.id)}</td><td>${h(item.title)}</td><td>${badge(item.status)} ${h(caseConclusion(item))}</td></tr>`).join("")}</tbody></table></section>
  <section class="card page-break"><h2>失败与阻塞说明</h2><table><thead><tr><th>测试用例编号</th><th>状态</th><th>原因</th><th>建议</th></tr></thead><tbody>${badCases}</tbody></table></section>
  <section class="page-break"><h2>逐用例完整对话截图与结论</h2>${detail}</section></main></body></html>`;
}

function renderCase(row: Row) {
  const screenshot = row.screenshot
    ? `<img class="shot" src="${row.screenshot}" alt="${h(row.id)} 完整对话截图">`
    : '<p class="muted">未生成对话截图。</p>';
  return `<article class="card"><h3>测试用例编号：${h(row.id)}</h3><p><strong>场景：</strong>${h(row.title)}</p><h4>完整对话截图</h4>${screenshot}<p><strong>结论：</strong>${badge(row.status)} ${h(caseConclusion(row))}</p></article>`;
}

function caseConclusion(row: Row) {
  if (row.status === "PASS") return "实际对话理解结果与预期一致。";
  if (row.status === "BLOCKED") return `${DIALOGUE_MODEL} 模型调用异常，本用例未形成有效业务结论。`;
  if (row.status === "SKIPPED") return "用例未执行，不计入可执行通过率。";
  return `测试失败：${conciseError(row.error)}`;
}

function conciseError(value?: string) {
  const plain = stripAnsi(value || "").replace(/\r/g, "");
  const expected = plain.match(/Expected:\s*(?:"([^"]+)"|(null|true|false))/)?.slice(1).find(Boolean);
  const received = plain.match(/Received:\s*(?:"([^"]+)"|(null|true|false))/)?.slice(1).find(Boolean);
  if (expected !== undefined && received !== undefined) return `预期 ${expected}，实际 ${received}。`;
  return plain.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("Error:")) || "实际结果与预期不一致。";
}

function stripAnsi(value: string) {
  return value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "");
}

function collectMetrics(rows: Row[]) {
  let calls = 0; let latency = 0; let totalTokens = 0; let hasTokens = false;
  for (const row of rows) {
    const turns = Array.isArray(row.data?.turns) ? row.data?.turns as Record<string, unknown>[] : [];
    for (const turn of turns) {
      const model = turn.model as Record<string, unknown> | undefined;
      if (!model || (model.source !== "llm" && model.source !== "safe_fallback")) continue;
      calls += 1;
      const trace = Array.isArray(turn.trace) ? turn.trace as { step?: string; durationMs?: number }[] : [];
      latency += Number(trace.find((item) => item.step === "dialogue.understand")?.durationMs || 0);
      const usage = model.usage as { totalTokens?: number } | undefined;
      if (Number.isFinite(usage?.totalTokens)) { totalTokens += Number(usage?.totalTokens); hasTokens = true; }
    }
  }
  return { calls, averageLatencyMs: calls ? latency / calls : 0, totalTokens: hasTokens ? totalTokens : null };
}
function git(args: string[]) { try { return execFileSync("git", args, { encoding: "utf8" }).trim(); } catch { return "unknown"; } }
function badge(status: Row["status"]) { return `<span class="badge ${status}">${status}</span>`; }
function h(value: unknown) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!)); }
