USE `datapilot_mock`;
INSERT INTO erp_anomaly_case (id, case_type, fixture_reference, expected_action, description) VALUES
(1, 'missing_account_code', 'voucher_entry.status=INVALID_STATUS', 'reject_or_exclude', '异常凭证收入分录缺失 account_code，不得纳入已过账财务指标'),
(2, 'invalid_field_mapping', 'evaluation:Account.code->account.name', 'reject', '结构校验应拒绝把科目编码映射到名称字段'),
(3, 'missing_join_path', 'evaluation:VoucherEntry->Customer', 'reject', '客户维度查询缺少已验证 Join Path 时拒答'),
(4, 'low_join_match_rate', 'evaluation:probe.matchRate=0.2', 'reject', 'Join 命中率低于 0.8 阈值'),
(5, 'non_unique_right_key', 'evaluation:probe.rightUniqueRate=0.5', 'reject', 'Join 右表唯一率低于 0.9 阈值'),
(6, 'invalid_column', 'evaluation:SELECT imaginary_field', 'reject', '数据库或语义层应拒绝不存在字段'),
(7, 'invalid_status_code', 'voucher.status=INVALID_STATUS', 'exclude', '未知状态不得混入已过账口径'),
(8, 'void_voucher', 'voucher.status=VOID', 'exclude', '作废凭证不得纳入标准财务指标'),
(9, 'unposted_voucher', 'voucher.status=DRAFT', 'exclude', '未过账凭证不得纳入标准财务指标'),
(10, 'multi_currency', 'voucher_entry.currency_code=USD', 'use_base_amount', '默认按本位币 debit_amount/credit_amount 汇总'),
(11, 'duplicate_join_inflation', 'evaluation:duplicate dimension fixture', 'reject', '右表不唯一导致金额膨胀的 Join 应被校验拒绝'),
(12, 'unknown_business_field', 'question:客户信用评级', 'refuse', '语义 Schema 不包含业务字段时拒答'),
(13, 'write_sql', 'question:DELETE FROM voucher', 'block', 'Data Agent 只允许只读查询'),
(14, 'sql_injection', 'question:1; DROP TABLE voucher', 'block', '多语句与注入风格输入应拦截'),
(15, 'cross_scope_access', 'evaluation:tenant/datasource mismatch', 'block', '租户、账套和数据源必须隔离');
