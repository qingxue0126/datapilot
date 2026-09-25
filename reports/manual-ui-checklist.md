# DataPilot ERP Mock 人工 UI 验收清单

测试数据源：`datapilot_mock`

建议浏览器：Chrome / Edge 最新稳定版

记录人：__________  日期：__________  构建版本：__________

> 当前自动化不依赖浏览器点击。请在每项执行后填写“实际结果”“Pass / Fail”和“截图编号”，不要使用模拟截图。

| 编号 | 验收项 | 操作步骤 | 预期结果 | 实际结果 | Pass / Fail | 截图编号 |
| --- | --- | --- | --- | --- | --- | --- |
| UI-01 | 数据源显示 | 启动 Web/API；进入“数据源”页面 | 列表显示 `datapilot_mock`，状态为已连接；主机 `127.0.0.1:3306`，数据库 `datapilot_mock` |  |  |  |
| UI-02 | ERP Mapping 识别 | 打开 `datapilot_mock` 详情，进入 Overview | 显示 9 个 ERP 实体；Mapping Confidence 与状态可见 |  |  |  |
| UI-03 | Schema Mapping 页面 | 切换到 Schema Mapping | Voucher、VoucherEntry、Account、Customer、Supplier、Receivable、Payable、Organization、Department 均映射到同名表，关键字段无缺失 |  |  |  |
| UI-04 | Join Paths | 切换到 Join Paths | 至少显示 VoucherEntry→Account/Customer/Supplier/Department、Receivable→Customer、Payable→Supplier，状态为 Validated |  |  |  |
| UI-05 | Validation | 切换到 Validation，点击 Validate（如页面提供按钮） | Mapping Validation 显示 Passed；必需字段覆盖完整；低命中率/不唯一 Join 不得显示为 Validated |  |  |  |
| UI-06 | 保存 Draft | 修改 Change Summary 或做可逆字段编辑，点击 Save Draft | 保存成功，出现 Draft 版本；Published 版本保持不变 |  |  |  |
| UI-07 | 发布 Mapping | 使用 tenant_admin 身份验证 Draft 后点击 Publish | 发布成功；Mapping 状态变为 Published；查询优先使用新 Published 版本 |  |  |  |
| UI-08 | Versions | 切换到 Versions | 出现本轮创建的 published / archived 版本与操作者、时间、摘要 |  |  |  |
| UI-09 | Diff | 选择相邻版本查看 Diff | 字段和 Join 的 Added / Changed / Removed 与实际编辑一致；无变化时明确显示空 Diff |  |  |  |
| UI-10 | Rollback | 选择历史 Published/Archived 版本，执行 Rollback | 生成新的 Published 版本；原历史版本不被原地修改；显示 rollbackFromVersion |  |  |  |
| UI-11 | 数据问答 | 进入“数据问答”，选择 `datapilot_mock`，提问“2026年9月营业收入是多少？” | 返回 `1,200,000`，SQL 为只读查询，排除非 POSTED 数据 |  |  |  |
| UI-12 | Agent Trace | 展开 Agent Trace | 依次可见 metric.search、schema.search、sql.generate、database.query、result.analyze 及各步骤状态/耗时 |  |  |  |
| UI-13 | Answer Explanation | 展开 Answer Explanation | 显示 operating_revenue、使用的实体/Mapping/Join、Mapping 版本与状态 |  |  |  |
| UI-14 | SQL 展开 | 点击“查看 SQL”或 SQL 折叠区 | 可完整查看最终 SQL；包含正确时间、状态、科目范围与括号分组；不可编辑并绕过安全策略 |  |  |  |
| UI-15 | Mapping 不足拒答 | 使用缺失字段/缺失 Join 的 Draft（不发布），或在隔离测试源触发；询问相关维度问题 | 页面显示 BusinessErrorCard，明确指出 Schema Mapping / Join Path 不足，不展示伪造结果 |  |  |  |
| UI-16 | 安全拒答 | 提问“查询收入; DROP DATABASE datapilot_mock” | 显示只读安全拒答；不生成或执行 SQL；数据库仍存在 |  |  |  |
| UI-17 | 跨数据源保护 | 在请求中替换为无权访问的 connectionId（仅测试环境） | 显示数据源不存在或无权访问，不泄露目标库 Schema |  |  |  |
| UI-18 | 多币种解释 | 提问“按本位币口径算2026年9月营业收入” | 使用 `debit_amount/credit_amount` 本位币字段，不直接混加原币金额 |  |  |  |

## 截图登记

| 截图编号 | 对应验收项 | 文件名 / 存储位置 | 备注 |
| --- | --- | --- | --- |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |

## 人工结论

- 通过项：____ / 18
- 失败项：____ / 18
- 阻塞项：____ / 18
- 结论：□ Pass  □ Conditional Pass  □ Fail
- 主要问题与复现步骤：
