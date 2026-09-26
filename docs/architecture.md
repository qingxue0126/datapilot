# DataPilot ERP 智能问数架构

## 当前代码与最小改造

现有项目已经具备 React 界面、MySQL/SSH 连接、Schema 获取、SQL 执行和加密的数据源持久化，因此这些能力保持不变。原有 `/api/query` 将模型生成、数据库执行和结果总结直接耦合在路由中，本次只替换这条链路，没有重写页面或底层数据库驱动。

```text
HTTP/API
  -> IdentityProvider（用户、租户、账套、角色）
  -> DataAgent（最多 3 次的 Agent Loop）
      -> metric.search Tool
      -> schema.search Tool（表/字段权限过滤）
      -> ModelProvider（生成只读 SQL）
      -> database.query Tool（AST、权限、数据范围校验）
      -> ModelProvider（结果分析）
  -> SessionStore（持久化分析会话与最近对话上下文）
```

数据库凭据只进入服务端 ToolContext，不进入模型 Prompt。模型只能看到权限过滤后的 Schema、指标定义、最近会话和查询结果。

## 模块边界

- `server/agent`：Agent Loop 和可替换 Harness 依赖。
- `server/auth`：身份解析与数据库、表、字段、数据范围权限。
- `server/context`：会话接口、SQLite 持久化实现及会话 API；按租户、账套和用户校验归属。
- `server/domain/erp`：收入、费用、应收、应付、利润、同比、环比指标，以及 ERP SQL 规划规则。
- `server/llm`：模型适配器；业务代码不依赖具体模型 API。
- `server/tools`：Tool Registry、Schema 检索、指标检索和只读数据库查询。
- `server/security`：独立 SQL 安全策略。
- `server/sandbox`：未来 Python、文件分析的隔离执行接口；当前明确禁用宿主机执行。

## 隔离和权限

每个持久化数据源都绑定 `tenantId + accountSetId`，列表、测试、Schema、SQL 和问数接口都会校验归属。旧的本地数据源自动迁移到 `demo-tenant/default-account-set`，不会因升级丢失。

本地开发未配置 `AUTH_JWT_SECRET` 时使用固定演示管理员身份，客户端不能通过租户请求头切换身份。配置 `AUTH_JWT_SECRET` 后，API 只接受签名 HS256 JWT，必要 claims 为：

```json
{
  "sub": "user-id",
  "tenant_id": "tenant-id",
  "account_set_id": "account-set-id",
  "role": "tenant_admin | finance_analyst | finance_viewer",
  "exp": 1893456000
}
```

默认角色权限：管理员可维护连接和使用独立数据库编辑台；分析师和查看者只能问数/只读查询。问数入口对所有角色都强制只读，永远不走写入确认逻辑。

表、字段和数据范围可通过 `DATAPILOT_PERMISSION_RULES_JSON` 按租户、账套、角色覆盖。例如：

```json
[
  {
    "tenantId": "tenant-a",
    "accountSetId": "book-2026",
    "role": "finance_viewer",
    "policy": {
      "allowedTables": ["voucher", "account"],
      "deniedColumns": ["bank_account", "id_card"],
      "rowScopes": [{ "table": "voucher", "column": "company_id", "allowedValues": ["company-a"] }]
    }
  }
]
```

生产环境下一步可把 JWT 验证适配到企业 OIDC/JWKS，并按部署形态将当前 SQLite SessionStore 替换为共享数据库实现；SessionStore 接口使这些替换不影响 Agent、模型或 Tool 实现。
