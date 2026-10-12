# AURA HOME ERP — PERFORMANCE AUDIT

Audit date: 2026-10-09. macOS; audit only; no remediation. Evidence directory: `/tmp/aura-performance-audit/`. BDR-01 remains OPEN; BDR-02 remains VERIFIED CLOSED.

## 1. Executive verdict

**PARTIAL audit coverage; ready for owner review.** Actual compiled Electron, production preload, registered IPC, session guards and real service/SQLite workloads were exercised across S, M and L fixtures. Three reproducible findings: **one MEDIUM and two LOW**, with no confirmed CRITICAL or HIGH finding. No financial-integrity failure or unauthorized mutation was observed in the valid benchmark fixtures.

Current gates: **3,611/3,611 tests, 278/278 files, zero failures/skips/unhandled errors; typecheck, lint and build PASS.** Fresh and populated fixtures: 53 migrations, integrity `ok`, zero foreign-key violations, all 73 reconciliation checks and zero errors/warnings. These are newly executed results.

Coverage is partial because XL, multi-hour soak, Windows-native execution, physical disk I/O profiling, native file pickers and several specialized financial/user workflows were not measured. No performance SLO was supplied or discovered in the reviewed contracts. Measured responsiveness and scaling inform risk; they are not invented pass/fail product targets. No application-wide stability or release-readiness claim is made.

The principal result is the gap between bounded pages and full reports: 10,034 customer-report rows generated 70,473 live DOM elements, 852.26 ms median visible completion, long tasks up to 630 ms in the medium session, and renderer working set reaching 1,142.5 MiB after repeated report switching. Ordinary customer pages remained bounded to 50 rows. Three large-fixture search bursts each emitted 13 registered requests and occupied about 427 ms of main-handler time.

## 2. Environment and reproducibility

MacBookAir10,1; Apple M1, 8 cores; 16 GiB RAM; arm64. macOS 26.5.2 (25F84), Darwin 25.5.0. APFS: 228 GiB total, 174 GiB used, 30 GiB available at baseline. Local SSD, no external/network drive benchmark. Node 24.17.0; Electron 43.6.0; better-sqlite3 13.0.3 / SQLite 3.53.4; React 18.3.1; Drizzle 0.33.0; Vitest 2.1.9; Vite 5.4.21; electron-vite 2.3.0; Playwright 1.63.0; application 0.1.0. Unpackaged compiled macOS runtime, not a signed installer.

Workspace: `/Users/macbook/Documents/Claude/abdulhadi`. `git status --short` returned exit 128: no repository. No GitHub or Windows dependency was introduced. No private userData or real customer database was opened. All business data was fictional and generated through existing services with their audits and transactions.

Compiled identity: `out/main/index.js` SHA-256 `941aeccce10d0bac14cc31992e1c092d08ebf39fa26439d378d5a3cfda020120`; preload `d4d0def0b98e03f884abc424199d4995da940495c5a346f73a66f56a60388d58`. Full build/resource hashes and dependency versions: [environment.json](/tmp/aura-performance-audit/environment.json).

Benchmarks ran after test/build processes finished. Gates overlapped one another and their durations are validation durations, not performance benchmarks. Machine-cold caches were not forced; no global cache purge or forced GC was used. Background OS load and thermal state were not independently controlled. Absolute numbers are local observations, not hardware-independent guarantees.

All harnesses, SQLite files, archives, screenshots and logs are outside the project. Reproduction uses the existing installed dependencies and `vitest.config.ts` aliases:

```sh
npx vite-node --config vitest.config.ts /tmp/aura-performance-audit/services.ts
node /tmp/aura-performance-audit/electron.mjs
node /tmp/aura-performance-audit/electron-large.mjs
npx vite-node --config vitest.config.ts /tmp/aura-performance-audit/runtime-health.ts
npx vite-node --config vitest.config.ts /tmp/aura-performance-audit/backup-control.ts
npx vite-node --config vitest.config.ts /tmp/aura-performance-audit/concurrent.ts
node /tmp/aura-performance-audit/clean-startup.mjs
npx vite-node --config vitest.config.ts /tmp/aura-performance-audit/fresh-health.ts
npx vite-node --config vitest.config.ts /tmp/aura-performance-audit/procurement.ts
```

Use new isolated output directories on replay; existing backups intentionally reject filename collisions. `run.py` records exact commands, exits and monotonic wall durations. The first Electron script completed S/M; the second completed L using a longer bounded observation window and retained S/M evidence. Native save/open picker selection was supplied by the external wrapper, not verified as native-dialog UI.

## 3. Source and report evidence reviewed

Reviewed current owners and relevant evidence at their actual locations:

- `BDR/BACKUP_DISASTER_RECOVERY_AUDIT.md`, `BDR/BDR_02_FINAL.md`, `BDR/BDR_01_FINAL.md`, Phase 1/1B and security-design reports, and `BDR/E2E_02_03_TEST_ALIGNMENT_FINAL.md`.
- `DB AUDITS/`: DB-08 inflight/restore lifecycle, DB-09 streaming/scale, DB-10/13/14/16/18 database/financial/startup evidence.
- `E2E/END_TO_END_WORKFLOW_AUDIT.md` and E2E-01/02/03 final reports.
- `security audit/`: original audit and SEC-01 through SEC-04 closure reports.
- `Frontend/`: workflow audit, UI-WF-04 capability evidence and related closures/Contract C evidence.
- `BE-BL AUDITS AND FIXES/`: business audit, financial projection ownership, required-audit atomicity and date contracts.

Historical metrics were not copied into new benchmark results. The current full suite exceeds the historical baseline. Existing DB-10 raw synthetic financial seeds and tuning pragmas were not used: this audit's workloads use actual business services. Existing query instrumentation was used only in separate trace calls, not to replace authoritative calculations or persistence.

## 4. Ponytail FULL ownership traces

Every measured family follows its real owner; service-only segments are explicitly distinguished from compiled UI/IPC.

