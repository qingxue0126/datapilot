# DataPilot ERP Mock database

This fixture is deterministic (`seed=20260925`) and is isolated to the exact database name `datapilot_mock`. The reset script refuses to target any other database and never references `finance_db`.

## Rebuild

```powershell
npm run mock:erp:reset
```

Environment overrides are optional: `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, and `MYSQL_PASSWORD`. Defaults match the local acceptance environment (`127.0.0.1:3306`, `root`, `123456`).

## Contents

- `schema.sql`: nine ERP business tables plus an anomaly-case catalog.
- `seed.sql`: named negative/security fixtures and expected behavior.
- `generate-data.ts`: fixed-seed deterministic dimensions, vouchers, entries, receivables, and payables.
- `reset.ts`: guarded one-command database rebuild.
- `expected-results.json`: row counts, Golden Answers, expected entities, and expected joins.

Financial Golden Answers use `status='POSTED'`, functional-currency debit/credit columns, half-open date ranges, and these definitions:

- Operating revenue: account code prefix `6001`/`6051`, `credit_amount - debit_amount`.
- Period expense: `6601`/`6602`/`6603`, `debit_amount - credit_amount`.
- Receivable/payable balance: sum of direct balance table `balance` for posted rows.
- Void, draft, invalid-status and deliberately huge anomaly amounts are excluded.
