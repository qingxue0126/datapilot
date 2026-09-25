export type RequiredField = {
  semantic: string;
  candidates: string[];
  required: boolean;
};

export type FinanceMetric = {
  id: string;
  name: string;
  aliases: string[];
  keywords: string[];
  description: string;
  businessDefinition: string;
  calculationRule: {
    metricType: "period_amount" | "balance" | "derived" | "comparison";
    expression: string;
    periodRule: string;
    aggregation: "sum" | "ending_balance" | "formula" | "ratio";
  };
  accountScope: {
    accountCategories: string[];
    accountCodePrefixes: string[];
    includeRule: string;
    excludeRule: string;
  };
  debitCreditDirection: {
    normalDirection: "debit" | "credit" | "mixed" | "not_applicable";
    amountRule: string;
  };
  timeFieldHints: string[];
  dimensions: string[];
  currencyRule: {
    defaultBasis: "functional_currency" | "original_currency" | "inherit_base_metric";
    rule: string;
    amountFieldHints: string[];
  };
  statusRule: {
    defaultStatus: "approved_only" | "posted_only" | "inherit_base_metric";
    rule: string;
    statusFieldHints: string[];
  };
  applicableErp: string[];
  requiredTables: string[];
  requiredFields: RequiredField[];
  sqlHints: string[];
};

/** Compact contract passed to the LLM after retrieval. Search-only aliases are omitted. */
export type FinanceMetricPrompt = Pick<FinanceMetric,
  "id" | "name" | "businessDefinition" | "calculationRule" | "accountScope" |
  "debitCreditDirection" | "timeFieldHints" | "dimensions" | "currencyRule" |
  "statusRule" | "requiredTables" | "requiredFields" | "sqlHints"
>;

const commonErp = ["用友", "金蝶", "SAP", "Oracle ERP", "通用总账"];
const periodTimeFields = ["voucher_date", "posting_date", "biz_date", "accounting_period", "fiscal_year", "fiscal_period"];
const balanceTimeFields = ["balance_date", "posting_date", "voucher_date", "fiscal_year", "fiscal_period"];
const organizationDimensions = ["账套", "公司", "法人组织", "核算组织", "部门", "会计期间"];
const approvedStatus = {
  defaultStatus: "approved_only" as const,
  rule: "默认只统计已审核且未作废的凭证；若系统区分过账状态，应优先使用已过账数据。只有用户明确要求时才包含未审核凭证。",
  statusFieldHints: ["audit_status", "approved", "voucher_status", "posting_status", "is_posted", "is_void"],
};
const functionalCurrency = {
  defaultBasis: "functional_currency" as const,
  rule: "默认按账套本位币统计；用户明确指定原币时，按币种分组并使用原币金额，不得混加不同币种。",
  amountFieldHints: ["debit", "credit", "debit_amount", "credit_amount", "local_amount", "base_amount", "original_amount", "currency_code"],
};
const ledgerFields: RequiredField[] = [
  { semantic: "科目编码或科目类别", candidates: ["account_code", "subject_code", "account_name", "subject_name", "account_category"], required: true },
  { semantic: "借方金额", candidates: ["debit", "debit_amount", "local_debit", "base_debit"], required: true },
  { semantic: "贷方金额", candidates: ["credit", "credit_amount", "local_credit", "base_credit"], required: true },
  { semantic: "记账日期或会计期间", candidates: periodTimeFields, required: true },
  { semantic: "审核或过账状态", candidates: approvedStatus.statusFieldHints, required: false },
];

