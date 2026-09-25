import type { ErpEntityDefinition, StandardFieldDefinition } from "./types.js";

const field = (name: string, description: string, aliases: string[], commentAliases: string[], required = false): StandardFieldDefinition =>
  ({ name, description, aliases, commentAliases, required });

export const ERP_ENTITY_DEFINITIONS: ErpEntityDefinition[] = [
  {
    entity: "Voucher", description: "会计凭证主信息", tableAliases: ["voucher", "vouchers", "gl_voucher", "t_gl_voucher", "凭证", "凭证主表"],
    fields: [
      field("id", "凭证主键", ["id", "voucher_id", "fid", "pk_voucher"], ["凭证id", "凭证主键"], true),
      field("voucherNo", "凭证号", ["voucher_no", "voucher_number", "voucherno", "ino_id", "fnumber"], ["凭证号", "凭证编号"], true),
      field("voucherDate", "制单/业务日期", ["voucher_date", "biz_date", "dbill_date", "fdate"], ["凭证日期", "制单日期"], true),
      field("postingDate", "记账/过账日期", ["posting_date", "posted_at", "accounting_date"], ["记账日期", "过账日期"]),
      field("status", "审核或过账状态", ["status", "voucher_status", "audit_status", "posting_status", "is_posted", "fstatus"], ["审核状态", "过账状态", "凭证状态"]),
      field("organizationId", "组织/公司标识", ["organization_id", "org_id", "company_id", "book_id", "faccountbookid"], ["组织", "公司", "账套"]),
    ],
  },
  {
    entity: "VoucherEntry", description: "凭证分录/总账明细", tableAliases: ["voucher_entry", "voucher_entries", "voucher_detail", "voucher", "gl_accvouch", "t_gl_voucherentry", "entry", "凭证明细", "凭证分录"],
    signatureFields: ["accountCode", "debitAmount", "creditAmount"],
    fields: [
      field("id", "分录主键", ["id", "entry_id", "detail_id", "fid", "fentryid"], ["分录id", "明细id"]),
      field("voucherId", "所属凭证标识", ["voucher_id", "voucherid", "ino_id", "bill_id", "fbillid", "id"], ["凭证id", "凭证标识"], true),
      field("voucherDate", "凭证/记账日期", ["voucher_date", "posting_date", "biz_date", "dbill_date", "fdate"], ["凭证日期", "记账日期", "业务日期"], true),
      field("accountCode", "会计科目编码", ["account_code", "subject_code", "accountcode", "ccode", "faccountid"], ["科目编码", "会计科目编码"], true),
      field("accountName", "会计科目名称", ["account_name", "subject_name", "account_title", "ccode_name", "faccountname"], ["科目名称", "会计科目名称", "会计科目"]),
      field("debitAmount", "本位币借方金额", ["debit_amount", "debit", "local_debit", "base_debit", "md", "fdebit"], ["借方金额", "本币借方", "借方"], true),
      field("creditAmount", "本位币贷方金额", ["credit_amount", "credit", "local_credit", "base_credit", "mc", "fcredit"], ["贷方金额", "本币贷方", "贷方"], true),
      field("currency", "币种", ["currency", "currency_code", "currency_id", "cexch_name", "fcurrencyid"], ["币种", "货币"]),
      field("customerId", "客户辅助核算", ["customer_id", "customer_code", "cus_id", "ccus_id", "fcustomerid"], ["客户", "客户编码"]),
      field("supplierId", "供应商辅助核算", ["supplier_id", "vendor_id", "supplier_code", "csup_id", "fsupplierid"], ["供应商", "供应商编码"]),
      field("departmentId", "部门辅助核算", ["department_id", "dept_id", "cdept_id", "fdeptid"], ["部门", "部门编码"]),
      field("organizationId", "组织/公司标识", ["organization_id", "org_id", "company_id", "book_id", "faccountbookid"], ["组织", "公司", "账套"]),
      field("status", "审核或过账状态", ["status", "voucher_status", "audit_status", "posting_status", "is_posted", "fstatus"], ["审核状态", "过账状态"]),
    ],
  },
  {
    entity: "Account", description: "会计科目", tableAliases: ["account", "accounts", "subject", "gl_account", "bd_account", "t_bd_account", "科目", "会计科目"],
    fields: [
      field("id", "科目主键", ["id", "account_id", "subject_id", "fid"], ["科目id"], true),
      field("code", "科目编码", ["code", "account_code", "subject_code", "ccode", "fnumber"], ["科目编码"], true),
      field("name", "科目名称", ["name", "account_name", "subject_name", "ccode_name", "fname"], ["科目名称"], true),
      field("category", "科目类别", ["category", "account_category", "subject_type", "faccttype"], ["科目类别", "科目类型"]),
      field("normalDirection", "余额方向", ["normal_direction", "balance_direction", "dc_direction", "fdc"], ["借贷方向", "余额方向"]),
      field("parentCode", "上级科目编码", ["parent_code", "parent_account_code", "fparentid"], ["上级科目"]),
      field("status", "启用状态", ["status", "enabled", "is_active", "fdocumentstatus"], ["状态", "启用状态"]),
    ],
  },
  {
    entity: "Customer", description: "客户主数据", tableAliases: ["customer", "customers", "bd_customer", "t_bd_customer", "crm_customer", "客户"],
    fields: [field("id", "客户主键", ["id", "customer_id", "cus_id", "fid"], ["客户id"], true), field("code", "客户编码", ["code", "customer_code", "cus_code", "fnumber"], ["客户编码"], true), field("name", "客户名称", ["name", "customer_name", "cus_name", "fname"], ["客户名称"], true), field("organizationId", "所属组织", ["organization_id", "org_id", "company_id", "fuseorgid"], ["所属组织"]), field("status", "客户状态", ["status", "enabled", "is_active", "fdocumentstatus"], ["状态"])],
  },
  {
    entity: "Supplier", description: "供应商主数据", tableAliases: ["supplier", "suppliers", "vendor", "vendors", "bd_supplier", "t_bd_supplier", "供应商"],
    fields: [field("id", "供应商主键", ["id", "supplier_id", "vendor_id", "sup_id", "fid"], ["供应商id"], true), field("code", "供应商编码", ["code", "supplier_code", "vendor_code", "fnumber"], ["供应商编码"], true), field("name", "供应商名称", ["name", "supplier_name", "vendor_name", "fname"], ["供应商名称"], true), field("organizationId", "所属组织", ["organization_id", "org_id", "company_id", "fuseorgid"], ["所属组织"]), field("status", "供应商状态", ["status", "enabled", "is_active", "fdocumentstatus"], ["状态"])],
  },
  {
    entity: "Receivable", description: "应收单据/应收余额", tableAliases: ["receivable", "receivables", "accounts_receivable", "ar_detail", "ar_balance", "应收", "应收账款"], signatureFields: ["customerId", "balance"],
    fields: [field("id", "应收主键", ["id", "receivable_id", "ar_id", "fid"], ["应收id"], true), field("customerId", "客户", ["customer_id", "customer_code", "cus_id", "fcustomerid"], ["客户"], true), field("voucherId", "来源凭证", ["voucher_id", "source_voucher_id", "fbillid"], ["凭证id"]), field("amount", "应收发生额", ["amount", "receivable_amount", "ar_amount", "famount"], ["应收金额"]), field("balance", "应收余额", ["balance", "remaining_amount", "open_amount", "ending_balance", "funsettleamount"], ["应收余额", "未核销金额"], true), field("currency", "币种", ["currency", "currency_code", "fcurrencyid"], ["币种"]), field("dueDate", "到期日", ["due_date", "maturity_date", "fduedate"], ["到期日"]), field("businessDate", "业务日期", ["business_date", "bill_date", "voucher_date", "fdate"], ["业务日期", "单据日期"]), field("status", "单据状态", ["status", "audit_status", "fdocumentstatus"], ["审核状态"]), field("organizationId", "组织", ["organization_id", "org_id", "company_id", "fuseorgid"], ["组织"])],
  },
  {
    entity: "Payable", description: "应付单据/应付余额", tableAliases: ["payable", "payables", "accounts_payable", "ap_detail", "ap_balance", "应付", "应付账款"], signatureFields: ["supplierId", "balance"],
    fields: [field("id", "应付主键", ["id", "payable_id", "ap_id", "fid"], ["应付id"], true), field("supplierId", "供应商", ["supplier_id", "vendor_id", "supplier_code", "fsupplierid"], ["供应商"], true), field("voucherId", "来源凭证", ["voucher_id", "source_voucher_id", "fbillid"], ["凭证id"]), field("amount", "应付发生额", ["amount", "payable_amount", "ap_amount", "famount"], ["应付金额"]), field("balance", "应付余额", ["balance", "remaining_amount", "open_amount", "ending_balance", "funsettleamount"], ["应付余额", "未核销金额"], true), field("currency", "币种", ["currency", "currency_code", "fcurrencyid"], ["币种"]), field("dueDate", "到期日", ["due_date", "maturity_date", "fduedate"], ["到期日"]), field("businessDate", "业务日期", ["business_date", "bill_date", "voucher_date", "fdate"], ["业务日期", "单据日期"]), field("status", "单据状态", ["status", "audit_status", "fdocumentstatus"], ["审核状态"]), field("organizationId", "组织", ["organization_id", "org_id", "company_id", "fuseorgid"], ["组织"])],
  },
  {
    entity: "Organization", description: "组织/公司/账套", tableAliases: ["organization", "organizations", "org", "company", "companies", "account_book", "组织", "公司", "账套"],
    fields: [field("id", "组织主键", ["id", "organization_id", "org_id", "company_id", "fid"], ["组织id"], true), field("code", "组织编码", ["code", "organization_code", "org_code", "company_code", "fnumber"], ["组织编码"], true), field("name", "组织名称", ["name", "organization_name", "org_name", "company_name", "fname"], ["组织名称"], true), field("parentId", "上级组织", ["parent_id", "parent_org_id", "fparentid"], ["上级组织"]), field("status", "组织状态", ["status", "enabled", "is_active", "fdocumentstatus"], ["状态"])],
  },
  {
    entity: "Department", description: "部门", tableAliases: ["department", "departments", "dept", "bd_department", "t_bd_department", "部门"],
    fields: [field("id", "部门主键", ["id", "department_id", "dept_id", "fid"], ["部门id"], true), field("code", "部门编码", ["code", "department_code", "dept_code", "fnumber"], ["部门编码"], true), field("name", "部门名称", ["name", "department_name", "dept_name", "fname"], ["部门名称"], true), field("organizationId", "所属组织", ["organization_id", "org_id", "company_id", "fuseorgid"], ["所属组织"]), field("parentId", "上级部门", ["parent_id", "parent_dept_id", "fparentid"], ["上级部门"]), field("status", "部门状态", ["status", "enabled", "is_active", "fdocumentstatus"], ["状态"])],
  },
];
