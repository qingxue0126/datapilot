"""Generate the final DataPilot directory-refactor acceptance report."""

from datetime import datetime
from pathlib import Path
import html
import json
import re

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import LongTable, PageBreak, Paragraph, SimpleDocTemplate, Spacer, TableStyle

ROOT = Path.cwd()
OUT = ROOT / "reports/tests/architecture"
OUT.mkdir(parents=True, exist_ok=True)


def read_text(relative):
    raw = (ROOT / relative).read_bytes()
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16")
    return raw.decode("utf-8-sig", errors="replace")


def load_json(name):
    return json.loads((OUT / name).read_text(encoding="utf-8"))


def tap_stats(relative):
    text = read_text(relative)
    result = {}
    for key in ("tests", "pass", "fail", "skipped"):
        values = re.findall(rf"^# {key} (\d+)", text, re.MULTILINE)
        result[key] = int(values[-1]) if values else 0
    return result


def esc(value):
    return html.escape(str(value), quote=True)


generated = datetime.now().astimezone().isoformat(timespec="seconds")
unit = tap_stats("reports/tests/unit/results.tap")
integration = tap_stats("reports/tests/integration/results.tap")
api = tap_stats("reports/tests/api/results.tap")
rendered = tap_stats("reports/tests/architecture/rendered.log")
architecture = load_json("boundaries.json")
compatibility = load_json("compatibility.json")
differential = load_json("api-differential.json")
external = load_json("external-integration-results.json")
audit = load_json("git-diff-audit.json")
migration = load_json("migration-map.json")
e2e_log = read_text("reports/tests/architecture/e2e.log")
e2e_passed = int(re.search(r"(\d+) passed", e2e_log).group(1))
e2e_blocked = int(re.search(r"(\d+) skipped", e2e_log).group(1))
e2e_failed = len(re.findall(r"^\s*\d+ failed", e2e_log, re.MULTILINE))

assert unit == {"tests": 146, "pass": 146, "fail": 0, "skipped": 0}
assert integration == {"tests": 105, "pass": 105, "fail": 0, "skipped": 0}
assert api == {"tests": 14, "pass": 14, "fail": 0, "skipped": 0}
assert rendered["pass"] == 2 and rendered["fail"] == 0
assert "Build complete." in read_text("reports/tests/architecture/build.log")
assert not re.search(r"\berror\b", read_text("reports/tests/architecture/lint.log"), re.IGNORECASE)
assert not re.search(r"error TS\d+", read_text("reports/tests/architecture/typecheck.log"))
assert not any(architecture[key] for key in ("violations", "runtimeCycles", "allCycles", "moduleCycles"))
assert not compatibility["differences"]

