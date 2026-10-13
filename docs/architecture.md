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

- `server/modules/agent`：runtime、workflow 和 presets；电话客服位于 `presets/phone-support`。
- `server/modules/datasource`：连接管理、Schema 映射、版本审核和 Schema 检索工具。
- `server/modules/text2sql`：ERP 指标、SQL 规划及指标/SQL 执行工具。
- `server/modules/model`：模型配置、权限、任务路由及模型服务。
- `server/modules/knowledge`：知识库、文档处理、Embedding 编排和检索。
- `server/modules/conversation`：持久化会话、上下文窗口和会话 API。
- `server/modules/auth`：身份、RBAC、API Key、资源权限及账户存储。
- `server/modules/organization`：团队、成员和邀请 API，通过窄接口使用账户聚合。
- `server/infrastructure`：MySQL/SSH、Milvus/本地向量库、LLM Provider、加密文件存储、SQL 安全和 Sandbox。
- `server/shared`：实际跨模块使用的身份、权限、模型协议、数据库、对话、追踪及工具契约。
- `server/http`：SSE 和 CORS 协议；`server/index.ts` 负责装配和启动。
- `components/features`：按功能组织页面组件；`ui` 为基础组件，`shared` 为跨功能客户端能力。

业务模块通过 `index.ts` 互相引用；前端只能使用服务端 `contracts.ts` 中的浏览器安全契约。模块内部不引用自己的公共入口，以免产生循环。详细迁移决策见 [directory-structure.md](directory-structure.md)。

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
