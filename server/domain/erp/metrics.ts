export type FinanceMetric = { id: string; name: string; description: string; formula: string; keywords: string[]; timeFieldHints: string[] };

export const financeMetrics: FinanceMetric[] = [
  { id: "revenue", name: "收入", description: "主营及其他经营收入", formula: "贷方收入发生额或收入类科目净额", keywords: ["收入", "营收", "销售额", "营业收入"], timeFieldHints: ["voucher_date", "posting_date", "biz_date"] },
  { id: "expense", name: "费用", description: "期间费用与经营支出", formula: "费用类科目借方发生额", keywords: ["费用", "支出", "成本", "期间费用"], timeFieldHints: ["voucher_date", "posting_date", "biz_date"] },
  { id: "receivable", name: "应收", description: "客户尚未支付的款项", formula: "应收账款期末借方余额", keywords: ["应收", "客户欠款", "回款"], timeFieldHints: ["due_date", "posting_date"] },
  { id: "payable", name: "应付", description: "企业尚未支付供应商的款项", formula: "应付账款期末贷方余额", keywords: ["应付", "供应商欠款", "付款"], timeFieldHints: ["due_date", "posting_date"] },
  { id: "profit", name: "利润", description: "收入扣除成本费用后的经营成果", formula: "收入 - 成本 - 费用", keywords: ["利润", "盈利", "亏损", "毛利", "净利润"], timeFieldHints: ["voucher_date", "posting_date"] },
  { id: "yoy", name: "同比", description: "与上年同期比较", formula: "(本期值-上年同期值)/上年同期值", keywords: ["同比", "去年同期", "上年同期"], timeFieldHints: ["voucher_date", "posting_date"] },
  { id: "mom", name: "环比", description: "与上一相邻期间比较", formula: "(本期值-上期值)/上期值", keywords: ["环比", "上月", "上季度"], timeFieldHints: ["voucher_date", "posting_date"] },
];

export function searchMetrics(question: string) {
  const matched = financeMetrics.filter((metric) => metric.keywords.some((keyword) => question.includes(keyword)));
  return matched.length ? matched : financeMetrics.slice(0, 5);
}
