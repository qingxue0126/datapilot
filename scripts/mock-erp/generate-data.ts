import { fileURLToPath } from "node:url";
import mysql, { type Connection } from "mysql2/promise";

export const MOCK_SEED = 20260925;

const revenueTargets = new Map<string, number>([
  ["2025-01", 520000], ["2025-02", 560000], ["2025-03", 600000], ["2025-04", 650000],
  ["2025-05", 700000], ["2025-06", 760000], ["2025-07", 820000], ["2025-08", 900000],
  ["2025-09", 1000000], ["2025-10", 940000], ["2025-11", 980000], ["2025-12", 1050000],
  ["2026-01", 700000], ["2026-02", 750000], ["2026-03", 800000], ["2026-04", 850000],
  ["2026-05", 900000], ["2026-06", 950000], ["2026-07", 1000000], ["2026-08", 1100000],
  ["2026-09", 1200000],
]);

const monthCounts = new Map<string, number>([
  ...Array.from({ length: 12 }, (_, index) => [`2025-${String(index + 1).padStart(2, "0")}`, 60] as const),
  ...Array.from({ length: 9 }, (_, index) => [`2026-${String(index + 1).padStart(2, "0")}`, 120] as const),
]);

const customerWeights = [20, 16, 14, 12, 10, 8, 7, 5, 4, 4];
const departmentWeights = [40, 25, 20, 15];
const supplierWeights = [24, 18, 15, 12, 10, 8, 5, 4, 2, 2];

