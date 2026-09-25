import json
import os
import sys
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib import font_manager
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Image, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

ROOT = Path(sys.argv[1]).resolve()
RESULTS = ROOT / "reports" / "results"
ASSETS = ROOT / "reports" / "assets"
PDF_PATH = ROOT / "reports" / "DataPilot_ERP_Mock测试报告.pdf"
ASSETS.mkdir(parents=True, exist_ok=True)

def read(name):
    return json.loads((RESULTS / name).read_text(encoding="utf-8"))

summary = read("evaluation-summary.json")
text2sql = read("text2sql-results.json")
bad = read("bad-cases.json")

font_path = Path("C:/Windows/Fonts/msyh.ttc")
if font_path.exists():
    font_manager.fontManager.addfont(str(font_path))
    plt.rcParams["font.family"] = font_manager.FontProperties(fname=str(font_path)).get_name()
plt.rcParams["axes.unicode_minus"] = False

BLUE = "#2367A5"
GREEN = "#2F855A"
RED = "#C53030"
GOLD = "#B7791F"
GRAY = "#718096"

def save_chart(name):
    plt.tight_layout()
    plt.savefig(ASSETS / name, dpi=180, bbox_inches="tight", facecolor="white")
    plt.close()

types = ["单元", "功能", "集成", "安全", "回归", "Text2SQL"]
counts = [summary["unit"]["total"], summary["functional"]["total"], summary["integration"]["total"], summary["security"]["total"], summary["regression"]["total"], summary["questionCount"]]
rates = [summary["unit"]["passRate"], summary["functional"]["passRate"], summary["integration"]["passRate"], summary["security"]["passRate"], summary["regression"]["passRate"], summary["text2sql"]["totalPassRate"]]

plt.figure(figsize=(8, 4)); bars = plt.bar(types, counts, color=BLUE)
plt.title("测试类型用例数量分布"); plt.ylabel("用例数"); plt.bar_label(bars); save_chart("test-type-counts.png")

plt.figure(figsize=(8, 4)); bars = plt.bar(types, [x * 100 for x in rates], color=[GREEN if x >= .95 else GOLD for x in rates])
plt.ylim(0, 105); plt.ylabel("通过率 (%)"); plt.title("各测试类型通过率"); plt.bar_label(bars, fmt="%.1f%%"); save_chart("test-type-pass-rates.png")

scenario_counts = {}
for item in text2sql["results"]: scenario_counts[item["test_type"]] = scenario_counts.get(item["test_type"], 0) + 1
plt.figure(figsize=(9, 5)); labels = list(scenario_counts); values = [scenario_counts[x] for x in labels]
bars = plt.barh(labels, values, color=BLUE); plt.xlabel("问题数"); plt.title("Text2SQL 测试场景分布"); plt.bar_label(bars); save_chart("scenario-distribution.png")

category_rates = {}
for item in text2sql["results"]:
    category_rates.setdefault(item["category"], []).append(1 if item["pass"] else 0)
plt.figure(figsize=(8, 4)); labels = list(category_rates); values = [sum(category_rates[x]) / len(category_rates[x]) * 100 for x in labels]
bars = plt.bar(labels, values, color=GREEN); plt.ylim(0, 105); plt.ylabel("准确率 (%)"); plt.title("各类问题准确率"); plt.xticks(rotation=25, ha="right"); plt.bar_label(bars, fmt="%.1f%%"); save_chart("question-category-accuracy.png")

mapping_labels = ["Entity", "Field", "Required fields", "Join validation"]
mapping_values = [summary["mapping"]["entityMappingAccuracy"], summary["mapping"]["fieldMappingAccuracy"], summary["mapping"]["requiredFieldCoverage"], summary["mapping"]["joinValidationAccuracy"]]
plt.figure(figsize=(8, 4)); bars = plt.bar(mapping_labels, [x * 100 for x in mapping_values], color=GREEN); plt.ylim(0, 105); plt.ylabel("Accuracy (%)"); plt.title("Mapping Accuracy"); plt.bar_label(bars, fmt="%.1f%%"); save_chart("mapping-accuracy.png")

plt.figure(figsize=(7, 4)); join_values = [summary["mapping"]["joinCandidatePrecision"], summary["mapping"]["validatedJoinPrecision"], summary["text2sql"]["joinAccuracy"]]
bars = plt.bar(["Candidate precision", "Validated precision", "Text2SQL join"], [x * 100 for x in join_values], color=[BLUE, GREEN, GOLD]); plt.ylim(0, 105); plt.ylabel("Accuracy (%)"); plt.title("Join Validation Accuracy"); plt.bar_label(bars, fmt="%.1f%%"); save_chart("join-validation-accuracy.png")