export const financeMetrics: FinanceMetric[] = [
  {
    id: "operating_revenue",
    name: "营业收入",
    aliases: ["营收", "经营收入", "营业总收入", "销售收入", "收入"],
    keywords: ["销售额", "开票收入", "本期收入", "累计收入", "收入发生额"],
    description: "企业日常经营活动形成的收入总额。",
    businessDefinition: "按适用会计准则映射主营业务收入与其他业务收入科目，统计指定期间已审核/已过账凭证的本位币净发生额。",
    calculationRule: { metricType: "period_amount", expression: "营业收入 = 收入类科目贷方发生额 - 借方冲减发生额", periodRule: "默认取用户指定期间的本期发生额；用户要求累计时，从财年期初累计至截止期间。", aggregation: "sum" },
    accountScope: { accountCategories: ["主营业务收入", "其他业务收入"], accountCodePrefixes: ["6001", "6051"], includeRule: "优先使用 ERP 科目类别或客户科目映射；标准科目编码仅作为候选提示。", excludeRule: "排除营业外收入、投资收益、公允价值变动收益等非营业收入以及已作废凭证。" },
    debitCreditDirection: { normalDirection: "credit", amountRule: "收入正常方向为贷方，按 credit - debit 计算净发生额；红字或冲销按数据库实际借贷金额抵减。" },
    timeFieldHints: periodTimeFields,
    dimensions: [...organizationDimensions, "收入类别", "客户", "产品", "币种"],
    currencyRule: functionalCurrency,
    statusRule: approvedStatus,
    applicableErp: commonErp,
    requiredTables: ["总账凭证明细或业务收入明细", "会计科目/科目映射"],
    requiredFields: ledgerFields,
    sqlHints: ["优先按科目类别筛选，其次才使用科目编码前缀。", "禁止把借贷双方绝对值相加。", "期间累计与本期发生额必须按问题明确区分。"],
  },
  {
    id: "main_business_revenue",
    name: "主营业务收入",
    aliases: ["主营收入", "主业收入", "核心业务收入"],
    keywords: ["主营销售收入", "产品销售收入", "服务主营收入"],
    description: "企业主要经营活动形成的收入。",
    businessDefinition: "仅统计企业被定义为主营业务的收入科目，不包含其他业务收入、营业外收入和投资类收益。",
    calculationRule: { metricType: "period_amount", expression: "主营业务收入 = 主营业务收入科目贷方发生额 - 借方冲减发生额", periodRule: "默认统计指定会计期间本期发生额；累计口径需从财年期初累加。", aggregation: "sum" },
    accountScope: { accountCategories: ["主营业务收入"], accountCodePrefixes: ["6001"], includeRule: "以客户科目映射中的主营业务收入标识为准；6001 仅为中国企业会计准则常见候选。", excludeRule: "排除其他业务收入、营业外收入、投资收益以及税额。" },
    debitCreditDirection: { normalDirection: "credit", amountRule: "按 credit - debit 计算净发生额，借方发生额视为冲减或退回。" },
    timeFieldHints: periodTimeFields,
    dimensions: [...organizationDimensions, "客户", "产品", "主营业务类别", "币种"],
    currencyRule: functionalCurrency,
    statusRule: approvedStatus,
    applicableErp: commonErp,
    requiredTables: ["总账凭证明细或主营收入业务明细", "会计科目/科目映射"],
    requiredFields: ledgerFields,
    sqlHints: ["不得用全部收入类科目代替主营业务收入。", "若 Schema 无法识别主营科目映射，应返回口径信息不足。"],
  },
  {
    id: "cost",
    name: "成本",
    aliases: ["营业成本", "销售成本", "经营成本"],
    keywords: ["主营业务成本", "其他业务成本", "成本发生额", "产品成本"],
    description: "为取得营业收入而确认的营业成本，不包含期间费用。",
    businessDefinition: "统计与营业收入配比的主营业务成本和其他业务成本科目净发生额。",
    calculationRule: { metricType: "period_amount", expression: "营业成本 = 成本类科目借方发生额 - 贷方冲减发生额", periodRule: "默认取指定期间本期发生额；累计口径从财年期初累计。", aggregation: "sum" },
    accountScope: { accountCategories: ["主营业务成本", "其他业务成本"], accountCodePrefixes: ["6401", "6402"], includeRule: "使用已配置为营业成本的损益类科目。", excludeRule: "排除销售费用、管理费用、财务费用、资产成本余额及营业外支出。" },
    debitCreditDirection: { normalDirection: "debit", amountRule: "成本正常方向为借方，按 debit - credit 计算净发生额。" },
    timeFieldHints: periodTimeFields,
    dimensions: [...organizationDimensions, "成本类别", "产品", "项目", "币种"],
    currencyRule: functionalCurrency,
    statusRule: approvedStatus,
    applicableErp: commonErp,
    requiredTables: ["总账凭证明细或成本结转明细", "会计科目/科目映射"],
    requiredFields: ledgerFields,
    sqlHints: ["成本与期间费用必须分开。", "贷方结转或冲销应抵减借方发生额。"],
  },
  {
    id: "period_expense",
    name: "期间费用",
    aliases: ["三费", "期间成本", "经营费用", "费用"],
    keywords: ["销售费用", "管理费用", "财务费用", "费用合计", "本月费用", "费用发生额", "部门费用", "供应商费用"],
    description: "销售费用、管理费用和财务费用的合计。",
    businessDefinition: "统计指定期间销售费用、管理费用、财务费用科目的本位币净发生额，不计入营业成本。",
    calculationRule: { metricType: "period_amount", expression: "期间费用 = 销售费用净额 + 管理费用净额 + 财务费用净额", periodRule: "默认统计本期发生额；累计口径从财年期初累计。", aggregation: "sum" },
    accountScope: { accountCategories: ["销售费用", "管理费用", "财务费用"], accountCodePrefixes: ["6601", "6602", "6603"], includeRule: "以客户损益科目映射为准，常见中国会计科目编码作为候选。", excludeRule: "排除主营业务成本、其他业务成本、营业外支出和所得税费用。" },
    debitCreditDirection: { normalDirection: "debit", amountRule: "按各费用科目 debit - credit 计算净发生额；财务费用中的利息收入按实际贷方发生抵减。" },
    timeFieldHints: periodTimeFields,
    dimensions: [...organizationDimensions, "费用类别", "费用项目", "币种"],
    currencyRule: functionalCurrency,
    statusRule: approvedStatus,
    applicableErp: commonErp,
    requiredTables: ["总账凭证明细或费用明细", "会计科目/科目映射"],
    requiredFields: ledgerFields,
    sqlHints: ["至少能区分销售、管理、财务费用；否则返回口径信息不足。", "不要把成本科目合并为期间费用。"],
  },
  {
    id: "accounts_receivable",
    name: "应收账款",
    aliases: ["应收", "客户应收", "客户欠款", "应收余额"],
    keywords: ["尚未收款", "尚未收回", "未收款", "客户欠的钱", "应收款", "回款余额"],
    description: "企业因销售商品或提供服务形成的客户欠款。",
    businessDefinition: "按查询截止日统计应收账款科目的期末借方余额；客户辅助核算存在时应按客户汇总。",
    calculationRule: { metricType: "balance", expression: "期末应收账款 = 期初借方余额 + 本期借方发生额 - 本期贷方发生额", periodRule: "“当前”取最新已结账或最新过账日期余额；历史日期取截至该日的期末余额，不能只统计当期发生额。", aggregation: "ending_balance" },
    accountScope: { accountCategories: ["应收账款"], accountCodePrefixes: ["1122"], includeRule: "以应收账款总账科目及客户辅助核算为准。", excludeRule: "不自动合并应收票据、其他应收款、合同资产和预付款项。" },
    debitCreditDirection: { normalDirection: "debit", amountRule: "正常余额为借方；若客户明细出现贷方余额，不得擅自改为绝对值，应按原方向展示或单列。" },
    timeFieldHints: balanceTimeFields,
    dimensions: [...organizationDimensions, "客户", "账龄", "币种"],
    currencyRule: functionalCurrency,
    statusRule: approvedStatus,
    applicableErp: commonErp,
    requiredTables: ["科目余额或总账凭证明细", "会计科目/科目映射", "客户辅助核算（按客户查询时）"],
    requiredFields: [...ledgerFields, { semantic: "期初余额或可重建余额的历史发生额", candidates: ["opening_balance", "begin_balance", "debit", "credit"], required: true }, { semantic: "客户维度", candidates: ["customer_id", "customer_code", "customer_name"], required: false }],
    sqlHints: ["余额问题必须使用期初余额加发生额，或直接使用可信的期末余额表。", "不得用本期借方发生额冒充应收余额。"],
  },
  {
    id: "accounts_payable",
    name: "应付账款",
    aliases: ["应付", "供应商应付", "供应商欠款", "应付余额"],
    keywords: ["尚未付款", "未付款", "欠供应商的钱", "应付款", "付款余额"],
    description: "企业因采购商品或接受服务形成的供应商欠款。",
    businessDefinition: "按查询截止日统计应付账款科目的期末贷方余额；供应商辅助核算存在时应按供应商汇总。",
    calculationRule: { metricType: "balance", expression: "期末应付账款 = 期初贷方余额 + 本期贷方发生额 - 本期借方发生额", periodRule: "“当前”取最新已结账或最新过账日期余额；历史日期取截至该日的期末余额。", aggregation: "ending_balance" },
    accountScope: { accountCategories: ["应付账款"], accountCodePrefixes: ["2202"], includeRule: "以应付账款总账科目及供应商辅助核算为准。", excludeRule: "不自动合并应付票据、其他应付款、合同负债和预收款项。" },
    debitCreditDirection: { normalDirection: "credit", amountRule: "正常余额为贷方；供应商明细的借方余额不得取绝对值并混入贷方余额。" },
    timeFieldHints: balanceTimeFields,
    dimensions: [...organizationDimensions, "供应商", "账龄", "币种"],
    currencyRule: functionalCurrency,
    statusRule: approvedStatus,
    applicableErp: commonErp,
    requiredTables: ["科目余额或总账凭证明细", "会计科目/科目映射", "供应商辅助核算（按供应商查询时）"],
    requiredFields: [...ledgerFields, { semantic: "期初余额或可重建余额的历史发生额", candidates: ["opening_balance", "begin_balance", "debit", "credit"], required: true }, { semantic: "供应商维度", candidates: ["supplier_id", "vendor_code", "supplier_name"], required: false }],
    sqlHints: ["余额问题不能只聚合当期贷方发生额。", "借方余额应保留方向或单独披露。"],
  },
  {
    id: "gross_profit",
    name: "毛利",
    aliases: ["销售毛利", "经营毛利", "毛利润"],
    keywords: ["毛利额", "毛利率", "收入减成本"],
    description: "营业收入扣除与其配比的营业成本后的余额。",
    businessDefinition: "同一组织、账套、期间和币种口径下，以营业收入减营业成本计算毛利。",
    calculationRule: { metricType: "derived", expression: "毛利 = 营业收入 - 营业成本；毛利率 = 毛利 / 营业收入", periodRule: "收入与成本必须使用相同期间；累计毛利使用累计收入和累计成本。", aggregation: "formula" },
    accountScope: { accountCategories: ["营业收入", "营业成本"], accountCodePrefixes: ["6001", "6051", "6401", "6402"], includeRule: "继承营业收入和成本指标的科目范围。", excludeRule: "不扣除税金及附加、期间费用、营业外收支和所得税费用。" },
    debitCreditDirection: { normalDirection: "mixed", amountRule: "收入按 credit - debit，成本按 debit - credit，最后执行收入减成本。" },
    timeFieldHints: periodTimeFields,
    dimensions: [...organizationDimensions, "产品", "客户", "业务类别", "币种"],
    currencyRule: { ...functionalCurrency, rule: "收入和成本必须采用同一币种口径，默认本位币；原币毛利必须按币种分别计算。" },
    statusRule: approvedStatus,
    applicableErp: commonErp,
    requiredTables: ["可映射营业收入和营业成本的总账或业务明细", "会计科目/科目映射"],
    requiredFields: ledgerFields,
    sqlHints: ["必须同时具备营业收入与营业成本口径。", "毛利率分母为零时返回 NULL，不得除零。"],
  },
  {
    id: "net_profit",
    name: "净利润",
    aliases: ["税后利润", "净收益", "本年利润"],
    keywords: ["净利", "税后净利", "净利润额", "最终利润"],
    description: "利润总额扣除所得税费用后的净经营成果。",
    businessDefinition: "依据企业利润表映射，在同一期间和本位币口径下计算利润总额并扣除所得税费用；优先使用已确认的利润表项目或可靠的损益科目映射。",
    calculationRule: { metricType: "derived", expression: "净利润 = 利润总额 - 所得税费用", periodRule: "本月取当月损益发生额，累计取财年期初至截止期间；不能使用资产负债表期末余额替代。", aggregation: "formula" },
    accountScope: { accountCategories: ["营业收入", "营业成本", "税金及附加", "期间费用", "其他收益", "投资收益", "公允价值变动", "信用/资产减值", "资产处置", "营业外收支", "所得税费用"], accountCodePrefixes: [], includeRule: "必须使用客户确认的利润表项目或完整损益科目映射。", excludeRule: "排除所有者权益直接变动、以前年度损益调整和未纳入本期损益的其他综合收益。" },
    debitCreditDirection: { normalDirection: "mixed", amountRule: "各利润表项目按其正常借贷方向计算净发生额，再按利润表加减关系汇总。" },
    timeFieldHints: periodTimeFields,
    dimensions: organizationDimensions,
    currencyRule: functionalCurrency,
    statusRule: approvedStatus,
    applicableErp: commonErp,
    requiredTables: ["利润表项目或完整损益科目映射", "总账凭证明细"],
    requiredFields: ledgerFields,
    sqlHints: ["没有完整利润表项目映射时必须返回口径信息不足。", "不得简单用营业收入减成本减三费冒充净利润。"],
  },
  {
    id: "yoy",
    name: "同比",
    aliases: ["同比增长", "同比变化", "较上年同期"],
    keywords: ["去年同期", "上年同期", "同年同期", "比去年同月", "去年同月增长"],
    description: "本期与上年相同期间的比较。",
    businessDefinition: "在基础指标、组织、账套、维度、币种和状态口径完全一致时，将本期与上年同期进行比较。",
    calculationRule: { metricType: "comparison", expression: "同比增长率 = (本期值 - 上年同期值) / 上年同期值", periodRule: "日期区间整体向前平移一年；月、季度、累计期间必须保持同样长度。", aggregation: "ratio" },
    accountScope: { accountCategories: [], accountCodePrefixes: [], includeRule: "完全继承基础指标的科目范围。", excludeRule: "不得改变基础指标口径或比较不同组织、币种、状态的数据。" },
    debitCreditDirection: { normalDirection: "not_applicable", amountRule: "继承基础指标的借贷方向和符号。" },
    timeFieldHints: periodTimeFields,
    dimensions: organizationDimensions,
    currencyRule: { defaultBasis: "inherit_base_metric", rule: "本期与上年同期必须使用相同币种口径。", amountFieldHints: functionalCurrency.amountFieldHints },
    statusRule: { defaultStatus: "inherit_base_metric", rule: "本期和同期继承同一状态规则。", statusFieldHints: approvedStatus.statusFieldHints },
    applicableErp: commonErp,
    requiredTables: ["基础指标所需业务表"],
    requiredFields: [{ semantic: "基础指标数值", candidates: ["metric_value"], required: true }, { semantic: "可定位会计期间的日期字段", candidates: periodTimeFields, required: true }],
    sqlHints: ["必须同时返回本期值、上年同期值和同比增长率。", "上年同期值为零时增长率返回 NULL，并保留两期原值。", "同比必须与一个明确的基础指标共同使用。"],
  },
  {
    id: "mom",
    name: "环比",
    aliases: ["环比增长", "环比变化", "较上期"],
    keywords: ["上月", "上季度", "上一期间", "上期", "较上月变化率", "比上月"],
    description: "本期与紧邻的上一相同长度期间比较。",
    businessDefinition: "在基础指标、组织、账套、维度、币种和状态口径一致时，将本期与上一相邻期间进行比较。",
    calculationRule: { metricType: "comparison", expression: "环比增长率 = (本期值 - 上期值) / 上期值", periodRule: "月对上月、季度对上季度；任意日期区间应向前平移同等长度。", aggregation: "ratio" },
    accountScope: { accountCategories: [], accountCodePrefixes: [], includeRule: "完全继承基础指标的科目范围。", excludeRule: "不得改变基础指标口径或比较不同长度的期间。" },
    debitCreditDirection: { normalDirection: "not_applicable", amountRule: "继承基础指标的借贷方向和符号。" },
    timeFieldHints: periodTimeFields,
    dimensions: organizationDimensions,
    currencyRule: { defaultBasis: "inherit_base_metric", rule: "本期与上期必须使用相同币种口径。", amountFieldHints: functionalCurrency.amountFieldHints },
    statusRule: { defaultStatus: "inherit_base_metric", rule: "本期和上期继承同一状态规则。", statusFieldHints: approvedStatus.statusFieldHints },
    applicableErp: commonErp,
    requiredTables: ["基础指标所需业务表"],
    requiredFields: [{ semantic: "基础指标数值", candidates: ["metric_value"], required: true }, { semantic: "可定位会计期间的日期字段", candidates: periodTimeFields, required: true }],
    sqlHints: ["必须同时返回本期值、上期值和环比增长率。", "上期值为零时增长率返回 NULL，并保留两期原值。", "环比必须与一个明确的基础指标共同使用。"],
  },
];