| Workflow | Actual chain and ownership | Synchronous work / effects / completion |
|---|---|---|
| Startup | `src/main/index.ts:13` bootstrap → single instance/ready → local protocol/directories → `app/database-startup.ts:17 openVerifiedDatabase` → router → `windows/main-window.ts` → compiled preload/renderer | Interrupted-restore/migration handling, pending migrations/cutovers and due recurring posting precede business IPC/window. Startup error catch exits; no cold recovery added. |
| Login | `LoginPage` → fixed `build-api.ts` auth.login → `ipc/router.ts` → `auth/auth.service.ts` → password verification/roles → required audit/auth persistence → WebContents-bound session → dashboard | `scryptSync` is intentionally synchronous; audited commit precedes publication (SEC-04). Response then React layout/dashboard. Password hashing was not bypassed for timing. |
| Customers/search | `CustomersPage.tsx:47,114` state → `lib/usePagedQuery.ts:31` → fixed customers.list → router/guard → `parties.service.ts:59` → count + keyset window + bounded balance enrichment → DTO → table | Default 50 visible rows. Search updates each input event. Sequence token suppresses stale UI updates, not main-process execution. Read-only; no audit expected for reads. |
| Receivables/report | `ReportsPage.tsx:12` selection → `useQuery` → reports.build → permission-bound authorized report → `reports.service.ts:81`/`parties.service.ts:212,236` → aggregates/sort → formatted complete DTO → `DataTable` | `components/ui/index.tsx:200 rows.map` renders the entire returned report; no report pagination/virtualization. Service formatting, IPC transfer and DOM work measured separately. |
| Suppliers/materials | Real sidebar routes → fixed named list APIs → session/permission guard → parties/catalog services → SQLite → component state/DataTable | Measured 10/100/1,000 supplier and material rows. These lists remain unbounded in the exercised UI; SQL time is not their full visible latency. |
| Orders/invoices/quotations | Actual editors/lists → fixed API → registered schemas/guards → sales services → `sales/document-totals.ts`/shared scaled arithmetic → transaction/source rows/audit → list refresh | Creation/approval produces an order through the authoritative owner. Minor units 1,000/LYD, quantity micro scale 1,000,000. Half-minor IPC invoice persisted 15 minor units. |
| Payments/refunds/expenses | Order/expense actions → fixed registered IPC → guards → sales/finance service → `withTransaction` → source + cash mirror + required audit → projections → refresh | Main-thread synchronous SQLite commits preserve atomicity/idempotency; no raw financial writes used in benchmark journeys. |
| Purchasing/FIFO | Existing purchase service → transaction → purchase lines/payment/mirror/FIFO lots/movements/audit; worksheet issue → production service → inventory owner → `layersForConsumption` → first-fit allocations/source costs | 20/200/2,000 legitimate lots. Actual consumption records 2,000 minor cost for one unit in seed journeys. Completed material history remains frozen. Timed procurement writes also validated independently. |
| Manufacturing/delivery | Invoice approval → payment → worksheet → FIFO consumption → completion → release → handover → SQLite/audit and projections | Ten timed real-service journeys per tier; only list navigation was exercised through UI. These are not complete real-UI manufacturing journeys. |
| Workers | `WorkersPage.tsx:72` → fixed workers.list → guard → `workers.service.ts:43` master query → `workerBalances:66` for each row | Payable/debt remain separate CC04 ledgers. Measured N+1 read pattern; recognized commissions and valid payments came from existing service writers during fixture creation. |
| Dashboard/cash/profit | Real routes → named APIs → trusted permissions → dashboard/cash/profit owners → shared authoritative aggregates → bounded dashboard DTO / report DTO → state | Dashboard trace: 14 SQL executions; cumulative profit: 6. No alternative financial formula used. |
| Backup | BackupPage → fixed preload → router backup.create (backup.create permission) → `backup.service.ts:122` → WAL checkpoint/VACUUM INTO/fsync/snapshot integrity/FK → hash + snapshot recordCounts → streaming archive → validation → nonoverwrite publication → operational audit → UI feedback | Snapshot and SQLite checks have synchronous phases; hashing/compression stream asynchronously. Same snapshot supplies all twelve manifest counts (BDR-02). Scratch handles/connections closed in finally. |
| Healthy restore | BackupPage preview/confirmation → backup.validate/restore guarded IPC → `restore.service.ts:59` → bounded candidate validation/token purge → exclusive admission/drain → protected safety snapshot/markers → close/swap/verification → sessions/remember-file invalidated → login | Existing DB-08 epoch/sidecar safety preserved. Requires a usable live DB; not BDR-01 cold recovery. Compiled UI measured restore through return to login, then fresh login and restart. |

`src/main/db/pragmas.ts`: WAL, FK ON, synchronous FULL, busy timeout 5,000 ms, trusted_schema OFF. One persistent main-process connection; source transactions are synchronous. `ipc/guard.ts:43 createHandler` validates schemas, resolves trusted session/permission, enforces restore admission and rechecks asynchronous session state. No generic invocation, direct renderer SQLite or new filesystem capability was introduced.

## 5. Graphify baseline, queries and diagnostics

Executed and awaited `graphify update .` and `graphify diagnose multigraph` before benchmarks and again at completion, exit 0. Baseline update 17.753 s, diagnosis 1.640 s; completion update 14.980 s and diagnosis 1.253 s.

| Metric | Baseline | Final |
|---|---:|---:|
| Nodes | 7,125 | 7,125 |
| Edges / valid candidates | 13,732 | 13,732 |
| Communities | 407 | 407 |
| Unverified code nodes | 0 | 0 |
| Missing / dangling endpoints | 0 / 0 | 0 / 0 |
| Exact duplicate edges | 0 | 0 |
| Directed / undirected endpoint collapses | 0 / 0 | 0 / 0 |
| Self loops | 32 | 32 |
| Producer-suppression sites | 12 | 12 |

The normal JSON is a post-build undirected `Graph`; zero endpoint collapse does not prove no earlier producer suppression. Existing 32 loops and 12 producer sites remain; no new source topology was introduced. Baseline label refresh changed prior 399 community labels to 407 and refreshed hub labels; final update explicitly reported no code-graph topology change.

Queries for backup/restore/startup, renderer/lists, and finance/FIFO/reporting were bounded: 37/177, 41/124 and 44/558 nodes shown. Truncation was resolved using exact owner call-edge inspection and direct source reads, not extrapolation. Evidence: [graph-query-backup.txt](/tmp/aura-performance-audit/graph-query-backup.txt), [graph-query-ui.txt](/tmp/aura-performance-audit/graph-query-ui.txt), [graph-query-finance.txt](/tmp/aura-performance-audit/graph-query-finance.txt), [graph-owner-edges.json](/tmp/aura-performance-audit/graph-owner-edges.json). Exact owner edges inspected: bootstrap 9, openVerifiedDatabase 9, createHandler 8, listCustomers 6, customerBalances 3, buildReport 15, consumeForOrder 2, listWorkers 2, snapshotDatabase 5, restoreFromBackup 33.

Eight unsupported assets/config formats were skipped by AST extraction, including font/CSS files. Graph output uses an aggregated visualization above 5,000 nodes. Graph connectivity is navigation evidence, not timing, authorization or accounting proof.

## 6. Dataset tiers and actual counts

| Tier | Customers | Orders | Expenses | FIFO lots | Worksheets | Worker TX | Cash TX | Audit rows | All table rows | Initial DB MiB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S | 1033 | 110 | 60 | 20 | 20 | 11 | 166 | 1739 | 4112 | 2.14 |
| M | 10033 | 1010 | 510 | 200 | 60 | 51 | 1266 | 15309 | 33872 | 10.97 |
| L | 100033 | 10010 | 5010 | 2000 | 110 | 101 | 12091 | 148034 | 324647 | 98.55 |

Counts above are the service fixture after its timed journeys, backups and final restore, before the compiled UI mutations. All-table sums include audit/system/configuration rows; they are not all business entities. There are 85 SQLite tables. S/M/L had 10/100/1,000 workers, suppliers and materials. Initial approved orders: 100/1,000/10,000; completed seed manufacturing: 10/50/100. Timed journeys added ten completed orders per tier. Quotes: ten half-minor examples per tier. Not every entity independently reached 100,000 records.

Fixture generation through real services took 0.852 / 6.902 / 64.641 seconds. Those are seed-batch durations, not per-operation production latency. Each tier begins with a 100,000,000-minor cash opening balance. Every purchase received ten units at 2 LYD/unit and paid 20,000 minor. Completed seeded worker commissions were 10,000 minor/order and paid exactly once. Financial/FIFO oracles were derived from these fixture facts.

Compiled UI added one customer and one 1-LYD expense per tier; ten separate IPC commercial journeys added ten orders, payments/refunds and expenses. The medium soak added 452 customers only. These later counts and exact business hashes are in runtime-health.json. A separate procurement copy received ten new paid purchases per tier. XL (500,000+ business records) was NOT TESTED; the sustained large seeding memory/caching confound and available memory justified bounded coverage. No invalid synthetic financial rows were inserted to force a larger tier.

## 7. Measurement protocol and limitations

Elapsed timings use monotonic `performance.now()`; percentile calculation is nearest-rank. p50/p95/max and raw samples are retained. p99 is reported only for at least 100 samples. With three or ten trials, p95 is the sample maximum and is not a reliable population tail estimate. No universal SLO was invented.

