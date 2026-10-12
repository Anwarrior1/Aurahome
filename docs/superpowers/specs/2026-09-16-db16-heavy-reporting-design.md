# DB-16 Heavy Main-Process Reporting and Profitability Design

## Scope

DB-16 measures production financial/reporting reads that execute synchronously in Electron Main and remediates only paths whose measured scaling and blocking justify a change. DB-17 and DB-18 are excluded.

## Investigation map

The current Graphify graph identifies these production routes:

- renderer `useQuery`/`call` → closed preload API → guarded Main IPC handler;
- `profit.monthly`, `profit.withdrawals`, `dashboard.summary`, `cash.accounts`, `finalInvoices.list`, `production.listReleases`, `orders.profitability`, and `reports.build`;
- service SQL in profit, dashboard, cash, parties, final invoices, production, costing, and reports.

Repository source, schema, migrations, tests, query plans, and fresh runtime measurements remain authoritative over graph edges.

## Measurement design

Reuse the deterministic DB-10 fixture and its query counter. Add one DB-16 benchmark suite covering a small control, 10k orders, 100k orders, and a larger scale only when it clarifies the curve. Each candidate records warm-run median/p95, statement count, returned rows, serialized payload, heap/RSS observations where stable, dominant query plans, and synchronous elapsed time. SQL-only probes separate database cost from service transformation and JSON serialization where practical.

## Decision rule

Classify each operation as interactive, intentional complete report/export, bounded operational read, maintenance/startup, already adequate, or genuinely heavy. A path is not fixed merely because it is O(history), and fixed statement count is not treated as proof of responsiveness.

For a measured problem, stop at the first sufficient remedy: SQL shape, sargable predicate, justified index, set-based aggregation, reduced materialization, removed duplicate computation, or reduced JavaScript work. Do not add caches, materialized summaries, stored profit totals, workers, background services, new dependencies, secondary databases, or connection pools unless every simpler remedy remains insufficient after measurement.

## Correctness gates

Profit values must remain exactly equal to the established costing/profitability oracles across sales, refunds, reversals, COGS, materials, machines, labour, deliveries, direct/recurring expenses, payroll/reversal, savings, withdrawals, empty periods, historical periods, and current periods.

DB-15 remains invariant: report, dashboard, profit, balance, print, and export reads perform no financial writes; scheduled recurring occurrences remain numerically equivalent before and after authoritative posting.

## Verification

Repeat identical fixtures and probes after each production change. Run focused DB-16 tests, DB-02/05/10/12/13/14/15 regressions, the full test suite, typecheck, lint, and production build. Record methods, results, decisions, changed files, remaining risks, and final disposition in `DB16_FINAL_AUDIT.md`.