plt.figure(figsize=(5, 5)); plt.pie([summary["total"]["passed"], summary["total"]["failed"]], labels=["通过", "失败"], autopct="%1.1f%%", colors=[GREEN, RED], startangle=90); plt.title("自动化验收成功 / 失败占比"); save_chart("success-failure-share.png")

bad_labels = [x["classification"] for x in bad["categories"]] or ["No current bad case"]
bad_values = [x["count"] for x in bad["categories"]] or [0]
plt.figure(figsize=(7, 4)); bars = plt.barh(bad_labels, bad_values, color=RED); plt.xlabel("数量"); plt.title("Bad Case 分类"); plt.bar_label(bars); save_chart("bad-case-categories.png")

stages = ["Schema Search", "Mapping Validation", "SQL Generation", "SQL Execution", "End-to-End"]
perf_keys = ["schemaSearch", "mappingValidation", "sqlGeneration", "sqlExecution", "endToEnd"]
x = range(len(stages)); width = .24
plt.figure(figsize=(10, 5))
for offset, key, color in [(-width, "p50", BLUE), (0, "p95", GOLD), (width, "p99", RED)]:
    plt.bar([i + offset for i in x], [summary["performance"][stage][key] or 0 for stage in perf_keys], width, label=key.upper(), color=color)
plt.xticks(list(x), stages, rotation=20, ha="right"); plt.ylabel("ms"); plt.title("P50 / P95 / P99 延迟"); plt.legend(); save_chart("latency-percentiles.png")

metric_labels = ["Execution", "Result", "Numeric", "Table", "Join", "Metric", "Time", "Group By", "TopN", "Safety"]
metric_keys = ["sqlExecutionSuccessRate", "resultAccuracy", "exactNumericAccuracy", "tableAccuracy", "joinAccuracy", "metricAccuracy", "timeFilterAccuracy", "groupByAccuracy", "topNAccuracy", "safetyRejectionAccuracy"]
plt.figure(figsize=(10, 5)); values = [summary["text2sql"][key] * 100 for key in metric_keys]
bars = plt.bar(metric_labels, values, color=[GREEN if value >= 95 else GOLD for value in values]); plt.ylim(0, 105); plt.ylabel("Accuracy (%)"); plt.title("指标正确率对比"); plt.xticks(rotation=25, ha="right"); plt.bar_label(bars, fmt="%.1f%%", fontsize=8); save_chart("metric-accuracy-comparison.png")

# PDF
font_name = "Helvetica"
if font_path.exists():
    pdfmetrics.registerFont(TTFont("MicrosoftYaHei", str(font_path)))
    font_name = "MicrosoftYaHei"
styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="CNTitle", parent=styles["Title"], fontName=font_name, fontSize=22, leading=30, alignment=TA_CENTER, textColor=colors.HexColor("#17365D")))
styles.add(ParagraphStyle(name="CNH1", parent=styles["Heading1"], fontName=font_name, fontSize=15, leading=21, textColor=colors.HexColor("#17365D"), spaceBefore=8, spaceAfter=6))
styles.add(ParagraphStyle(name="CNBody", parent=styles["BodyText"], fontName=font_name, fontSize=9.5, leading=15))
styles.add(ParagraphStyle(name="CNSmall", parent=styles["BodyText"], fontName=font_name, fontSize=8, leading=12))

doc = SimpleDocTemplate(str(PDF_PATH), pagesize=A4, rightMargin=16*mm, leftMargin=16*mm, topMargin=16*mm, bottomMargin=16*mm, title="DataPilot ERP Mock 测试报告")
story = [Paragraph("DataPilot ERP Mock 测试与量化验收报告", styles["CNTitle"]), Spacer(1, 8), Paragraph("测试日期：2026-09-25　数据库：datapilot_mock　固定种子：20260925", styles["CNBody"]), Spacer(1, 12)]