| Scenarios | Evidence | Workload / principal | Warm-up / trials / scope |
|---|---|---|---|
| P-01/02/03 | REAL_ELECTRON / REAL_SERVICE_SQLITE | Fresh setup and populated startup; no principal until login | Three fresh installations; three populated process restarts/tier; ten DB close/reopen trials/tier, OS cache warm. |
| P-04 | REAL_UI_ELECTRON | Owner password login → authenticated/dashboard readiness | Six/six plus repeated medium logins (25 total); password verification unchanged. |
| P-10 | REAL_UI_ELECTRON | Twelve sidebar routes, actual tables/search/dialog saves | Three navigation passes/tier; medium soak adds repeats; visible completion after handler, loading removal and two animation frames. |
| P-20/21 | REAL_IPC_ELECTRON | Owner and restricted employee; fixed permitted reads | One warm-up, 100 samples/read; complete reports ten samples. Batch widths 1/4/16, ten batches each. |
| P-30 | REAL_SERVICE_SQLITE / REAL_SQLITE | 24 read families per tier, exact SQL/plans | One warm-up, 30 samples; reports ten. One separate instrumented trace per family plus representative bound-parameter plans. |
| P-40/41/42 | REAL_SERVICE_SQLITE / REAL_IPC_ELECTRON / REAL_UI_ELECTRON | Manufacturing/commercial journeys, commercial finance IPC, customer/expense UI saves | Ten real-service journeys/tier; ten actual IPC journeys/tier; one customer/expense UI save per tier; ten paid procurement writes/tier. No mutating warm-up. |
| P-50/51/52 | REAL_SERVICE_SQLITE / REAL_UI_ELECTRON | Backup/validate/healthy restore and live write overlap | Three service backups/validations/restores per tier; one UI backup/restore per tier; independent-process writer barrier; one controlled lock experiment. |
| P-60 | SOAK / REAL_UI_ELECTRON | Medium owner navigation + customer create + periodic backup/validation/logout/login | 180.265 seconds, 452 cycles. Bounded by time and 1,000 cycles; no arbitrary measurement sleeps. |

Service time includes transaction, required audit and projections within that actual function. SQL time is separately traced statement execution and excludes React/IPC. Trace calls are separate from primary latency samples; existing `.iterate()` timing is not presented as full cursor execution time. UI timings include automation/actionability and two animation frames and cannot be read as pure render CPU. `page.evaluate` IPC timers end at the fixed API response, before external transport of observations; payload serialization/observation overhead may affect subsequent GC. Large repeated reports in the L repeat avoid returning complete DTOs to the Node observer.

The external main wrapper observes actual registered handlers; it does not substitute service, session or guards. SQL ring is capped at 2,000 entries, IPC ring at 5,000; total counters remain complete. Instrumentation still has overhead. Main SQL channel labeling is approximate for overlapping async handlers; exact SQL plans/service traces are the primary query evidence. Native dialogs were substituted only for path selection.

Resource samples: Electron process CPU/working set, Node RSS/heap, CDP heap/node metrics, descriptors and owned DB/WAL/tmp sizes. Interval RSS sampling can miss synchronous peaks. CDP task/layout counters reset on new instrumentation sessions and are not treated as session-wide totals. Physical disk bytes/sec, native I/O queue depth and exact dropped-frame rate were NOT TESTED. Node resourceUsage fsRead/fsWrite were zero on this platform and are not evidence of zero I/O.

Initial harness-only failures are retained: missing config directory setup, an external `require` observation error, main-evaluate argument binding, wrong observed worksheet channel, create DTO versus read-back DTO, same-route navigation expecting a new IPC, and temporary filename collision. These are not production defects. The L restore's first five-second observation timeout is also retained; a fresh isolated L repeat with a 60-second observation ceiling completed in 8.48 seconds. No existing test threshold or application behavior changed. Raw failed artifacts/logs remain under the external evidence directory; only completed valid runs supply the principal tables.

## 8. Startup and login metrics

| Tier | Process→login DOM ms p50/p95 | Verified DB reopen ms p50/p95 | Login→ready ms p50/p95 | Login trials | Clean close ms p50/p95 |
| --- | --- | --- | --- | --- | --- |
| S | 779.24 / 796.04 | 10.41 / 11.31 | 187.58 / 208.25 | 6 | 150.79 / 155.00 |
| M | 782.70 / 789.68 | 32.18 / 33.29 | 177.43 / 233.10 | 25 | 136.80 / 155.28 |
| L | 1,130.91 / 1,141.04 | 373.06 / 375.85 | 209.81 / 269.66 | 6 | 152.73 / 154.77 |

Three fresh databases reached setup UI in **1,166.66 / 1,166.74 ms p50/p95**; actual fixed setupStatus returned `needsSetup: true`. They were newly migrated by the compiled application, not copied initialized fixtures. Setup account creation itself was not benchmarked. Screenshot: [clean-startup.png](/tmp/aura-performance-audit/clean-startup.png).

Approximate mean internal intervals (n=3 per populated tier):

| Tier | Entry→ready ms | Ready→first IPC ms | First IPC→window ms | Window→DOM ms | Window→ready-to-show ms |
| --- | --- | --- | --- | --- | --- |
| S | 207.32 | 33.64 | 96.58 | 150.46 | 179.71 |
| M | 208.50 | 54.57 | 90.42 | 157.76 | 158.40 |
| L | 208.70 | 387.66 | 92.05 | 154.70 | 167.02 |

Ready→first IPC includes protocol/directories and verified DB startup; it is not pure SQLite execution. Parent launch→DOM includes process/automation startup. DOM and ready-to-show are different readiness events. All populated process restarts reopened correct data. Login main handlers took about 85–91 ms in sampled calls, chiefly intentional password verification and audited authentication commit; IPC transport and UI/dashboard completion explain the larger visible times. No startup failure occurred in healthy audit fixtures. Corrupt startup was not retested or repaired (BDR-01 remains open).

## 9. Renderer/UI latency

| Visible operation | S ms p50/p95 | M ms p50/p95 | L ms p50/p95 |
| --- | --- | --- | --- |
| / | 64.92 / 65.45 | 79.76 / 79.86 | 112.89 / 113.91 |
| /customers | 93.42 / 93.73 | 80.68 / 83.00 | 89.00 / 120.81 |
| /suppliers | 90.33 / 91.20 | 80.83 / 81.15 | 286.59 / 352.15 |
| /materials | 95.65 / 97.24 | 109.85 / 110.06 | 516.21 / 517.77 |
| /orders | 92.93 / 93.42 | 78.01 / 85.29 | 164.76 / 173.45 |
| /quotations | 93.77 / 93.96 | 76.97 / 77.62 | 94.43 / 110.80 |
| /final-invoices | 95.10 / 95.31 | 79.47 / 80.10 | 146.11 / 146.15 |
| /worksheets | 91.31 / 91.38 | 81.28 / 81.84 | 103.23 / 103.81 |
| /expenses | 92.68 / 93.04 | 82.57 / 83.51 | 104.64 / 120.26 |
| /cash | 94.61 / 95.01 | 79.32 / 85.26 | 94.54 / 94.90 |
| /profit | 94.59 / 95.13 | 78.28 / 78.28 | 95.15 / 95.56 |
| /backup | 60.20 / 72.86 | 83.41 / 156.24 | 71.81 / 88.64 |
| customers.search.typing | 67.13 / 90.12 | 126.25 / 129.11 | 508.34 / 509.04 |
| customer.save.refresh | 82.92 / 82.92 | 89.33 / 89.33 | 103.47 / 103.47 |
| expense.save.refresh | 104.85 / 104.85 | 102.43 / 102.43 | 141.58 / 141.58 |
| report.customer_balances | 103.71 / 113.30 | 852.26 / 885.42 | NOT TESTED |

