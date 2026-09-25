<div align="center">

[简体中文](README.md) | **English**

# DataPilot: An Intelligent Data Agent for ERP Finance

**Connect enterprise databases and turn natural-language questions into secure, traceable financial analysis.**

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.13-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![MySQL](https://img.shields.io/badge/MySQL-5.7%2F8.x-4479A1?logo=mysql&logoColor=white)](https://www.mysql.com/)
[![DeepSeek](https://img.shields.io/badge/LLM-DeepSeek-4D6BFE)](https://www.deepseek.com/)
[![Text2SQL](https://img.shields.io/badge/Agent-Text2SQL-157A5B)](#what-is-datapilot)

[Overview](#what-is-datapilot) · [Product](#product-tour) · [Quick Start](#quick-start) · [Architecture](#architecture) · [Security](#security-and-access-control)

</div>

![DataPilot: Ask your data in natural language](public/og.png)

> DataPilot is a local-first Data Agent for ERP financial analytics. It combines identity and tenant validation, business-semantic understanding, schema and metric retrieval, SQL generation, safety validation, database execution, and result analysis in one extensible agent workflow.

## What is DataPilot?

Traditional BI requires dashboards to be designed in advance, while database clients require users to understand schemas and SQL. DataPilot bridges that gap: business users can ask questions such as “What were this month's revenue and expenses?”, while technical users can inspect schemas and run permission-controlled SQL in the database workbench.

The current release focuses on ERP finance and supports:

- Revenue, expenses, accounts receivable, accounts payable, and profit semantics;
- Year-over-year, month-over-month, trends, Top N, and multi-table queries;
- Direct MySQL connections and SSH private-key tunnels;
- Natural-language querying, result tables, lightweight charts, and generated SQL;
- Data-source management, a database workbench, and local query history;
- Tenant and account-set isolation with database, table, column, and row-scope permissions;
- Agent Loop, Tool Registry, Session/Context, and replaceable model adapters.

## Why DataPilot?

### Built for finance, not just SQL generation

DataPilot includes ERP metric semantics for revenue, expenses, receivables, payables, profit, YoY, and MoM analysis. The model works with the real schema, metric definitions, and recent conversation context to reduce queries that conflict with business definitions.

### Read-only by default

Natural-language data questions may generate only `SELECT` or `WITH ... SELECT`. The model cannot access a database connection directly—it can only invoke registered, policy-controlled tools. Database credentials are never added to the prompt.

### Tenant and account-set isolation

Every data source belongs to a tenant and an account set. Connection listing, schema access, SQL execution, and agent queries all validate ownership on the server rather than relying on hidden frontend controls.

### Extensible Agent Harness

Models, tools, permissions, sessions, ERP rules, and database drivers remain independent. New model providers and database tools can be added without rewriting the agent, and isolated Python or file-analysis sandboxes can be integrated later.

## Product Tour

![DataPilot product tour: data sources, database workbench, natural-language querying, and query history](docs/images/datapilot-features-overview.png)

### 1. Data-source management

Customers enter their own database host, port, database name, username, and password in the frontend. SSH private-key tunnels are optional. Connection credentials are persisted by the local service with AES-256-GCM encryption and are not stored in the browser.

### 2. Database workbench

Open a data source to browse tables and columns, query data in natural language, or run SQL directly. Write operations are available only to administrators and require explicit confirmation; analysts and viewers remain read-only.

### 3. ERP natural-language analytics

Business users do not need to understand the physical schema. The Data Agent retrieves relevant metrics and schema, generates SQL, validates it, executes it against the real database, and turns the result into an explanation, table, and optional chart.

### 4. Query history

Recent queries are retained locally in the browser and can be searched, reviewed, and reused together with their generated SQL and results.

## Agent Workflow

```mermaid
flowchart LR
    Q[User question] --> I[Identity / tenant / account-set validation]
    I --> M[ERP semantics and metric retrieval]
    M --> S[Permission-filtered schema retrieval]
    S --> G[LLM generates read-only SQL]
    G --> V[SQL AST and permission validation]
    V -->|Approved| T[Database Query Tool]
    V -->|Rejected| G
    T --> R[Real database result]
    R --> A[Result analysis and visualization]
    A --> O[Final answer]
```

An agent run can make up to three SQL correction attempts. Every step records its status and duration, making model-generation, permission, and database failures easier to diagnose.

## Architecture

```text
app/                         React / vinext user interface
server/
├── agent/                   Agent Loop and Harness
├── auth/                    Identity, roles, and fine-grained permissions
├── context/                 Session / Context interfaces
├── domain/erp/              Finance metrics and ERP Text2SQL rules
├── llm/                     Replaceable model adapters
├── security/                SQL parsing and safety policies
├── tools/                   Tool Registry and database tools
├── sandbox/                 Reserved Python / file-analysis interface
├── connection-store.ts      Encrypted data-source persistence
├── database.ts              MySQL / SSH access layer
└── index.ts                 HTTP API and dependency assembly
```

See [docs/architecture.md](docs/architecture.md) for the current detailed design.

## Quick Start

### Requirements

- Node.js `>= 22.13.0`—Node.js 22 LTS is recommended;
- npm;
- An accessible MySQL 5.7 or 8.x database;
- A DeepSeek API key.

### 1. Clone and install

```bash
git clone https://github.com/qingxue0126/datapilot.git
cd datapilot
npm install
```

### 2. Configure the model

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Configure at least the following values in `.env`:

```dotenv
DEEPSEEK_API_KEY=your-api-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat

API_PORT=3001
WEB_ORIGIN=http://localhost:3000
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
QUERY_MAX_ROWS=200
```

Database hosts, usernames, passwords, and SSH keys are entered by customers in the DataPilot frontend and do not belong in `.env`.

### 3. Run locally

```bash
npm run dev
```

Then open:

- Web UI: <http://localhost:3000>
- API: <http://localhost:3001>
- Health check: <http://localhost:3001/api/health>

### 4. Connect a database and ask questions

1. Open **Data Sources** and select **Add Data Source**;
2. Enter the customer's MySQL connection details and optionally enable SSH;
3. Test and save the connection;
4. Open **Data Q&A** and ask questions such as:

```text
What were this month's revenue and expenses?
Show the monthly profit trend for this year.
How did accounts receivable change year over year this quarter?
List the ten largest vouchers by amount.
```

## Security and Access Control

| Layer | Current implementation |
| --- | --- |
| Identity | Fixed demo identity for local development; HS256 JWT in production mode |
| Tenant isolation | Every data source is bound to `tenantId + accountSetId` and checked per request |
| Roles | `tenant_admin`, `finance_analyst`, and `finance_viewer` |
| Database access | Administrators may use guarded writes in the workbench; other roles are read-only |
| Table access | `allowedTables` allowlist |
| Column access | `deniedColumns` denylist; `SELECT *` is rejected when columns are restricted |
| Row scope | Query predicates are checked against table, column, and allowed-value rules |
| SQL safety | AST parsing, single-statement enforcement, and DDL/DML and dangerous-function blocking |
| Credential storage | AES-256-GCM encryption under `.data/`, excluded from Git |

For production, configure `AUTH_JWT_SECRET` and use `DATAPILOT_PERMISSION_RULES_JSON` to define policies per tenant, account set, and role. See the [architecture document](docs/architecture.md#隔离和权限) for an example.

## Commands

```bash
npm run dev          # Start Web and API together
npm run dev:web      # Start only the frontend
npm run dev:api      # Start only the API
npm run test:server  # Run server-side SQL security tests
npm run build        # Verify the production build
npm run lint         # Run ESLint
```

## Status and Roadmap

| Capability | Status |
| --- | --- |
| Direct MySQL / SSH tunnel | ✅ Available |
| ERP finance Text2SQL | ✅ Available |
| Tool Registry / Agent Loop | ✅ Available |
| Multi-tenant, role, and fine-grained data permissions | ✅ Foundation available |
| Result tables and lightweight charts | ✅ Available |
| PostgreSQL / SQL Server / Oracle | 🗓️ Planned |
| Persistent sessions and audit center | 🗓️ Planned |
| Python sandbox / file analysis | 🧩 Interface reserved |
| Metric and semantic-layer management UI | 🗓️ Planned |

## Project Principles

- Secure by default: intelligent data questions are always read-only;
- Real execution: answers must be based on real database query results;
- Least exposure: the model sees only authorized schema and result data;
- Modular design: agent, model, database, permission, prompt, and business rules evolve independently;
- Local first: the current release runs locally and is not deployed automatically.

## Acknowledgements

The README structure and Agentic Data Assistant framing were inspired by [DB-GPT](https://github.com/eosphoros-ai/DB-GPT). DataPilot's architecture and implementation remain focused on its current ERP finance workflow.

## Contributing

Issues, business metric suggestions, and feature requests are welcome in [GitHub Issues](https://github.com/qingxue0126/datapilot/issues).