export function searchMetrics(question: string, limit = 3): FinanceMetric[] {
  const query = normalize(question);
  if (!query) return [];
  const scored = financeMetrics
    .map((metric) => ({ metric, score: metricScore(metric, query) }))
    .filter((item) => item.score >= 60)
    .sort((a, b) => b.score - a.score || b.metric.name.length - a.metric.name.length);

  const exactMainRevenue = query.includes(normalize("主营业务收入")) || query.includes(normalize("主营收入"));
  const exactNetProfit = query.includes(normalize("净利润")) || query.includes(normalize("税后利润"));
  const filtered = scored.filter(({ metric }) => {
    if (exactMainRevenue && metric.id === "operating_revenue") return false;
    if (exactNetProfit && metric.id === "gross_profit") return false;
    return true;
  });
  return filtered.slice(0, Math.max(1, limit)).map((item) => item.metric);
}

export function toMetricPrompt(metric: FinanceMetric): FinanceMetricPrompt {
  const { id, name, businessDefinition, calculationRule, accountScope, debitCreditDirection, timeFieldHints, dimensions, currencyRule, statusRule, requiredTables, requiredFields, sqlHints } = metric;
  return { id, name, businessDefinition, calculationRule, accountScope, debitCreditDirection, timeFieldHints, dimensions, currencyRule, statusRule, requiredTables, requiredFields, sqlHints };
}

function metricScore(metric: FinanceMetric, query: string) {
  let score = 0;
  const name = normalize(metric.name);
  if (query.includes(name)) score += 140 + name.length;
  for (const alias of metric.aliases) {
    const value = normalize(alias);
    if (value && query.includes(value)) score += 105 + Math.min(value.length, 12);
  }
  for (const keyword of metric.keywords) {
    const value = normalize(keyword);
    if (value && query.includes(value)) score += 75 + Math.min(value.length, 10);
  }
  const semanticText = normalize(`${metric.description}${metric.businessDefinition}${metric.accountScope.accountCategories.join("")}`);
  for (const token of semanticTokens(query)) if (semanticText.includes(token)) score += 6;
  return score;
}

function semanticTokens(value: string) {
  const tokens = new Set<string>();
  for (let size = 2; size <= Math.min(6, value.length); size += 1) {
    for (let index = 0; index <= value.length - size; index += 1) tokens.add(value.slice(index, index + size));
  }
  return [...tokens];
}

function normalize(value: string) { return value.toLowerCase().replace(/[\s，。、“”‘’；：,.!?！？()（）/\\_-]+/g, ""); }