Navigation uses real sidebar buttons/links, not direct route mutation. Customer/expense save includes modal dismissal and refreshed page completion. Single-save measurements have n=1 and provide no tail claim. Medium customer/order/cash navigation includes hundreds of soak repetitions; other route samples are three or four.

Customer report S: 1,034 rows; M: 10,034 rows / 70,473 live DOM elements; L full report DOM deliberately NOT TESTED. L suppliers/materials rendered 1,000 rows and took 286.59/516.21 ms median despite fast service queries. Complete table rendering and selection processing dominate those visible list timings; no React flamegraph or exact rerender attribution was captured.

Long-task observation began after initial window load, so startup long tasks are unmeasured. Session counts/max: S 3/57 ms; M 10/630 ms; L 12/246 ms. No precise dropped-frame count was measured. Report screenshots visually inspected: [report-S.png](/tmp/aura-performance-audit/report-S.png), [report-M.png](/tmp/aura-performance-audit/report-M.png); normal runtime screenshots [normal-S.png](/tmp/aura-performance-audit/normal-S.png), [normal-M.png](/tmp/aura-performance-audit/normal-M.png), [normal-L.png](/tmp/aura-performance-audit/normal-L.png).

Recorded primary runs: **2,656 explicit UI actions** (click/fill/select/navigation action records; character typing counts as one recorded action), **5,683 instrumented real registered IPC calls**. Fresh-startup smoke added three explicit setupStatus calls separately; its automatic startup IPC calls were not included in that counter. Service calls and failed preliminary harness attempts are not counted as UI proof.

## 10. IPC throughput and concurrency

| Fixed permitted request | S ms p50/p95 | M ms p50/p95 | L ms p50/p95 | n per tier |
| --- | --- | --- | --- | --- |
| Customers page | 1.10 / 1.40 | 1.30 / 1.60 | 3.40 / 3.80 | 100 |
| Customer miss search | 0.70 / 0.80 | 3.60 / 3.70 | 33.90 / 34.20 | 100 |
| Cash accounts | 0.30 / 0.40 | 0.60 / 0.70 | 3.20 / 3.20 | 100 |
| Orders page | 1.70 / 1.80 | 1.60 / 1.90 | 1.50 / 1.70 | 100 |
| Dashboard | 2.40 / 2.60 | 3.20 / 3.50 | 18.20 / 18.70 | 100 |
| Full customer report | 6.40 / 6.50 | 54.70 / 56.30 | 511.60 / 570.30 | 10 |
| Employee customer page | 1.10 / 1.40 | 1.30 / 1.60 | 3.70 / 4.10 | 100 |

| Tier | Width | Batch ms p50/p95 | Request ms p50/p95 | Observed requests/sec |
| --- | --- | --- | --- | --- |
| S | 1 | 0.90 / 1.10 | 0.90 / 1.10 | 1,063.83 |
| S | 4 | 2.80 / 3.80 | 1.80 / 3.00 | 1,346.80 |
| S | 16 | 9.90 / 10.70 | 5.70 / 9.80 | 1,598.40 |
| M | 1 | 1.20 / 1.40 | 1.20 / 1.40 | 826.45 |
| M | 4 | 3.90 / 4.60 | 2.80 / 3.90 | 1,030.93 |
| M | 16 | 13.50 / 50.80 | 7.80 / 43.40 | 921.13 |
| L | 1 | 3.50 / 4.70 | 3.50 / 4.60 | 277.01 |
| L | 4 | 12.50 / 13.20 | 7.00 / 12.60 | 317.71 |
| L | 16 | 48.00 / 48.80 | 24.70 / 47.80 | 332.29 |

Hundred-sample p99 values are retained in electron.json; no p99 is claimed for the ten complete reports. Batch requests use Promise.all in the real renderer; synchronous main SQLite work remains serialized. Width 16 increases queue latency and provides little large-fixture throughput improvement. Medium width-16 maximum batch 50.80 ms is retained, not discarded. This is bounded read-batch throughput, not a sustained maximum-server capacity claim.

Owner/restricted employee comparisons retain actual guards. Employee cash.accounts, customers.create and backup.create each returned FORBIDDEN with no forbidden archive/business mutation. After healthy restore, the old session's protected cash read returned UNAUTHENTICATED; fresh login was required. Guard overhead was not isolated by bypassing security, so it cannot be derived simply by subtracting separately warmed service medians.

Payload observations: 50-row customer page about 12,851–12,853 JSON characters; full customer report about 136,808 / 1,335,609 / 13,413,610 characters. UTF-8 service serialization is separately larger (Arabic labels/text). No generic IPC or recovery channel was introduced. Recovery-prefixed channels were absent in every observed normal startup.

## 11. SQLite query plans and latency

| Actual service read (includes mapping) | S ms p50/p95 | M ms p50/p95 | L ms p50/p95 | SQL executions S/M/L |
| --- | --- | --- | --- | --- |
| customers.page | 0.50 / 0.70 | 0.68 / 0.72 | 2.84 / 2.93 | 3 / 3 / 3 |
| customers.search.hit | 0.66 / 0.68 | 3.83 / 3.88 | 36.14 / 36.81 | 3 / 3 / 3 |
| customers.search.miss | 0.49 / 0.50 | 3.34 / 3.36 | 33.52 / 33.98 | 2 / 2 / 2 |
| customers.balances.page | 0.95 / 0.98 | 8.42 / 8.54 | 105.65 / 109.00 | 1 / 1 / 1 |
| suppliers.page | 0.07 / 0.09 | 0.16 / 0.17 | 1.13 / 1.16 | 1 / 1 / 1 |
| orders.page | 0.76 / 0.84 | 0.74 / 0.92 | 0.75 / 0.86 | 2 / 2 / 2 |
| invoices.page | 1.20 / 1.29 | 2.05 / 2.21 | 33.19 / 33.34 | 3 / 3 / 3 |
| quotations.page | 0.14 / 0.17 | 0.13 / 0.15 | 0.13 / 0.14 | 1 / 1 / 1 |
| expenses.page | 0.30 / 0.33 | 0.36 / 0.37 | 1.05 / 1.07 | 3 / 3 / 3 |
| cash.accounts | 0.12 / 0.15 | 0.37 / 0.39 | 2.92 / 2.95 | 2 / 2 / 2 |
| cash.transactions | 0.22 / 0.24 | 0.20 / 0.21 | 0.20 / 0.22 | 1 / 1 / 1 |
| materials.list | 0.21 / 0.22 | 0.46 / 0.49 | 3.14 / 3.26 | 2 / 2 / 2 |
| inventory.stock | 0.05 / 0.08 | 0.13 / 0.16 | 0.97 / 1.00 | 1 / 1 / 1 |
| inventory.valuation | 0.08 / 0.11 | 0.22 / 0.25 | 1.54 / 1.67 | 1 / 1 / 1 |
| inventory.movements | 0.43 / 0.47 | 1.43 / 1.46 | 8.50 / 8.63 | 2 / 2 / 2 |
| production.worksheets | 0.17 / 0.19 | 0.26 / 0.28 | 0.27 / 0.29 | 1 / 1 / 1 |
| workers.list | 0.37 / 0.40 | 2.99 / 3.12 | 29.14 / 34.84 | 11 / 101 / 1001 |
| profit.monthly | 1.06 / 1.18 | 1.29 / 1.35 | 3.03 / 3.45 | 8 / 8 / 8 |
| profit.cumulative | 0.81 / 0.86 | 0.97 / 1.01 | 1.96 / 2.04 | 6 / 6 / 6 |
| dashboard.owner | 1.43 / 1.58 | 2.18 / 2.25 | 18.33 / 18.65 | 14 / 14 / 14 |
| report.customers | 2.81 / 2.95 | 28.12 / 30.98 | 311.43 / 389.81 | 1 / 1 / 1 |
| report.orders | 0.31 / 0.40 | 2.44 / 2.53 | 31.51 / 41.97 | 1 / 1 / 1 |
| report.expenses | 0.14 / 0.23 | 0.74 / 0.78 | 6.39 / 6.47 | 2 / 2 / 2 |
| report.profitability | 0.34 / 0.46 | 0.90 / 0.93 | 8.00 / 8.31 | 3 / 3 / 3 |