def table(data, widths=None):
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([("FONTNAME", (0,0), (-1,-1), font_name), ("FONTSIZE", (0,0), (-1,-1), 8), ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#D9EAF7")), ("TEXTCOLOR", (0,0), (-1,0), colors.HexColor("#17365D")), ("GRID", (0,0), (-1,-1), .35, colors.HexColor("#A0AEC0")), ("VALIGN", (0,0), (-1,-1), "TOP"), ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.white, colors.HexColor("#F7FAFC")])]))
    return t

story += [Paragraph("1. 执行摘要", styles["CNH1"]), Paragraph(f"本轮共计 {summary['total']['cases']} 个自动化检查，{summary['total']['passed']} 个通过、{summary['total']['failed']} 个失败，总通过率 {summary['total']['passRate']*100:.2f}%。60 条 Text2SQL 标准问题通过率 {summary['text2sql']['totalPassRate']*100:.2f}%，结果准确率 {summary['text2sql']['resultAccuracy']*100:.2f}%，安全拒答准确率 {summary['text2sql']['safetyRejectionAccuracy']*100:.2f}%。", styles["CNBody"]), Spacer(1, 8), Image(str(ASSETS / "test-type-pass-rates.png"), width=170*mm, height=85*mm)]
story += [PageBreak(), Paragraph("2. Mock 数据规模", styles["CNH1"]), table([["表", "行数"]] + [[k, str(v)] for k,v in summary["rowCounts"].items()], [90*mm, 45*mm]), Spacer(1, 10), Image(str(ASSETS / "test-type-counts.png"), width=170*mm, height=85*mm)]
story += [PageBreak(), Paragraph("3. 测试类型结果", styles["CNH1"]), table([["类型", "总数", "通过", "失败", "通过率"]] + [[label, str(summary[key]["total"]), str(summary[key]["passed"]), str(summary[key]["failed"]), f"{summary[key]['passRate']*100:.2f}%"] for label,key in [("单元","unit"),("功能","functional"),("集成","integration"),("安全","security"),("回归","regression")]] + [["Text2SQL", "60", str(sum(1 for x in text2sql["results"] if x["pass"])), str(sum(1 for x in text2sql["results"] if not x["pass"])), f"{summary['text2sql']['totalPassRate']*100:.2f}%"]]), Spacer(1, 10), Image(str(ASSETS / "success-failure-share.png"), width=100*mm, height=100*mm)]
story += [PageBreak(), Paragraph("4. Mapping 与 Join", styles["CNH1"]), Paragraph(f"Entity Mapping {summary['mapping']['entityHits']}/{summary['mapping']['entityTotal']}；Field Mapping {summary['mapping']['fieldHits']}/{summary['mapping']['fieldTotal']}；Required Field {summary['mapping']['requiredHits']}/{summary['mapping']['requiredTotal']}；Validated Join {summary['mapping']['validatedJoinHits']}/{summary['mapping']['validatedJoinTotal']}。", styles["CNBody"]), Image(str(ASSETS / "mapping-accuracy.png"), width=170*mm, height=85*mm), Image(str(ASSETS / "join-validation-accuracy.png"), width=170*mm, height=85*mm)]
story += [PageBreak(), Paragraph("5. Text2SQL 准确率", styles["CNH1"]), Image(str(ASSETS / "metric-accuracy-comparison.png"), width=175*mm, height=88*mm), Image(str(ASSETS / "question-category-accuracy.png"), width=170*mm, height=85*mm)]
story += [PageBreak(), Paragraph("6. 基础性能", styles["CNH1"]), Paragraph("本轮为单机基础性能测试，不是 100/500 并发用户级正式压力测试。", styles["CNBody"]), Image(str(ASSETS / "latency-percentiles.png"), width=175*mm, height=88*mm), table([["阶段","Average","P50","P95","P99","Max"]] + [[label] + [str(summary["performance"][key][field]) for field in ["average","p50","p95","p99","max"]] for label,key in zip(stages, perf_keys)])]
story += [PageBreak(), Paragraph("7. Bad Case 与能力边界", styles["CNH1"]), Image(str(ASSETS / "bad-case-categories.png"), width=155*mm, height=80*mm)]
for item in bad["items"]:
    story += [Paragraph(f"{item['id']} - {item['classification']}", styles["CNBody"]), Paragraph(f"现象：{item.get('question', item['id'])}；原因：{item['reason']}；影响：{item['impact']}；建议：{item['recommendation']}。", styles["CNSmall"]), Spacer(1, 5)]
story += [Paragraph("结论", styles["CNH1"]), Paragraph("当前版本具备 Demo 级能力，并达到有条件 POC 水平；尚不具备 Production Readiness。生产化前必须清理现有渲染回归债务、固化状态/币种/会计期间租户配置、扩大真实 ERP 题集与跨租户鉴权验证，并开展并发、容量、灾备和审计测试。", styles["CNBody"])]

def footer(canvas, document):
    canvas.saveState(); canvas.setFont(font_name, 8); canvas.setFillColor(colors.HexColor("#718096")); canvas.drawString(16*mm, 9*mm, "DataPilot ERP Mock Evaluation"); canvas.drawRightString(A4[0]-16*mm, 9*mm, f"Page {document.page}"); canvas.restoreState()

doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(json.dumps({"charts": 10, "pdf": str(PDF_PATH)}, ensure_ascii=False))
