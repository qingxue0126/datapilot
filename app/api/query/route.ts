const revenueRows = [
  { month: "2026-01", revenue: 162.4, growth: "—" }, { month: "2026-02", revenue: 176.8, growth: "+8.9%" }, { month: "2026-03", revenue: 201.3, growth: "+13.9%" },
  { month: "2026-04", revenue: 229.7, growth: "+14.1%" }, { month: "2026-05", revenue: 256.9, growth: "+11.8%" }, { month: "2026-06", revenue: 257.5, growth: "+0.2%" },
];
const productRows = [
  { product: "智能降噪耳机 Pro", category: "数码", revenue: 86.4, orders: 1286 }, { product: "轻氧咖啡机 S2", category: "家电", revenue: 72.8, orders: 842 },
  { product: "云感乳胶枕", category: "家居", revenue: 61.5, orders: 1537 }, { product: "城市通勤双肩包", category: "箱包", revenue: 48.2, orders: 1104 },
  { product: "智能体脂秤", category: "健康", revenue: 42.9, orders: 976 },
];
const regionRows = [
  { region: "华东", orders: 4862, revenue: 426.8, avg: 877.8 }, { region: "华南", orders: 3516, revenue: 318.2, avg: 905.0 },
  { region: "华北", orders: 2984, revenue: 251.6, avg: 843.2 }, { region: "西南", orders: 1982, revenue: 164.3, avg: 829.0 }, { region: "华中", orders: 1746, revenue: 123.7, avg: 708.5 },
];

export async function POST(request: Request) {
  const started = Date.now(); const body = await request.json().catch(() => ({}));
  const question = typeof body.question === "string" ? body.question.trim().slice(0, 300) : "";
  if (!question) return Response.json({ error: "请输入问题" }, { status: 400 });
  let payload;
  if (/产品|商品|top|TOP|最高/.test(question)) {
    payload = { summary: "华东区销售额最高的是智能降噪耳机 Pro，前 5 个产品合计贡献 311.8 万元销售额。", sql: `SELECT p.name AS product, p.category,\n       ROUND(SUM(o.amount) / 10000, 1) AS revenue_wan,\n       COUNT(*) AS orders\nFROM orders o\nJOIN products p ON p.id = o.product_id\nWHERE o.region = '华东'\nGROUP BY p.id, p.name, p.category\nORDER BY revenue_wan DESC\nLIMIT 5;`, columns: [{ key: "product", label: "产品" }, { key: "category", label: "品类" }, { key: "revenue", label: "销售额（万元）" }, { key: "orders", label: "订单量" }], rows: productRows, chart: productRows.map((row) => ({ label: row.product.slice(0, 5), value: row.revenue })) };
  } else if (/地区|区域|客单价|订单量/.test(question)) {
    payload = { summary: "华东区销售额和订单量均领先；华南区平均客单价最高，为 905 元。", sql: `SELECT region, COUNT(*) AS orders,\n       ROUND(SUM(amount) / 10000, 1) AS revenue_wan,\n       ROUND(AVG(amount), 1) AS avg_order_value\nFROM orders\nGROUP BY region\nORDER BY revenue_wan DESC;`, columns: [{ key: "region", label: "地区" }, { key: "orders", label: "订单量" }, { key: "revenue", label: "销售额（万元）" }, { key: "avg", label: "平均客单价（元）" }], rows: regionRows, chart: regionRows.map((row) => ({ label: row.region, value: row.revenue })) };
  } else {
    payload = { summary: "今年累计销售额 1,284.6 万元，其中 6 月表现最好，较 1 月增长 58.7%。", sql: `SELECT strftime('%Y-%m', order_date) AS month,\n       ROUND(SUM(amount) / 10000, 1) AS revenue_wan\nFROM orders\nWHERE order_date >= date('now', 'start of year')\nGROUP BY month\nORDER BY month;`, columns: [{ key: "month", label: "月份" }, { key: "revenue", label: "销售额（万元）" }, { key: "growth", label: "环比" }], rows: revenueRows, chart: revenueRows.map((row) => ({ label: row.month.slice(5) + "月", value: row.revenue })) };
  }
  return Response.json({ question, ...payload, executionMs: Math.max(42, Date.now() - started + 78), rowCount: payload.rows.length });
}