Exact SQL, bound parameters, EXPLAIN QUERY PLAN and individual trace execution durations: [services.json](/tmp/aura-performance-audit/services.json) → tier.plans / measures.dominant. Primary service measurements above are not labeled SQL-only timings.

Representative plans:

```text
customers page count: SEARCH customers USING COVERING INDEX customers_lifecycle_name_idx (active=?)
customers page window: SEARCH customers USING INDEX customers_lifecycle_name_idx (active=?)
bounded balance enrichment: SEARCH c USING INTEGER PRIMARY KEY (rowid=?);
  SEARCH o USING INDEX orders_customer_idx (customer_id=?) LEFT-JOIN
miss search count/window: SEARCH customers USING INDEX customers_lifecycle_name_idx (active=?)
receivables ranking: CO-ROUTINE b; SCAN c;
  SEARCH o USING INDEX orders_customer_idx (customer_id=?) LEFT-JOIN;
  SCAN b; USE TEMP B-TREE FOR ORDER BY
full order report: SCAN o; SEARCH c USING INTEGER PRIMARY KEY (rowid=?)
```

Search binds `%NO-MATCH-PERF%` to name and phone. The active index limits lifecycle state but cannot selectively seek that infix string; count and result queries both inspect active candidates. Empty result still requires both scans. Receivables page SQL aggregates/ranks the full customer population before `LIMIT 51`; returning 50 rows is not bounded aggregate work. L receivables service: 105.65/109.00 ms. Existing plans also contain q/o/f history subqueries; the exact emitted plan, not an assumed correlated-query interpretation, is retained in evidence.

No indexes, statistics, ANALYZE or VACUUM tuning were applied. Production backup's existing VACUUM INTO is snapshot behavior, not audit tuning. WAL/FK/synchronous/busy timeout remain unchanged. Controlled independent BEGIN IMMEDIATE holder (250 ms): permitted customer read 2.67 ms while writer held lock; actual authorized customer create waited 264.16 ms and succeeded after release. One diagnostic trial demonstrates WAL read/write contention behavior, not ordinary single-process lock incidence or a percentile.

## 12. Financial and business workflow performance

| Actual workload | Evidence | S ms p50/p95 | M ms p50/p95 | L ms p50/p95 | Trials/tier |
| --- | --- | --- | --- | --- | --- |
| Full invoice→manufacture→delivery journey | REAL_SERVICE_SQLITE | 18.85 / 20.84 | 18.72 / 21.64 | 23.81 / 28.12 | 10 |
| Half-minor invoice→approval→payment→refund→expense | REAL_IPC_ELECTRON | 17.51 / 26.62 | 16.97 / 26.53 | 18.23 / 31.05 | 10 |
| Paid supplier purchase→stock/FIFO/mirror/audit | REAL_SERVICE_SQLITE | 2.46 / 5.27 | 2.05 / 2.69 | 2.28 / 3.13 | 10 |
| Authorized customer write | REAL_SERVICE_SQLITE | 0.18 / 0.25 | 0.18 / 0.22 | 0.18 / 0.52 | 30 |

| Service segment | S ms p50/p95 | M ms p50/p95 | L ms p50/p95 |
| --- | --- | --- | --- |
| invoice.create | 1.09 / 1.38 | 1.06 / 1.75 | 1.17 / 3.34 |
| invoice.approve | 2.11 / 2.39 | 2.06 / 2.42 | 2.28 / 2.63 |
| payment.record | 0.92 / 1.20 | 0.91 / 2.22 | 0.99 / 1.17 |
| payment.refund | 2.37 / 4.02 | 2.33 / 2.80 | 3.72 / 4.21 |
| payment.repay | 0.98 / 1.13 | 0.93 / 1.31 | 1.03 / 1.36 |
| worksheet.issue | 3.35 / 4.30 | 3.23 / 3.38 | 3.47 / 4.29 |
| fifo.consume | 1.55 / 1.61 | 1.77 / 2.88 | 4.08 / 4.94 |
| production.complete | 1.11 / 2.15 | 1.10 / 1.13 | 1.19 / 1.29 |
| release.issue | 2.76 / 2.96 | 2.71 / 2.89 | 2.94 / 4.29 |
| delivery.record | 1.80 / 1.86 | 1.78 / 1.83 | 1.94 / 2.14 |
| expense.record | 0.51 / 0.55 | 0.50 / 2.31 | 0.90 / 1.22 |

Service journey: invoice at 90,000 minor → approval → 90,000 payment → 1,000 refund → 1,000 repay → worksheet → consume one unit at 2,000 minor cost → complete → delivery release/handover → 1,000 expense. Independently expected net cash +89,000 and stock −1,000,000 micro per journey. Each actual writer retained required audit/source/mirror/transaction behavior.

IPC journey: quantityMicro 145,000 × unitPriceMinor 100 → committed total 15 minor, then approval, payment 15, refund 1, expense 1,000; expected net cash −986 per journey. Ten journeys plus the real UI expense change cash by −10,860 per tier. Submitted/read-back quantities and rounding remain authoritative, not floating-point alternatives.

Procurement on separate copies: ten purchases × 20,000 paid minor gives cash −200,000, stock +100,000,000 micro, and exactly ten new purchases.create audits per tier. Integrity/FK/73 checks remained clean. Evidence procurement.json; fixture creation also exercised 20/200/2,000 legitimate purchase/receipt/FIFO writes, but seed totals are not per-purchase performance samples.

Thirty timed customer writes also have one separate traced write (31 actual mutations); no hidden mutating warm-up. Manufacturing segment samples are ten per tier, not production-line throughput. Large fixture has only 110 completed worksheets; cumulative lifetime profitability over hundreds of thousands of completed orders remains NOT TESTED. Savings payouts, cash transfers, Uncollected resale, worker payment UI latency, multi-line massive orders, printing/PDF/native printer throughput and account-administration writes were not independently benchmarked. Existing regression tests cover their correctness but do not substitute for measured runtime performance.

## 13. Backup and healthy restore performance

| Tier | Source DB MiB | Snapshot MiB | Archive MiB | DB/archive ratio | Create ms p50/p95 (n=3) | Validate ms p50/p95 (n=3) | Restore ms p50/p95 (n=3) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S | 2.14 | 2.25 | 0.14 | 16.48 | 92.41 / 183.24 | 22.07 / 25.63 | 265.04 / 270.12 |
| M | 10.97 | 11.05 | 0.71 | 15.52 | 269.71 / 2,252.81 | 80.78 / 83.66 | 748.50 / 751.53 |
| L | 98.55 | 97.74 | 5.70 | 17.14 | 2,414.30 / 26,802.55 | 922.09 / 927.59 | 8,266.68 / 8,289.03 |