export async function generateData(connection: Connection) {
  const rng = mulberry32(MOCK_SEED);
  await insertRows(connection, "organization", ["id", "code", "name", "parent_id", "status"], [
    [1, "ORG001", "集团总部", null, "ACTIVE"], [2, "ORG002", "华东公司", 1, "ACTIVE"],
    [3, "ORG003", "华南公司", 1, "ACTIVE"], [4, "ORG004", "华北公司", 1, "ACTIVE"],
    [5, "ORG005", "西部公司", 1, "ACTIVE"],
  ]);

  const departmentNames = ["销售部", "管理部", "研发部", "财务部"];
  const departments = Array.from({ length: 20 }, (_, index) => [
    index + 1, `DEPT${String(index + 1).padStart(3, "0")}`,
    index < 4 ? departmentNames[index] : `业务部门${String(index + 1).padStart(2, "0")}`,
    (index % 5) + 1, null, "ACTIVE",
  ]);
  await insertRows(connection, "department", ["id", "code", "name", "organization_id", "parent_id", "status"], departments);

  const coreAccounts: unknown[][] = [
    [1, "1001", "库存现金", "资产", "debit", null, "ACTIVE"],
    [2, "1122", "应收账款", "资产", "debit", null, "ACTIVE"],
    [3, "2202", "应付账款", "负债", "credit", null, "ACTIVE"],
    [4, "6001", "主营业务收入", "主营业务收入", "credit", null, "ACTIVE"],
    [5, "6051", "其他业务收入", "其他业务收入", "credit", null, "ACTIVE"],
    [6, "6401", "主营业务成本", "主营业务成本", "debit", null, "ACTIVE"],
    [7, "6601", "销售费用", "销售费用", "debit", null, "ACTIVE"],
    [8, "6602", "管理费用", "管理费用", "debit", null, "ACTIVE"],
    [9, "6603", "财务费用", "财务费用", "debit", null, "ACTIVE"],
  ];
  const fillerAccounts = Array.from({ length: 171 }, (_, index) => {
    const id = index + 10; const code = String(7000 + index);
    return [id, code, `辅助科目${String(id).padStart(3, "0")}`, "辅助核算", index % 2 ? "credit" : "debit", null, "ACTIVE"];
  });
  await insertRows(connection, "account", ["id", "code", "name", "category", "normal_direction", "parent_code", "status"], [...coreAccounts, ...fillerAccounts]);

  const customers = Array.from({ length: 200 }, (_, index) => [
    index + 1, `CUST${String(index + 1).padStart(3, "0")}`,
    index < 10 ? `客户${String.fromCharCode(65 + index)}` : `客户${String(index + 1).padStart(3, "0")}`,
    (index % 5) + 1, "ACTIVE",
  ]);
  const suppliers = Array.from({ length: 150 }, (_, index) => [
    index + 1, `SUP${String(index + 1).padStart(3, "0")}`,
    index < 10 ? `供应商${String.fromCharCode(65 + index)}` : `供应商${String(index + 1).padStart(3, "0")}`,
    (index % 5) + 1, "ACTIVE",
  ]);
  await insertRows(connection, "customer", ["id", "code", "name", "organization_id", "status"], customers);
  await insertRows(connection, "supplier", ["id", "code", "name", "organization_id", "status"], suppliers);

  const vouchers: unknown[][] = [];
  const entries: unknown[][] = [];
  let voucherId = 1; let entryId = 1;
  for (const [period, count] of monthCounts) {
    const [year, month] = period.split("-").map(Number);
    const postedCount = count - 3;
    const revenueCents = Math.round((revenueTargets.get(period) || 0) * 100);
    const expenseTotal = period === "2026-09" ? 300000 : Math.round((revenueTargets.get(period) || 0) * 0.25);
    const revenuePlan = groupedAllocation(revenueCents, postedCount, customerWeights);
    const expensePlan = groupedAllocation(expenseTotal * 100, postedCount, departmentWeights);
    const supplierPlan = groupedAllocation(expenseTotal * 100, postedCount, supplierWeights);

    for (let index = 0; index < count; index += 1) {
      const isPosted = index < postedCount;
      const status = isPosted ? "POSTED" : index === postedCount ? "VOID" : index === postedCount + 1 ? "DRAFT" : "INVALID_STATUS";
      const day = 1 + (index % 25);
      const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const voucherNo = `V${year}${String(month).padStart(2, "0")}${String(index + 1).padStart(4, "0")}`;
      const organizationId = (index % 5) + 1;
      const revenueAmount = isPosted ? revenuePlan[index].amount : 99999900;
      const expenseAmount = isPosted ? expensePlan[index].amount : 33333300;
      const customerId = isPosted ? revenuePlan[index].group + 1 : 1;
      const departmentId = isPosted ? expensePlan[index].group + 1 : 1;
      const supplierId = isPosted ? supplierPlan[index].group + 1 : 1;
      const currency = isPosted && index % 20 === 0 ? "USD" : "CNY";
      const exchangeRate = currency === "USD" ? 7.2 : 1;
      vouchers.push([voucherId, voucherNo, "GL", year, month, date, isPosted ? date : null, status, organizationId]);
      const common = [voucherId, voucherNo, "GL", year, month, date];
      const amount = (cents: number) => cents / 100;
      const original = (cents: number) => Math.round((cents / exchangeRate)) / 100;
      entries.push([entryId++, ...common, 2, "1122", amount(revenueAmount), 0, currency, original(revenueAmount), exchangeRate, customerId, null, null, organizationId, status, 1, "确认应收"]);
      entries.push([entryId++, ...common, 4, status === "INVALID_STATUS" ? null : "6001", 0, amount(revenueAmount), currency, original(revenueAmount), exchangeRate, customerId, null, null, organizationId, status, 2, "确认营业收入"]);
      const expenseAccountId = departmentId === 1 ? 7 : departmentId === 2 ? 8 : 9;
      const expenseCode = departmentId === 1 ? "6601" : departmentId === 2 ? "6602" : "6603";
      entries.push([entryId++, ...common, expenseAccountId, expenseCode, amount(expenseAmount), 0, currency, original(expenseAmount), exchangeRate, null, supplierId, departmentId, organizationId, status, 3, "确认期间费用"]);
      entries.push([entryId++, ...common, 3, "2202", 0, amount(expenseAmount), currency, original(expenseAmount), exchangeRate, null, supplierId, departmentId, organizationId, status, 4, "确认应付"]);
      voucherId += 1;
    }
  }
  await insertRows(connection, "voucher", ["id", "voucher_no", "voucher_type", "fiscal_year", "accounting_period", "voucher_date", "posting_date", "status", "organization_id"], vouchers);
  await insertRows(connection, "voucher_entry", ["id", "voucher_id", "voucher_no", "voucher_type", "fiscal_year", "accounting_period", "voucher_date", "account_id", "account_code", "debit_amount", "credit_amount", "currency_code", "original_amount", "exchange_rate", "customer_id", "supplier_id", "department_id", "organization_id", "status", "line_no", "description"], entries);

  const receivableTargets = allocateTargets(100000000, [30000000, 20000000, 10000000, 8000000, 7000000, 6000000, 5000000, 4000000, 3000000, 2000000], 200);
  const payableTargets = allocateTargets(70000000, [18000000, 13000000, 10000000, 8000000, 6000000, 4000000, 3000000, 2000000, 1500000, 1000000], 150);
  const receivables = balanceRows(receivableTargets, 1490, 200, "receivable", rng);
  const payables = balanceRows(payableTargets, 1490, 150, "payable", rng);
  for (let index = 0; index < 10; index += 1) {
    receivables.push([1491 + index, (index % 10) + 1, null, 999999, 999999, "CNY", "2026-12-31", "2026-09-25", index < 5 ? "VOID" : "DRAFT", 1]);
    payables.push([1491 + index, (index % 10) + 1, null, 888888, 888888, "CNY", "2026-12-31", "2026-09-25", index < 5 ? "VOID" : "DRAFT", 1]);
  }
  await insertRows(connection, "receivable", ["id", "customer_id", "voucher_id", "amount", "balance", "currency_code", "due_date", "business_date", "status", "organization_id"], receivables);
  await insertRows(connection, "payable", ["id", "supplier_id", "voucher_id", "amount", "balance", "currency_code", "due_date", "business_date", "status", "organization_id"], payables);
}

