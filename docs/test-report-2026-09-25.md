# DataPilot 测试报告

## 概览

| 项目 | 结果 |
| --- | --- |
| 测试时间 | 2026-09-25 13:17:31 +08:00 |
| 代码版本 | `42647fa` — `feat: add ERP finance metric semantic layer` |
| Node.js | `v22.23.2` |
| npm | `10.9.8` |
| 服务端自动化测试 | 14 / 14 通过 |
| TypeScript 类型检查 | 通过 |
| 前端生产构建 | 通过 |
| 真实数据库 Text2SQL 集成验证 | 通过 |

## 测试范围

本报告验证 ERP 财务指标语义层第一阶段，以及它与现有 Agent、SQL 安全和数据库 Tool 的兼容性。

已验证：

- 10 个结构化财务指标的定义完整性；
- 别名、关键词与业务语义检索；
- 最多返回 3 个相关指标，未知问题不回退注入无关指标；
- 同比、环比必须携带基础指标；
- Schema 缺少必需字段或科目映射不足时返回“口径信息不足”；
- LLM 接收紧凑指标上下文，不接收仅用于检索的别名和关键词；
- 现有只读 SQL、表/字段/数据范围安全策略；
- MySQL 实际执行的营业收入查询。

未在本次范围内：

- PostgreSQL、SQL Server、Oracle 等非 MySQL 数据库；
- 企业真实 JWT/OIDC 身份系统；
- 多账套并发压测、审计中心与持久化会话；
- 不同 ERP 厂商的客户化科目映射、汇率和关账规则；
- Python Sandbox 与文件分析。

## 自动化测试结果

执行命令：

```bash
npm run test:server
```

结果：14 项通过，0 项失败，耗时约 565 ms。

| 编号 | 测试项 | 预期 | 结果 |
| --- | --- | --- | --- |
| 1 | 模型返回口径不足 | 返回明确的“口径信息不足”错误 | 通过 |
| 2 | 单独查询同比 | 拒绝，要求指定基础指标 | 通过 |
| 3 | 本月营业收入是多少 | `operating_revenue` | 通过 |
| 4 | 主营业务收入同比 | `main_business_revenue`、`yoy` | 通过 |
| 5 | 当前应收账款余额 | `accounts_receivable` | 通过 |
| 6 | 本月期间费用 | `period_expense` | 通过 |
| 7 | 净利润环比 | `net_profit`、`mom` | 通过 |
| 8 | 客户还有多少款尚未收回 | 语义匹配 `accounts_receivable` | 通过 |
| 9 | 显示凭证表前十行 | 不注入无关财务指标 | 通过 |
| 10 | 10 个指标的语义结构 | 所有必需字段均存在 | 通过 |
| 11 | LLM 指标上下文 | 不携带 `aliases`、`keywords` | 通过 |
| 12 | 只读 SQL | 允许符合策略的 `SELECT` | 通过 |
| 13 | SQL 风险控制 | 拒绝写操作、越权表、越权字段和 `SELECT *` | 通过 |
| 14 | 数据范围策略 | 缺少/错误范围条件时拒绝执行 | 通过 |

相关测试文件：

- [metrics.test.ts](../server/domain/erp/metrics.test.ts)
- [erp-query-service.test.ts](../server/domain/erp/erp-query-service.test.ts)
- [sql-policy.test.ts](../server/security/sql-policy.test.ts)

## 类型检查与构建

执行命令：

```bash
npx tsc -p tsconfig.server.json
npm run build
```

结果：均通过。`vinext build` 输出了动态路由分类提示，但未产生构建错误，不影响本地开发和当前生产构建产物。

## 真实数据库集成验证

### 场景

使用已连接的本地 MySQL 数据源，对问题“本月营业收入是多少”执行完整链路：

```text
问题 → 指标检索 → Schema 检索 → SQL 生成 → SQL 安全校验 → Database Tool → 结果分析
```

### 结果

| 项目 | 结果 |
| --- | --- |
| 识别指标 | 营业收入（`operating_revenue`） |
| 返回行数 | 1 |
| 总耗时 | 1907 ms |
| 结论 | 本月营业收入为 0.00 元 |
| 执行状态 | 通过 |

生成 SQL：

```sql
SELECT COALESCE(SUM(v.credit - v.debit), 0) AS 本月营业收入
FROM voucher v
WHERE v.account_name IN ('主营业务收入', '其他业务收入')
  AND v.voucher_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
  AND v.voucher_date < DATE_FORMAT(CURDATE() + INTERVAL 1 MONTH, '%Y-%m-01')
LIMIT 200
```

验证点：

- 按收入类科目的 `贷方 - 借方` 计算净发生额；
- 范围限定为主营业务收入和其他业务收入；
- 使用本月起止边界；
- 使用只读 `SELECT`；
- 数据库访问经 `database.query` Tool 和 SQL 安全策略执行。

## 结论与风险

第一阶段指标语义层可稳定识别本次定义的 10 个指标，能将财务口径、借贷方向、期间、状态、币种、维度及必需字段传递给 Text2SQL 模型。当比较口径缺少基础指标，或当前 Schema 不具备必需映射时，系统会返回“口径信息不足”，而不是猜测 SQL。

当前最大的业务风险不在代码，而在客户化 ERP 映射尚未配置。上线前应为每个租户/账套维护至少以下内容：

- 科目编码和科目类别映射；
- 凭证审核、过账、作废状态映射；
- 财年、特殊会计期间和关账规则；
- 本位币、原币、汇率及折算规则；
- 应收应付期初余额、辅助核算和账龄规则；
- 收入确认、退货、折扣、税额、成本结转和分摊规则；
- 利润表项目与净利润计算口径；
- 集团合并、内部交易抵销和少数股东损益规则。