| Tier | Actual UI backup ms | Fixed IPC validation ms | Actual UI healthy restore→login ms |
| --- | --- | --- | --- |
| S | 216.09 | 34.70 | 395.33 |
| M | 453.05 | 86.70 | 932.02 |
| L | 3,090.89 | 923.70 | 8,479.34 |

All raw service samples retained, including outliers: S creation 183.24/92.41/87.13 ms; M 2,252.81/268.27/269.71 ms; L 26,802.55/2,414.30/2,401.06 ms. Hook phases split snapshot, hash/counts, streaming, validation and publication; exact phase values in services.json. S/M first trials include allocation/cache effects. L first long-lived harness had a major resource confound, discussed below, and is not silently removed from the table.

Fresh-process L controls on the same coherent dataset: creation **2,503.00 / 2,427.85 / 2,388.64 ms**, validation 929.07/897.09/879.28 ms. Main RSS 237.6 → 347.7 MiB; maximum sampled RSS 347.6 MiB. Control phases and CPU/rusage in [backup-control.json](/tmp/aura-performance-audit/backup-control.json). Normal later L snapshot stages are approximately 0.73 s and archive revalidation approximately 0.9 s; these synchronous health/snapshot phases can queue normal main-thread work. Exact simultaneous IPC delay during those phases was NOT TESTED, so no quantified UI-freeze guarantee is inferred.

Nine service archives: every one of twelve manifest counts independently matched actual packaged erp.db. A deterministic afterSnapshot write on each created a later live customer while archive/manifest retained the earlier epoch. Independent-process medium test released 200 authorized writes after snapshot barrier: live customers 10,033→10,233, archived 10,033; all counts/SQL integrity/FKs/73 checks correct. Backup creation 284.43 ms; total experiment including writer join, extraction and verification 343.83 ms. The latter is not archive-only time.

Compiled UI backups likewise passed independent snapshot counts and healthy restore; archived business tables match runtime after restore, apart from documented later customer/audit/auth operational changes. Full process restart/fresh login retained expected data. No cold corrupt-database recovery or BDR-01 replacement was attempted. Format/magic, compression, bounds and historical archive compatibility were unchanged and covered by existing DB-09/restore tests. Temporary scratch directory count returned to zero; retained backups/safety snapshots are intentional, not leaks.

## 14. CPU, memory and resource trends

| Tier | Sample | Main RSS MiB | Renderer working set MiB | Main FD | WAL bytes | Scratch entries |
| --- | --- | --- | --- | --- | --- | --- |
| S | authenticated baseline | 235.80 | 141.31 | 65 | 8272 | 0 |
| S | post workflow | 355.94 | 348.47 | 66 | 32992 | 0 |
| M | authenticated baseline | 254.45 | 141.19 | 65 | 8272 | 0 |
| M | soak final | 293.52 | 1,066.78 | 68 | 37112 | 0 |
| L | authenticated baseline | 261.12 | 141.20 | 65 | 8272 | 0 |
| L | post workflow | 323.28 | 430.86 | 66 | 32992 | 0 |

Medium report renderer samples: baseline 141.2 MiB, then 754.7, 1,135.2, 1,142.5 MiB after three complete report selections; post-workflow remained high. During bounded navigation afterward the renderer settled near 1,067 MiB, while CDP live JS heap returned to about 9–13 MiB in late samples and live DOM shrank. This supports a high working-set/caching footprint of full DOM reports; it does not prove a retained-object memory leak. No forced GC or heap retaining-path investigation was performed.

Main-process medium samples settled around 291–302 MiB late in the soak and 293.5 MiB at end; FD 65 initially, 66–68 through the workload. WAL was about 16,512 bytes at several late samples, 37,112 at final; pre-backup write batches were about 3.6 MB before checkpoint. Temporary scratch entries remained zero. Persistent native SQLite connection is expected; closure/reopen was verified by process restarts and restore. No unbounded handle growth was established.

Electron app.getAppMetrics provides cumulative and interval CPU for Browser/Tab/GPU/Utility; exact values are in electron.json resources. Medium Browser CPU accumulated 34.018 seconds by final resource sample; renderer CPU grew during report/navigation workload. PercentCPUUsage spans between observation samples, not total-machine CPU saturation. Backup-control process user/system CPU rose by about 8.25/3.33 seconds across its three creates, three validations and final health verification; do not label that delta as archive-only CPU.

**Outlier retained, not diagnosed as a leak:** long-lived Vite-node seed/trace harness began first L backup at 2,178.2 MiB RSS, sampled 6,186.1 MiB peak and finished 6,081.5 MiB. First creation took 26.80 s, later creates 2.40 s; final reported heap was far smaller than RSS. Fresh process controls and actual compiled main did not reproduce that footprint. Native allocation/GC, instrumentation and long synchronous seeding are plausible confounds, not proven root causes. This outlier limits absolute long-lived service-harness resource conclusions.

Node fsRead/fsWrite counters were zero despite real files being written; physical disk I/O rates were not available through this instrumentation. File sizes, archive bytes, stage latencies and WAL growth are the measured disk evidence. External drive/network share/low-disk stress were NOT TESTED.

## 15. Long-running stability

**Bounded medium soak:** 180.26 seconds, 452 successful cycles, zero recorded workflow errors. Every cycle performs real customer/order/cash navigation and one authorized customer creation; every 25th cycle adds backup, validation, logout/login and resource sampling. Nineteen periodic archives were created/validated. All checks afterward used the actual runtime-generated database.

Cycle latency: p50 354.44 ms, p95 377.07 ms, max 1,052.80 ms. First 50 p50/p95 359.13 / 405.65 ms; last 50 352.54 / 402.18 ms. Backup/auth cycles intentionally take longer, so percentile drift is not automatically a regression. Individual navigation distributions and resource time series are retained. No throughput loss or error accumulation was established within this duration.

No multi-hour or multi-day soak, long cold-idle observation or exhaustive non-destructive failure recovery was performed. Expected authorization errors and the earlier filename collision are preserved, but do not constitute a broad error-path performance matrix. State is **PASS for the executed bounded soak; NOT TESTED for long-duration guarantees**.

## 16. Correctness and reconciliation results

| Fixture | Migrations / tables | Integrity / FK | Reconciliation | Independent cash minor | Independent stock micro | Business/audit preservation |
| --- | --- | --- | --- | --- | --- | --- |
| S | 53 / 85 | ok / 0 | 73 checks; 0 errors / 0 warnings | 105279140 | 180000000 | Archived business equality; expected operational changes |
| M | 53 / 85 | ok / 0 | 73 checks; 0 errors / 0 warnings | 143129140 | 1940000000 | Archived business equality; expected operational changes |
| L | 53 / 85 | ok / 0 | 73 checks; 0 errors / 0 warnings | 509379140 | 19890000000 | Archived business equality; expected operational changes |

Fresh compiled-startup databases independently verified 53 migrations, 85 tables, integrity ok, zero FKs, all 73 checks and zero findings; read-only verification retained database SHA-256. Every service mutating benchmark batch was followed by health, cash/stock oracles and reconciliation. Seeded payable was zero after commission payment. All 85-table logical hashes before/after read benchmarks and reconciliation were identical.

Final runtime cash: S 105,279,140; M 143,129,140; L 509,379,140 minor, independently derived as service fixture balance −10,860. Runtime stock: 180,000,000 / 1,940,000,000 / 19,890,000,000 micro unchanged by commercial IPC/UI writes. No FIFO/manufacturing mutation arose from branding/navigation or denied users. Separate procurement copy changes matched the exact purchase oracle and reconciled cleanly.