function groupedAllocation(totalCents: number, itemCount: number, weights: number[]) {
  const groupTotals = weightedTotals(totalCents, weights);
  const counts = Array(weights.length).fill(Math.floor(itemCount / weights.length));
  for (let index = 0; index < itemCount % weights.length; index += 1) counts[index] += 1;
  return groupTotals.flatMap((total, group) => splitCents(total, counts[group]).map((amount) => ({ group, amount })));
}

function allocateTargets(totalCents: number, fixed: number[], count: number) {
  const remaining = totalCents - fixed.reduce((sum, value) => sum + value, 0);
  return [...fixed, ...splitCents(remaining, count - fixed.length)];
}

function balanceRows(targets: number[], validRowCount: number, partyCount: number, kind: "receivable" | "payable", rng: () => number) {
  const counts = Array(partyCount).fill(Math.floor(validRowCount / partyCount));
  for (let index = 0; index < validRowCount % partyCount; index += 1) counts[index] += 1;
  const rows: unknown[][] = []; let id = 1;
  for (let partyIndex = 0; partyIndex < partyCount; partyIndex += 1) {
    const balances = splitCents(targets[partyIndex], counts[partyIndex]);
    for (const balance of balances) {
      const businessDay = 1 + Math.floor(rng() * 24);
      const organizationId = (partyIndex % 5) + 1;
      rows.push([id++, partyIndex + 1, null, balance / 100, balance / 100, id % 37 === 0 ? "USD" : "CNY", "2026-10-31", `2026-09-${String(businessDay).padStart(2, "0")}`, "POSTED", organizationId]);
    }
  }
  if (rows.length !== validRowCount) throw new Error(`${kind} row count mismatch`);
  return rows;
}

function weightedTotals(total: number, weights: number[]) {
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  const raw = weights.map((weight) => Math.floor(total * weight / weightTotal));
  let remainder = total - raw.reduce((sum, value) => sum + value, 0);
  for (let index = 0; remainder > 0; index = (index + 1) % raw.length, remainder -= 1) raw[index] += 1;
  return raw;
}

function splitCents(total: number, count: number) {
  if (count <= 0) return [];
  const base = Math.floor(total / count); const remainder = total - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

async function insertRows(connection: Connection, table: string, columns: string[], rows: unknown[][]) {
  const chunkSize = 500;
  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    await connection.query(`INSERT INTO \`${table}\` (${columns.map((column) => `\`${column}\``).join(",")}) VALUES ?`, [chunk]);
  }
}

function mulberry32(seed: number) {
  let value = seed >>> 0;
  return () => { value += 0x6D2B79F5; let result = value; result = Math.imul(result ^ result >>> 15, result | 1); result ^= result + Math.imul(result ^ result >>> 7, result | 61); return ((result ^ result >>> 14) >>> 0) / 4294967296; };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const connection = await mysql.createConnection({ host: process.env.MYSQL_HOST || "127.0.0.1", port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER || "root", password: process.env.MYSQL_PASSWORD || "123456", database: "datapilot_mock", charset: "utf8mb4" });
  try { await generateData(connection); } finally { await connection.end(); }
}
