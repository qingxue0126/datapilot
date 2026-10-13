# DataPilot 目录与模块边界

本工程保留单个 `package.json`、现有 vinext 前端和 Express API 启动方式，不引入 workspace 或新框架。参考 [Dify 的仓库职责划分](https://github.com/langgenius/dify)及 [Langfuse 的 features](https://github.com/langfuse/langfuse/tree/main/web/src/features)与 [shared](https://github.com/langfuse/langfuse/tree/main/packages/shared/src)，按当前代码规模划分职责。

## 依赖方向

```text
app -> components/features -> components/ui, components/shared
server/index.ts -> modules/*/index.ts -> infrastructure, shared
agent -> text2sql, datasource, conversation, knowledge, model, auth
text2sql -> datasource, model, auth
knowledge -> model, auth
datasource / model / organization -> auth
infrastructure -> shared
shared -> shared
```

模块的跨领域调用必须使用 `index.ts`；同领域直接引用相邻文件。`contracts.ts` 只暴露浏览器安全的数据定义和纯常量，不能导入数据库、文件系统或 Provider。基础设施不能反向引用领域模块，shared 不能向上依赖其他层。

`npm run check:architecture` 检查真实 TypeScript import/export、动态 import 和 import type，校验不可解析路径、跨领域内部引用、分层方向、前后端依赖、文件及模块循环。单元测试允许直接测试模块内部实现。

## 核心归属

| 能力 | 位置及理由 |
| --- | --- |
| Agent | `server/modules/agent/runtime` 编排，`workflow` 保存工作流、运行、发布、权限和依赖关系。当前不作为独立平台模块。 |
| 电话客服 | `agent/presets/phone-support` 保存 Harness、对话理解及 preset 标识和初始定义。通用 runtime 不包含电话客服业务文件。 |
| Datasource | 连接元数据、所属权和 Schema/映射审核属于领域；MySQL/SSH 连接协议下沉 infrastructure。 |
| Text2SQL | ERP 指标、SQL 规划和修正归入领域；`metric.search`、`database.query` 分别靠近业务实现，`schema.search` 属于 Datasource。 |
| Model | 模型配置、选择、任务路由及权限在领域；网络 Provider 协议实现位于 infrastructure/llm。跨层模型协议在 shared/types/model。 |
| Knowledge | 文档处理、Embedding 编排和检索留在领域；Milvus/SQLite 向量驱动位于 infrastructure/vector-store。 |
| Conversation | 会话持久化、所有权和上下文窗口保持内聚；数据库文件路径和表结构不变。 |
| Auth / Organization | 认证、API Key 和资源权限属于 Auth；团队、成员及邀请路由属于 Organization。组织路由通过 `OrganizationAccounts` 窄接口调用账户聚合。 |
| Storage | 加密 JSON 文件适配器保持原 AES-GCM envelope、文件权限、key 路径及原子替换行为；数据源旧文件可直接读取。 |

账户与组织成员关系仍共同保存于原 `accounts.json`，由同一个 AccountStore 保证更新一致性。本次不拆该存储事务，不迁移 Schema，也不引入第二份成员数据。未来拆分组织业务实现需要先设计事务边界；当前边界止于 API 与窄接口，这是兼容性优先的有意选择。

`core/types.ts` 按身份、权限、会话、追踪等拆分；只下沉已有多个使用方的契约。不创建空的 utils/errors/constants 层。删除没有调用方的旧 AgentHarness 类型；现有 Sandbox 禁用宿主机执行的约束保持不变。

`app/`、`config/`、`db/`、`drizzle/`、`public/`、`examples/`、`worker/`、`build/` 和托管配置保持各自原有职责。当前仓库没有 deploy/Docker 配置，不为目录形式创建空壳。

## 测试与报告

- `tests/unit`：纯函数、协议、安全和组件源码约束测试。
- `tests/integration`：SQLite、Provider、文档/检索/Agent 组合测试、SSR 与 ERP mock 场景。
- `tests/api`：启动 HTTP server 的认证、权限、模型、知识库、会话、工作流、Datasource 和组织接口测试。
- `tests/e2e`：真实浏览器电话客服测试与 reporter。
- `reports/tests/{unit,integration,api,e2e,architecture}`：按需创建，保存正式 HTML/PDF/JSON 报告、日志和附件。
- `tmp`：登录态、隔离测试环境及报告渲染中间图片，不保存正式报告。

`npm test` 检查架构，运行 unit/integration/api，构建并验证 SSR。独立入口包括 `test:unit`、`test:integration`、`test:api`、`test:rendered`、`test:e2e:phone`。`test:rendered` 需要先构建。测试发现使用跨平台 Node 遍历，不依赖 shell 的 `**` 展开。

E2E 默认 headless；`DATAPILOT_E2E_HEADED=1` 可恢复可见浏览器。API 和网页地址仍由原 `DATAPILOT_E2E_API_URL`、`DATAPILOT_E2E_WEB_URL` 指定。临时登录态仍在 `tmp/playwright-phone-auth.json`。

`npm run check:compatibility` 是本次迁移的快照检查，比较重构前 99 个路由处理器、数据库 DDL、Schema 与构建/部署配置；未来有意变更业务协议时，应审查并更新测试 fixture。它不代替行为测试。

本次完整迁移清单位于 `reports/tests/architecture/migration-map.json`；验证结果及已知限制见同目录的 `refactor-report.html` 和 `refactor-report.pdf`。历史 ERP 和电话报告分别归档在 `reports/tests/integration`、`reports/tests/e2e`，不代表本次运行结果。

`npm run test:api:compare` ??????????? API ???? 27 ?????? `DATAPILOT_BASELINE_ENTRY` ??? checkout ? server/index.ts?????????? ignored tmp/refactor-baseline ???????????????????????????????