Archived-versus-restored logical comparison covers all business tables. Operational audit_log, sqlite_sequence and remember_tokens have explained startup/login/restore behavior; customers are checked as the exact archived prefix plus 452 medium soak records, with zero extras on S/L. The checker itself is read-only: whole logical hashes and connection total_changes unchanged. Expected required audits come from actual financial services; purchases.create count increased exactly ten in procurement. No silent financial repair was introduced.

Read-only execution did not manufacture missing audit events; protected writes retain transaction/audit rollback semantics. Broad historical audit correctness, BL-03 and Contract C are additionally protected by unchanged regression suites; they are not claimed as new bespoke performance measurements.

## 17. Regression, typecheck, lint and build results

All gates are fresh executions. Exact command arrays, exits and wall durations are in `*-result.json`; logs contain individual tests.

| Gate | Result | Tests/files | Wall seconds | Exit |
| --- | --- | --- | --- | --- |
| Focused security/DB/backup/finance/UI | PASS | 467 / 14; 0 fail/skip/unhandled | 147.416 | 0 |
| npx vitest run --maxWorkers=2 --minWorkers=2 | PASS | 3,611 / 278; 0 fail/skip/unhandled | 833.729 | 0 |
| npm run typecheck | PASS | N/A | 18.188 | 0 |
| npm run lint | PASS | N/A | 16.834 | 0 |
| npm run build | PASS | N/A | 6.992 | 0 |

Full Vitest duration 833.00 s; focused Vitest duration 146.73 s. DB-08 full-run 20,000-record timing **705.711917 ms**, original 2,000 ms ceiling; focused 1,048.843625 ms. Both pass, but this does not establish permanent resolution of historical timing variability. DB-08 code and thresholds remained byte-identical.

Focused command:

```sh
npx vitest run tests/database/bdr02-snapshot-record-counts.test.ts tests/database/db09-backup-streaming.test.ts tests/database/db08-inflight-lifecycle.test.ts tests/database/db14-startup-verification.test.ts tests/integration/ui-wf04-backup-capabilities.test.ts tests/ipc/sec01-document-authorization.test.ts tests/ipc/sec02-avatar-containment.test.ts tests/ipc/sec04-login-audit.test.ts tests/unit/main/sec03-asset-protocol.test.ts tests/integration/payment-refund-composite-ordering.test.ts tests/integration/post-bl02-required-audit-atomicity.test.ts tests/integration/e2e03-worker-commission-reconciliation.test.ts tests/unit/renderer/e2e01-commercial-preview.test.ts tests/unit/renderer/e2e02-branding-assets.test.ts --maxWorkers=2 --minWorkers=2
```

The unchanged full suite additionally covers UI-WF-01..08, financial ownership, date/money, manufacturing/FIFO and prior business closures. No selective retry is presented as a full-suite PASS. No permanent tests were added, changed, skipped or weakened; the external benchmark scripts are audit-only harnesses.

Build: 118 main modules, 3 preload modules, 1,694 renderer modules; main output 1,086.14 kB, preload 13.03 kB, renderer JS 1,265.27 kB, CSS 62.18 kB. No warning observed in this build log; bundle size is an observation, not by itself a performance finding. Compiled bytes remained identical to baseline.

Evidence: [full.log](/tmp/aura-performance-audit/full.log), [focused.log](/tmp/aura-performance-audit/focused.log), [typecheck.log](/tmp/aura-performance-audit/typecheck.log), [lint.log](/tmp/aura-performance-audit/lint.log), [build.log](/tmp/aura-performance-audit/build.log); actual compiled controls retain contextIsolation/sandbox/webSecurity true and nodeIntegration false. Login/sidebar logo had positive natural dimensions. No HTTP requests were observed in instrumented steady-state workflows; context was offline after firstWindow. Initial pre-observer network activity was not independently captured, although entry/resources/CSP remained local and unchanged.

## 18. SHA-256 preservation

Before execution: sorted 4,187-file SHA-256 manifest covering src, existing tests, drizzle, scripts, resources, public, references, configurations/lockfiles, reports, compiled out and Graphify outputs. Manifest file SHA-256: `b0ace82423727c30fc3b4e1e0f358e0910343185ff32040c3d91aeddc15a3f67`. No Git cleanliness was assumed.

After comparison: **production source, all existing tests, migrations/schema, scripts/configuration, dependency manifests/lockfiles, original assets, prior reports and compiled outputs unchanged. No deleted files.** The only non-generated project addition is this final report. Every audit harness/data file is external under /tmp. No private production database was touched.

Generated modified files:

- graphify-out/.graphify_labels.json and .sig
- graphify-out/2026-10-09/.graphify_labels.json, GRAPH_REPORT.md, graph.json, manifest.json
- graphify-out/GRAPH_REPORT.md, graph.json, manifest.json, graph.html
- graphify-out/cache/last_query_stamp and stat-index.json

One new generated AST cache JSON: graphify-out/cache/ast/v0.9.61-s2/b1d11d4f88410e5f26195fc9e69740408096cde576e5f865b3cac25bbe035aee.json. These result from the required baseline graph refresh/querying; final update had no topology change. Build ran as required but introduced no byte differences. Manifest comparison: `/tmp/aura-performance-audit/before.json`, `after.json`, `comparison.json`; final report hash is recorded in after.json rather than recursively embedded here.

Protected hashes (unchanged): recovery/trust.ts `4aa46593a62f694544c5cbbc2dc48897bc73d9a3fce1636694c46ca32605bb3e`; backup.service.ts `b5e76c62d40e309f2b42d2475c535d0cfd4f18c06fb983d09aaec86fe19b8567`; reconciliation.ts `8b267ac7d47191fe99886182a456ecbfa857089acfab291d8bda87a80b238d07`. Full protected report hashes are separately retained in protected-hashes.json.

## 19. Findings ranked by severity

### PERF-01 — Complete reports render unbounded data and DOM

**MEDIUM; OPEN; confirmed scalability/resource-stability risk.** Owners: `src/renderer/pages/reports/ReportsPage.tsx:30,81`, `src/renderer/components/ui/index.tsx:200`, `src/main/services/reports/reports.service.ts:81`, `src/main/services/parties/parties.service.ts:212`. Secondary same-table rendering cost occurs on unbounded supplier/material lists.

Reproduction: seed the M dataset via real services; compiled owner login; select Reports → customer_balances; switch to sales then back three times; wait for title/10,034 rows and two animation frames; sample Electron renderer working set. Independent service/IPC timings and screenshots are retained in services.json / electron.json / report-M.png.

Observed: S report 103.71/113.30 ms visible p50/p95 versus M 852.26/885.42 ms; M 70,473 DOM elements. Renderer 141.2 MiB baseline → 754.7/1,135.2/1,142.5 MiB after report cycles; medium session recorded up to 630 ms long tasks. L complete report service 311.43/389.81 ms, fixed IPC 511.60/570.30 ms and 18,409,136-byte UTF-8 DTO at service trace; L full DOM not attempted. Supplier/material 1,000-row UI lists additionally took 286.59/516.21 ms median with fast service queries.

Root cause: complete dataset is aggregated/formatted/transferred and every returned row is mounted through rows.map. Bounded list behavior does not apply to reports. User impact: visible pauses and high renderer working set compete with other workflows on a 16-GiB machine. No crash, data loss, retained-object leak or extrapolated 100,000-row UI completion is claimed. Severity reflects repeatable moderate-scale operational cost, not an invented SLO violation.

Minimal proposed direction, owner authorization required: bounded report-view paging/virtualization while preserving complete export/print contracts; investigate complete DTO transfer separately. Do not alter monetary aggregation or permission-derived confidentiality. Regression risks: report totals, sorting, export completeness, accessibility and field visibility. Confidence HIGH for measured unbounded work; residual uncertainty: exact heap retaining paths and maximum practical scale.