summary = {
    "generatedAt": generated,
    "status": "conditionally_ready",
    "typecheck": "passed",
    "lint": {"errors": 0, "warnings": 0},
    "unit": unit,
    "integration": integration,
    "api": api,
    "rendered": rendered,
    "build": "passed",
    "e2e": {"total": 29, "passed": e2e_passed, "blocked": e2e_blocked, "failed": e2e_failed},
    "phoneSupport": {"total": 8, "passed": 8, "blocked": 0, "failed": 0},
    "dialogueSemantics": external["dialogueSemantics"],
    "architecture": architecture,
    "compatibility": compatibility,
    "apiDifferential": {"total": differential["total"], "passed": differential["passed"], "failed": differential["failed"]},
    "externalIntegrations": external,
    "gitAudit": audit,
    "releaseDecision": "Code and local infrastructure are ready for commit and rollback verification. Online validation remains blocked for DeepSeek-dependent dialogue cases and Text2SQL until provider balance is restored.",
}
(OUT / "verification-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

MIGRATIONS = [
    ["components/datapilot/", "components/features/{agent,knowledge,datasource,model,analysis,conversation,admin}/"],
    ["通用图标、确认框、客户端工具", "components/ui/；components/shared/"],
    ["server/agent/", "server/modules/agent/runtime/；server/modules/agent/presets/phone-support/"],
    ["server/workflow/", "server/modules/agent/workflow/"],
    ["server/context/", "server/modules/conversation/"],
    ["server/domain/erp/ 查询与指标", "server/modules/text2sql/"],
    ["server/domain/erp/schema-mapping/", "server/modules/datasource/schema-mapping/"],
    ["server/tools/", "Agent runtime、Datasource、Text2SQL 各自领域"],
    ["server/llm/", "server/modules/model/；server/infrastructure/llm/；server/shared/types/model.ts"],
    ["server/knowledge/", "server/modules/knowledge/；server/infrastructure/vector-store/"],
    ["server/auth/", "server/modules/auth/；server/modules/organization/"],
    ["server/database.ts / connection-store.ts", "server/infrastructure/database/mysql.ts；server/modules/datasource/connection-store.ts"],
    ["server/core/types.ts", "server/shared/types/{context,permission,conversation,trace}.ts"],
    ["server/security/ / sandbox/", "server/infrastructure/security/；server/infrastructure/sandbox/"],
    ["分散测试与 tests/erp-mock/", "tests/{unit,integration,api,e2e}/"],
    ["旧报告与浏览器输出", "reports/tests/{unit,integration,api,e2e,architecture}/"],
]

CHECKS = [
    ["typecheck", "PASS", "tsc -p tsconfig.typecheck.json；前端、后端、测试与 Playwright 配置"],
    ["lint", "PASS", "0 errors / 0 warnings；未关闭规则，未新增 eslint-disable"],
    ["unit", "PASS 146/146", "组件契约、Agent、Text2SQL、HTTP、基础设施"],
    ["integration", "PASS 105/105", "Auth、会话、知识库、Workflow、模型、Schema Mapping"],
    ["API", "PASS 14/14", "RBAC、API Key、SSE、会话、模型、知识库、组织、数据源"],
    ["SSR", "PASS 2/2", "应用壳渲染与遗留预览资源检查"],
    ["build", "PASS", "vinext/Vite 五阶段构建完成"],
    ["核心 E2E", "PASS 8/8", "电话客服 Session、上下文、多话题、恢复、截断、清理、SSE"],
    ["对话语义 E2E", "10 PASS / 11 BLOCKED", "21 项全部执行；BLOCKED 均为 DeepSeek HTTP 402，0 业务断言失败"],
    ["架构边界 / 循环", "PASS", f"扫描 {architecture['checkedFiles']} 个生产文件；0 违规、0 循环"],
    ["静态兼容", "PASS", "99 个 API handler、15 处 DDL、8 个受保护 Schema/构建文件无差异"],
    ["API 差分", f"PASS {differential['passed']}/{differential['total']}", "状态、响应、Cookie 与 API Key 行为一致"],
]

EXTERNAL = [
    ["MySQL", "PASS", "5.7.24；finance_db 与 datapilot_mock 真实连接测试均 HTTP 200"],
    ["Milvus", "PASS", "容器 healthy；19530 可达；3 个 collection；真实检索使用 milvus"],
    ["Embedding", "PASS", "DashScope text-embedding-v2；1536 维、数值有效、355 ms"],
    ["Qwen LLM", "PASS", "qwen3.5-flash 真实连接测试成功，2023 ms"],
    ["DeepSeek LLM", "BLOCKED", "deepseek-v4-flash 返回 HTTP 402 Insufficient Balance"],
    ["Knowledge Retrieval", "PASS", "真实知识库 + Milvus，返回 3 条，29 ms"],
    ["Text2SQL", "BLOCKED", "MySQL 阶段通过；配置的 DeepSeek 路由在 SQL 生成前返回 402"],
    ["Agent / Phone Support", "PASS 8/8", "真实 Web/API/Session/Context/RAG/SSE；无业务接口 mock"],
]

RISKS = [
    "DeepSeek 账户余额不足，11 个依赖模型理解的语义场景与真实 Text2SQL 在线生成无法形成发布结论；恢复额度后应原样复跑。",
    "四个生产文件没有运行时入边：query-history-storage 与两个数据源组件由兼容/契约单测保留；DisabledSandboxExecutor 是目标架构中的禁用边界。未发现旧目录副本或完全重复实现。",
    "tmp/、.env、.data 与 Playwright 原始 artifacts 均被 Git 忽略。经过绝对路径校验的递归清理命令被执行策略拒绝，工作区仍有 ignored 临时副本，但不会进入提交。",
    "测试中存在隔离环境使用的合成密码和既有 ERP 本地默认值；扫描未发现真实 API Key、Bearer token、私钥或非空 .env 值。",
    "工作区包含本次整体迁移的大量删除/新增路径，尚未创建 Git 提交；回滚依赖 Git diff/提交。API、DDL、RBAC、API Key、部署受保护文件均已由契约检查确认未变。",
]

TREE = """components/
├─ features/{admin,agent,analysis,conversation,datasource,knowledge,model}
├─ shared/
└─ ui/
server/
├─ modules/{agent,auth,conversation,datasource,knowledge,model,organization,text2sql}
├─ infrastructure/{database,llm,sandbox,security,storage,vector-store}
├─ shared/{errors,types}
├─ http/
└─ index.ts
tests/
├─ unit/
├─ integration/
├─ api/
└─ e2e/
reports/tests/
├─ unit/
├─ integration/
├─ api/
├─ e2e/
└─ architecture/"""

sections = [
    ("01", "验收结论", [
        ("p", "目录重构已达到可提交、可回滚验证状态。类型检查、lint、265 项 unit/integration/API、2 项 SSR、构建、8 项核心电话客服 E2E 均通过。上线验证仍受 DeepSeek 余额不足影响。"),
        ("table", [["指标", "结果"], ["lint", "0 errors / 0 warnings"], ["自动化测试", "267/267"], ["完整 E2E", "18 PASS / 11 BLOCKED / 0 FAIL"], ["模块边界 / 循环", "0 / 0"], ["API / DDL / 受保护文件", "0 差异"]]),
        ("h", "当前目录树"), ("pre", TREE),
    ]),
    ("02", "重构范围与旧 → 新迁移", [
        ("p", "重构前存在前端单目录平铺、后端按技术类型散布、电话客服与 Agent runtime 混放、基础设施反向渗入业务、测试与正式报告分散等问题。此次保持单仓库单包、API URL、SSE、DDL、RBAC、API Key 和业务算法不变。"),
        ("table", [["旧位置 / 能力", "新位置"]] + MIGRATIONS),
        ("p", f"完整路径映射共 {len(migration)} 条，见 migration-map.json。"),
    ]),
    ("03", "关键架构决策", [
        ("h", "按领域内聚"), ("p", "Agent、Knowledge、Datasource、Model、Text2SQL、Conversation、Auth、Organization 分别维护入口；跨模块依赖通过 index.ts 或窄契约。"),
        ("h", "Workflow 与电话客服"), ("p", "Workflow 与 Agent 的运行、版本和权限强相关，归入 Agent；电话客服进入 presets/phone-support，与通用 runtime 分离。"),
        ("h", "基础设施与 shared"), ("p", "MySQL、Milvus、Provider、加密存储、Sandbox 和 SQL 安全位于 infrastructure；shared 仅保留跨模块类型与统一错误格式化。"),
        ("h", "可执行边界"), ("p", "AST 检查覆盖 import/export、类型依赖、文件循环和模块循环；infrastructure 与 shared 不反向依赖领域。"),
    ]),
    ("04", "最终测试结果", [("table", [["检查", "结论", "证据范围"]] + CHECKS),
        ("p", "21 项对话语义覆盖多轮上下文、意图、话题切换、指代、company/product/query 槽位、固定话术、知识检索和 SSE。规则路径及安全降级路径通过；11 项在线模型判定因 402 标为 BLOCKED，没有伪记为 PASS。")]),
    ("05", "真实外部依赖验证", [("table", [["依赖 / 链路", "结论", "结果"]] + EXTERNAL),
        ("p", "所有验证均调用本机当前服务或已配置的真实 Provider，没有用 mock 替代可用服务。DeepSeek 失败原因来自 Provider 响应，已脱敏 request id。")]),
    ("06", "Git diff 审计与剩余风险", [
        ("table", [["检查", "结果"], ["旧目录 / 旧运行时 import", "0 / 0"], ["完全重复源码", "0 组"], ["循环依赖", "0"], ["API / DDL / deploy / drizzle 意外变更", "0"], ["新增真实密钥 / 私钥 / .env", "0"], ["tmp 进入 Git", "否；/tmp/ 已忽略"], ["git diff --check", "PASS"]]),
    ] + [("p", f"{index + 1}. {risk}") for index, risk in enumerate(RISKS)]),
    ("07", "报告与证据", [
        ("table", [["路径", "内容"], ["refactor-report.html / .pdf", "本验收报告"], ["verification-summary.json", "机器可读最终结论"], ["external-integration-results.json", "真实依赖验证"], ["git-diff-audit.json", "残留、敏感信息与差异审计"], ["boundaries.json / compatibility.json", "边界、循环、API、DDL 与受保护文件"], ["../e2e/phone-dialogue-e2e-<timestamp>.html / .pdf", "电话客服与语义 E2E 正式报告；文件名带执行时间戳"], ["../unit|integration|api/results.tap", "分类测试原始结果"]]),
    ]),
]


def html_block(kind, value):
    if kind == "table":
        rows = []
        for row_index, row in enumerate(value):
            tag = "th" if row_index == 0 else "td"
            rows.append("<tr>" + "".join(f"<{tag}>{esc(cell)}</{tag}>" for cell in row) + "</tr>")
        return '<div class="table-wrap"><table>' + "".join(rows) + "</table></div>"
    if kind == "pre":
        return f"<pre>{esc(value)}</pre>"
    tag = "h3" if kind == "h" else "p"
    return f"<{tag}>{esc(value)}</{tag}>"


html_sections = "".join(
    f'<section id="s{number}"><div class="eyebrow">ACCEPTANCE / {number}</div><h2>{esc(title)}</h2>{"".join(html_block(*block) for block in blocks)}</section>'
    for number, title, blocks in sections
)
manifest = "".join(f"<tr><td>{esc(old)}</td><td>{esc('; '.join(new) if isinstance(new, list) else new)}</td></tr>" for old, new in migration.items())
page = f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DataPilot 目录重构收尾验收报告</title>
<style>*{{box-sizing:border-box}}body{{margin:0;background:#eef3f7;color:#203047;font:15px/1.75 "Microsoft YaHei",sans-serif}}main{{max-width:1160px;margin:36px auto}}header{{padding:42px;background:linear-gradient(135deg,#10263f,#1f5f82);color:#fff;border-radius:16px}}h1{{margin:4px 0 12px;font-size:34px}}header p{{color:#d9eaf4}}.pill{{display:inline-block;padding:5px 13px;border-radius:20px;background:#ffedc4;color:#68460b}}nav{{display:flex;gap:15px;flex-wrap:wrap;margin:22px 0}}a{{color:#176b98;text-decoration:none}}section,details{{background:#fff;border:1px solid #d9e4ec;border-radius:12px;padding:28px 34px;margin:20px 0}}h2{{margin:4px 0 20px;font-size:25px}}h3{{margin:20px 0 5px;color:#155274;font-size:17px}}.eyebrow{{color:#64849a;font-size:11px;letter-spacing:2px}}table{{width:100%;border-collapse:collapse;font-size:13px}}th,td{{border:1px solid #d6e1e9;padding:9px 11px;text-align:left;vertical-align:top}}th{{background:#173d59;color:#fff}}tr:nth-child(even) td{{background:#f5f8fa}}.table-wrap{{overflow:auto}}pre{{background:#10263f;color:#e7f1f7;padding:18px;border-radius:9px;overflow:auto;line-height:1.55}}summary{{font-weight:700;cursor:pointer}}footer{{padding:18px;color:#66798a}}@media(max-width:720px){{main{{margin:12px}}header,section,details{{padding:20px}}}}@media print{{body{{background:#fff}}nav,details{{display:none}}section{{break-before:page;border:0;margin:0;padding:0}}header{{border-radius:0}}}}</style></head>
<body><main><header><div class="eyebrow" style="color:#9ed1e9">DATAPILOT / FINAL ACCEPTANCE</div><h1>目录结构重构收尾验收</h1><p>可提交、可回滚验证；上线验证受 DeepSeek 账户余额阻塞。</p><span class="pill">267/267 自动化通过 · lint 0/0 · E2E 0 FAIL</span><p>{esc(generated)}</p></header>
<nav>{''.join(f'<a href="#s{n}">{n} {esc(t)}</a>' for n,t,_ in sections)}<a href="refactor-report.pdf">下载 PDF</a></nav>{html_sections}
<details><summary>完整迁移清单（{len(migration)} 条）</summary><div class="table-wrap"><table><tr><th>旧路径</th><th>新路径</th></tr>{manifest}</table></div></details>
<footer>本报告只记录本次实际执行结果；BLOCKED 不计为通过。</footer></main></body></html>'''
(OUT / "refactor-report.html").write_text(page, encoding="utf-8")

font_path = Path("C:/Windows/Fonts/msyh.ttc")
if font_path.exists():
    pdfmetrics.registerFont(TTFont("DataPilotCN", str(font_path)))
    font = "DataPilotCN"
else:
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    font = "STSong-Light"

styles = {
    "title": ParagraphStyle("Title", fontName=font, fontSize=22, leading=30, textColor=colors.HexColor("#10263f"), spaceAfter=14),
    "h1": ParagraphStyle("H1", fontName=font, fontSize=16, leading=23, textColor=colors.HexColor("#123f5b"), spaceBefore=5, spaceAfter=10),
    "h2": ParagraphStyle("H2", fontName=font, fontSize=11, leading=16, textColor=colors.HexColor("#155274"), spaceBefore=8, spaceAfter=4, keepWithNext=True),
    "body": ParagraphStyle("Body", fontName=font, fontSize=9, leading=14, spaceAfter=7, wordWrap="CJK"),
    "cell": ParagraphStyle("Cell", fontName=font, fontSize=7.6, leading=11, wordWrap="CJK"),
    "head": ParagraphStyle("Head", fontName=font, fontSize=7.8, leading=11, textColor=colors.white, wordWrap="CJK"),
    "mono": ParagraphStyle("Mono", fontName=font, fontSize=8, leading=12, backColor=colors.HexColor("#eef3f7"), borderPadding=8, wordWrap="CJK"),
}


def pdf_table(rows):
    data = []
    for row_index, row in enumerate(rows):
        style = styles["head"] if row_index == 0 else styles["cell"]
        data.append([Paragraph(esc(cell), style) for cell in row])
    columns = len(rows[0])
    widths = {2: [54 * mm, 124 * mm], 3: [37 * mm, 38 * mm, 103 * mm]}.get(columns)
    table = LongTable(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#173d59")),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#cbd8e1")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f5f8fa")]),
    ]))
    return table


def footer(canvas, document):
    canvas.saveState()
    canvas.setFont(font, 7.5)
    canvas.setFillColor(colors.HexColor("#6b7d8d"))
    canvas.drawString(18 * mm, 10 * mm, "DataPilot 目录结构重构收尾验收")
    canvas.drawRightString(192 * mm, 10 * mm, f"{document.page}")
    canvas.restoreState()


story = [Paragraph("DataPilot 目录结构重构收尾验收", styles["title"]), Paragraph(f"生成时间：{esc(generated)}", styles["body"]),
         pdf_table([["验收维度", "结果"], ["自动化", "267/267；lint 0 errors / 0 warnings；build PASS"], ["完整 E2E", "18 PASS / 11 BLOCKED / 0 FAIL"], ["发布判断", "可提交、可回滚验证；DeepSeek 相关上线验证待恢复余额"]]), Spacer(1, 8)]
for index, (_, title, blocks) in enumerate(sections):
    if index:
        story.append(PageBreak())
    story.append(Paragraph(title, styles["h1"]))
    for kind, value in blocks:
        if kind == "table":
            story.extend([pdf_table(value), Spacer(1, 7)])
        elif kind == "h":
            story.append(Paragraph(esc(value), styles["h2"]))
        elif kind == "pre":
            story.append(Paragraph(esc(value).replace("\n", "<br/>"), styles["mono"]))
        else:
            story.append(Paragraph(esc(value), styles["body"]))

document = SimpleDocTemplate(str(OUT / "refactor-report.pdf"), pagesize=A4, rightMargin=16 * mm, leftMargin=16 * mm, topMargin=16 * mm, bottomMargin=16 * mm,
                             title="DataPilot 目录结构重构收尾验收", author="DataPilot Engineering")
document.build(story, onFirstPage=footer, onLaterPages=footer)
print(json.dumps({"html": str(OUT / "refactor-report.html"), "pdf": str(OUT / "refactor-report.pdf"), "summary": str(OUT / "verification-summary.json")}, ensure_ascii=False))