### PERF-02 — Every search keystroke queues full active-customer searches

**LOW; OPEN; confirmed avoidable main-process work.** Owners: `CustomersPage.tsx:114`, `lib/usePagedQuery.ts:61–108`, `parties.service.ts:59`; actual registered customers:list.

Reproduction: at S/M/L, clear customer search; type NO-MATCH-PERF using real input keyboard events; await empty UI and two frames; repeat three times; observe real handler count and duration. Each burst emitted exactly 13 requests. S main-handler total ~10–11 ms; M ~46–49 ms; L 426.32–427.09 ms. L visible completion 508.34/509.04 ms p50/p95, versus S 67.13/90.12. L individual miss request p50/p95 33.90/34.20 ms across 100 samples.

Root cause: immediate input state changes issue separate searches; stale response suppression does not cancel main work. Each `%substring%` filter executes result and total-count queries over active candidates despite no matching rows; actual plans show lifecycle-index access rather than a selective substring seek. Concurrent batch experiment demonstrates serialized main DB work, so obsolete searches consume shared processing time.

User impact: fast typing produces queued work and delayed visible search at 100,000 customers; no incorrect search result or authorization bypass demonstrated. Proposed minimal direction: coalesce/debounce requests and assess compatible search/count strategy with approved search semantics. Do not remove guard checks or invent different matching rules. Risks: stale-response order, Arabic/phone search behavior, accurate summary/pagination and immediate feedback. Confidence HIGH in burst count/timing; slow human typing and other search selectivity were not exhaustively tested.

### PERF-03 — Worker list executes one balance query per worker

**LOW; OPEN; confirmed N+1 scalability limitation.** Owner: `workers.service.ts:43–52 listWorkers`, `:66 workerBalances`; `WorkersPage.tsx:72` consumes the list. Evidence class REAL_SERVICE_SQLITE plus SOURCE_ONLY UI ownership; worker-list UI latency was NOT TESTED.

Reproduction: valid fixture with 10/100/1,000 workers and real recognized/paid commissions; call actual listWorkers, one warm-up then 30 trials; trace a separate execution. SQL executions exactly 11/101/1,001. Median/p95 0.37/0.40, 2.99/3.12 and 29.14/34.84 ms. Legitimate balance values/payable zero remain correct and all 73 checks pass.

Root cause: rows.map invokes the aggregate balance function per master row. Impact is repeated synchronous main-process query overhead and scale-proportional work, not a demonstrated severe user pause at normal worker counts. No SLO or financial defect inferred. Proposed direction: one grouped balance lookup preserving separate payable/debt CC04 semantics, role confidentiality and all established transaction kinds. Risks: accidental netting, omission of workers with no transactions, adjustment/commission/reversal classification. Confidence HIGH in query count; operational likelihood depends on actual worker population and was not supplied.

No CRITICAL/HIGH finding was established. Long-lived harness RSS outlier, missing SLO, platform gaps and unmeasured native I/O are limitations rather than additional invented findings.

## 20. Windows-native coverage gaps

NOT TESTED: Windows 10/11 performance, NSIS installation/first-run, NTFS/antivirus effects, signed installer, DPAPI/platform recovery protection, Windows path/case behavior, Windows memory/disk scheduling, low-end x64 machines and native printing. macOS results do not qualify Windows. No Windows tooling, privileged helper, provisioner or policy store was installed. Performance thresholds must be decided with target hardware and business scale, then measured natively under separate owner authorization.

## 21. BDR-01 and BDR-02 preservation

BDR-01 remains **OPEN — UNCHANGED**. Existing trust foundation is not attached to startup/preload/IPC; no enrollment or destructive recovery capability added. Recognized corruption still has the previously documented startup limitation; this performance audit did not retest corrupt replacement or claim disaster recovery.

BDR-02 remains **VERIFIED CLOSED — UNCHANGED**. backup.service.ts recordCounts reads the same readonly snapshot path packaged as erp.db; twelve table semantics/archive version unchanged. Nine service archives, three compiled UI archives and the controlled independent-writer archive had exact count parity. Existing permanent BDR-02 tests passed. Phase 1/1B/security-design/native-validation reports and production owners are byte-identical.

Normal backup.restore permission, session invalidation, bounded archive parsing, DB-08 markers/epochs and SEC-01..04 protections unchanged. Private recovery keys or protected policy were never generated/imported. No new audit/remediation phase was started.

## 22. Final verdict and owner decision points

| Domain | Evidence class | Dataset tier | p50 | p95 | Status |
| --- | --- | --- | --- | --- | --- |
| Startup | REAL_ELECTRON | S / M / L | 779.24 / 782.70 / 1,130.91 ms | 796.04 / 789.68 / 1,141.04 ms | PASS (executed healthy startups) |
| UI (customer report) | REAL_UI_ELECTRON | S / M; L DOM not tested | 103.71 / 852.26 ms | 113.30 / 885.42 ms | RISK — PERF-01 |
| IPC (miss customer search) | REAL_IPC_ELECTRON | S / M / L | 0.70 / 3.60 / 33.90 ms | 0.80 / 3.70 / 34.20 ms | RISK — PERF-02 |
| SQLite/service (worker list) | REAL_SQLITE / REAL_SERVICE_SQLITE | S / M / L | 0.37 / 2.99 / 29.14 ms | 0.40 / 3.12 / 34.84 ms | RISK — PERF-03 |
| Financial journey | REAL_WORKFLOW (service SQLite) | S / M / L | 18.85 / 18.72 / 23.81 ms | 20.84 / 21.64 / 28.12 ms | PASS (executed oracle) |
| Backup/Restore (UI restore) | REAL_ELECTRON / REAL_SQLITE | S / M / L | 395.33 / 932.02 / 8,479.34 ms (single trials) | N/A | PASS (healthy restore only) |
| Stability | SOAK | M; 180.265 sec / 452 cycles | 354.44 ms/cycle | 377.07 ms/cycle | PASS bounded; longer durations NOT TESTED |

PASS means the stated workload executed with its correctness oracle; it does not establish a performance SLA or completeness beyond that workload. RISK identifies a measured finding. NOT TESTED applies to missing execution evidence, not a fabricated failure.

Owner decisions: review PERF-01 first, then authorize individual PERF-02/03 work only if desired; define target business volumes, supported hardware and UI/backup latency objectives; decide later XL and longer-soak coverage. No remediation, Release Readiness or Windows qualification is authorized by this audit. Retain/copy the external evidence directory if needed: /tmp artifacts are ephemeral.

```text
PERFORMANCE AUDIT:
PARTIAL

PERFORMANCE FINDINGS:
CRITICAL: 0
HIGH: 0
MEDIUM: 1
LOW: 2

REAL COMPILED ELECTRON:
PASS

DATASET COVERAGE:
S / M / L — ACTUAL RESULTS; XL NOT TESTED

SQLITE INTEGRITY:
PASS

RECONCILIATIONS:
PASS

FULL VITEST:
PASS

TYPECHECK / LINT / BUILD:
PASS

PONYTAIL FULL:
COMPLETE

GRAPHIFY:
PASS

PRODUCTION CODE MODIFIED:
NO

BDR-01:
OPEN — UNCHANGED

BDR-02:
VERIFIED CLOSED — UNCHANGED

READY FOR OWNER REVIEW:
YES
```

Ponytail FULL is complete for the measured ownership chains and their preservation review; overall performance coverage remains PARTIAL for the limitations explicitly listed. This report authorizes no changes and makes no release-readiness claim. Work stops here pending owner review.
