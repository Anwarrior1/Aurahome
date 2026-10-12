# PERF-03 — Worker-list grouped balance remediation

Date: 2026-10-09. Platform: macOS arm64. Authorization: PERF-03 ONLY. Starting status: LOW — OPEN. Methodology: Ponytail FULL + Graphify + deterministic RED/GREEN.

## 1. Executive verdict and owner review

Recommend **PERF-03 VERIFIED CLOSED**, subject to owner review of this evidence. The original actual SQLite execution growth was 11 / 101 / 1,001 statements at 10 / 100 / 1,000 workers. The corrected path executes two statements for every nonempty list and one for an empty list. All complete financial DTOs match the preserved original implementation and the independent integer oracle exactly.

Fresh baseline: **3,651 tests / 283 files passed**. Final: **3,660 tests / 284 files passed**, exactly nine new focused tests and one new Vitest file, no removed/skipped tests. Typecheck, lint, build, Graphify, actual compiled macOS Electron, integrity/foreign keys and all 73 reconciliations pass.

Only the worker-list construction in `src/main/services/production/workers.service.ts` changed in production. The canonical payable/debt expressions, single-worker balance helper, financial writers, IPC contracts, renderer, schema, permissions and restore guards remain byte-identical. STOP conditions: **NONE**. Unauthorized changes: **NO**. This report ends the authorized task; no release, Windows, BDR-01 or other performance work was started.

## 2. Authorization and source review

The work is a worker-list read optimization plus focused permanent tests, compiled Electron observations, generated build/Graphify artifacts and this report. No new dependency, migration, index, IPC channel, financial formula, posting rule, historical record change or real customer/financial data access occurred. Fixture setup uses documented service writers on disposable fictional copies before read-only measurements.

Reviewed current source, `PERFORMANCE_AUDIT.md`, `CUSTOMER_CHANGE_04_FINAL.md`, `CUSTOMER_CHANGE_04B_FINAL.md`, the CC04/CC04B and E2E03 reconciliation tests, existing worker deletion/financial/security tests, and `PERF_01_FINAL.md`, `PERF_01_OUTPUT_FINAL.md`, `PERF_02_FINAL.md`. Historical 3,651 tests and approximate fixture counts were independently checked. There is no Git repository (`git rev-parse` exits 128); preservation and exact diffs use SHA-256 and external copies.

## 3. Root cause and Ponytail FULL chain

Original `workers.service.ts:52` mapped every master row through `workerBalances(worker.id)`. That helper (original line 66, current line 78) executes one ledger aggregate per worker. One master SELECT plus N aggregate executions produced the confirmed defect. Counting actual SQLite `all/get/run/iterate` executions demonstrates this even when SQL text is reused.

The chain is the worker navigation link / search input → WorkersPage useQuery → renderer call → fixed preload binding → registered workers:list handler → Zod filters → trusted webContents session / workers.view → restore admission → listWorkers → Drizzle master query and SQLite authoritative ledger expressions → Worker[] → table formatting. No new owner, API or financial abstraction was introduced.

| Question | Evidence (current file:line unless labeled original; raw logs below) | Result |
|---|---|---|
| Q1 — exact UI action | `src/renderer/routes/nav.ts:71`; `src/renderer/pages/workers/WorkersPage.tsx:72,248`; `src/renderer/lib/useQuery.ts:21,35`; native click trials | Worker navigation mounts list; changing search changes query key and reloads. Actual payload `{search, activeOnly:true}`. |
| Q2 — registered channel and guards | `src/shared/constants/channels.ts:231`; `src/preload/api/build-api.ts:24`; `src/main/ipc/router.ts:2221`; `src/main/ipc/guard.ts:44,48,55,59,62` | Fixed `workers:list`, optionalFilters schema, trusted session, workers.view, pending-restore check and lifecycle admission. |
| Q3 — service/repository owner | `src/main/ipc/router.ts:2225`; `src/main/services/production/workers.service.ts:43`; `src/main/db/connection.ts:32` | Production worker service directly owns Drizzle/SQLite list construction; no separate worker-list repository. |
| Q4 — N+1 call | External backup `workers.service.ts:52`; `deterministic-red-sealed.log`; `before-scale.json` | Original rows.map invokes one workerBalances read per worker. Removed only from list path. |
| Q5 — authoritative commission/payable/debt | `CUSTOMER_CHANGE_04_FINAL.md` §3; `src/main/services/production/production.service.ts:528,876`; `workers.service.ts:68,70,78`; CC04 tests | Completion posts preparation-derived manufacturing commissions; posted earning + adjustment − commission_payment = payable; withdrawal − repayment = separate debt. No netting. |
| Q6 — statuses/dates | Original/helper current `workers.service.ts:78`; `production.service.ts:528`; independent edge tests `tests/integration/perf03-worker-list.test.ts:76,122` | Balance aggregates all posted worker_transactions for worker ID; no date/status filter. Preparation/start alone do not accrue. Unrecognized/reversed assignment handling belongs to unchanged writers. Past/future posted dates remain included. |
| Q7 — representation | `src/main/db/schema/production.schema.ts:94,103` workerTransactions integer amountMinor; `workers.service.ts:68`; `src/renderer/lib/format.ts:11,21`; safe-integer test line146 | SQLite INTEGER minor amounts, SUM integer expressions, JS number DTO. 1,000 minor units per LYD. No float cast/new rounding; exact BigInt oracle before conversion. |
| Q8 — negative/zero/absent | Canonical SQL COALESCE at lines68–71; list default at61–62; edge test122 | No ledger group maps to number 0 for each field. Offsetting entries yield number 0. Valid paid legacy reversal yields payable −101. Debt repayment guards unchanged; prohibited negative debt is not invented. |
| Q9 — worker visibility | Master SQL `workers.service.ts:43–50`; archive/delete edge fixture | activeOnly=true excludes inactive; false/omitted includes archived. Physical deletion means absent. UI requests activeOnly=true. No visibility changes. |
| Q10 — shared helper consumers | `workers.service.ts:659,691,927`; `src/main/services/reports/reports.service.ts:490` worker_balances projection | Debt validation, commission payment and workerStatement still use original workerBalances. Report uses its own unchanged matching projection. Original helper/constants/writers/history tail byte-identical. |
| Q11 — ordering/pagination | Master SELECT lines43–50; filter test131; renderer useQuery72 | No explicit ORDER BY, cursor, offset, limit or pagination metadata in actual list owner. Original SQLite row order retained by mapping original master array; SQL grouped order never controls output. Accepted generic limit remains ignored as before. First/middle/final pages are inapplicable to this unpaged contract; all rows, filters and empty states compared. |
| Q12 — actual SQL per worker | Original count/trace in before-scale.json and matched/before-electron.json | One worker SELECT, then N identical parameterized ledger aggregate executions (`WHERE worker_id = ?`). After: same master SELECT and one ID-restricted grouped aggregate. |
| Q13 — read consistency | before-snapshot.json / after-snapshot.json; actual raw.inTransaction traces | Original default uses multiple statement snapshots; grouped balances use one snapshot. Caller transaction inherited unchanged; no BEGIN/COMMIT/transaction ownership added. Controlled external service writer verified both behaviors. |
| Q14 — renderer dependencies | WorkersPage15–25,264,268,285,429,462; format.ts21 | payable/debt displayed separately; payable<=0 disables payment, dialogs use same values. Entire DTO including types/order and visible name/phone/money strings strictly equal. Formatting unchanged. |
| Q15 — writers reachable from list | Exact production diff; actual SQL traces; 85 logical table hashes and total_changes checks | List itself reaches only SELECTs. Other UI writer actions are separate guarded IPC; none invoked by list reads. No financial mutation. |

## 4. Preservation baseline and fixture identity

Before production edits, sorted SHA-256 manifest covered **4,206** files: source, tests, schema/migrations, scripts/configuration, manifests/lockfiles, assets including fonts/logo, prior reports and compiled outputs. Baseline manifest SHA-256: `699cdb2ad682a3b7dc6f5556d2bfc8f45c24d02d338cf2e7434a10c1da1901cb`.

Durable original backup: `$HOME/aura-evidence/perf03/backup/src/main/services/production/workers.service.ts` and complete original `backup/out/{main,preload,renderer}`. Relative paths preserved. Durable evidence root: `$HOME/aura-evidence/perf03/evidence/`; all commands, exit codes, exact RED failures, raw samples, fixtures, observer scripts, snapshot traces, manifests and screenshots are retained. `before.json`, `after.json`, `comparison.json`, `production.diff` and external `seal.json` provide file/hash provenance; report hash is sealed externally to avoid a self-referential report hash.

Immutable L-scale fictional source: `$HOME/aura-evidence/perf02/fixture/erp.db`, copied to PERF-03 preservation storage. SHA-256 **`b019cb1282f74ab9349be20263693933ba0ab18879663780a9c76a63f62df915`**, **102,486,016 bytes**. Actual current fixture has **1,000 workers**, not the historical approximate 1,001. Every native run starts from an identical copy and verifies source SHA before/after; original fixture unchanged. No real application database was opened.

## 5. Graphify baseline and final ownership

Awaited `graphify update .` and `graphify diagnose multigraph` before production changes and after correction. Baseline: **7,296 nodes / 13,943 edges / 411 communities**. Final: **7,329 / 14,000 / 414**. Added 33 nodes are the two authorized regression harnesses; removed nodes zero. Worker query baseline resolves listWorkers → workerBalances; final direct list owner no longer calls helper. Existing shared helper consumers remain.

Graphify code update reports **8 unsupported files skipped** (fonts/CSS/.gitignore and similar assets), already covered by preservation hashes; no semantic provider configured. Final post-full-suite seal reports no code topology change and retains the same counts. This is an AST/code topology qualification; final report prose was not submitted to a semantic provider.

Both diagnostics: unverified code nodes, missing/dangling endpoints, exact duplicates and directed/undirected collapsed edges **0**. Existing self-loops **34** and producer suppression sites **12** unchanged. Graphify reports normal graph.json is post-build; zero endpoint collapse is not a claim that all upstream producer loss is impossible. Current AST ownership plus inspected source and execution traces support the chain. No semantic provider/dependency was added.

## 6. Deterministic RED before production edits

Permanent `tests/integration/perf03-worker-list.test.ts` was created and run against original production. Sealed RED: **9 tests / 1 file, 3 failed / 6 passed**, exit **1**. Exact failures: actual **11**, **101**, **1,001** were each expected `<= 2` (`expect(current.count).toBeLessThanOrEqual(2)`). All original financial/oracle, filters, isolation, precision/transaction, guards, read-only and reconciliation assertions passed before production was edited.

| RED requirement | Preserved evidence / outcome |
|---|---|
| RED-01 execution growth | Original actual executor trace 1+N at all three sizes, not prepare-string counting. Count hard assertions fail deterministically. |
| RED-02 exact equivalence | Copied original list algorithm and unmodified canonical projection strictly agree with independent BigInt facts for each returned complete Worker DTO; types and order asserted. |
| RED-03 financial edges | Real service-created preparation/start/completion, partial/full/multiple payments, debt without commission, signed valid reversal, zero/absent rows, archived/deleted workers, past/future dates and many entries. |
| RED-04 isolation | Duplicate names, dates, amounts and same order references; changing one worker affects only that worker. |
| RED-05 ordering/filter contract | Full original array and name-LIKE/active/empty variants exact. No actual list pagination exists to simulate. |
| RED-06 authorization | Registered anonymous, denied, reader, malformed schema and exclusive-restore cases preserve error/result behavior. |
| RED-07 read-only | All 85 table logical hashes and total_changes unchanged across list requests; trace only SELECTs. |

Initial fixture draft also exposed three known `WORKER_EARNED_ON_OPEN_ORDER` findings because completed manufacturing had not yet been delivered. Corrected only fictional setup through existing release/delivery service before sealed RED; no reconciler, writer, rule or assertion weakened. Initial 5-failure run is retained separately. This was not a production/oracle disagreement.

Compiled original RED also completed the real workflow, 20 matched UI trials and 20 IPC trials, then failed only final SQL-count assertion (`compiled worker list must execute at most two SQL statements`, original 1,001). Early harness diagnostics retained: sandbox launch failed until permitted native execution; historical expected 1,001 fixture count corrected to measured 1,000; ambiguous duplicate Close button locator made explicit. These observer/setup errors did not modify production or financial state.

## 7. Independent oracle and exact GREEN matrix

Three comparison routes: preserved pre-edit source list with original workerBalances, preserved original compiled owner/native results, and an independent raw-fact reducer using BigInt switch cases from documented CC04 rules. Oracle does not import new grouped SQL or canonical SUM fragments. Original and oracle agreement established before edit; optimized complete arrays strictly equal after edit. All workers, not a sampled subset, compared.

| Fictional state | Exact payableMinor / debtMinor | Original = oracle = grouped |
|---|---:|---|
| No ledger rows; preparation/start only | 0 / 0 | PASS |
| Manufacturing accrued; debt outstanding | 10001 / 7000 | PASS |
| Two partial payments (3001 + 2000 of 10001) | 5000 / 0 | PASS |
| Fully settled commission | 0 / 0 | PASS |
| No commission, withdrawal 9001 − repayment 2001 | 0 / 7000 | PASS |
| Withdrawal/repayment offset (17 − 17) | 0 / 0 | PASS |
| Many entries (200 alternating debt facts) | 0 / 0 | PASS |
| Paid legacy earning, valid cancellation adjustment | −101 / 0 | PASS |
| Archived with history, deleted without history | Same retained / excluded identity and active state | PASS |
| Safe integer boundary debt | 0 / (Number.MAX_SAFE_INTEGER − 1) | PASS |
| 10 / 100 / 1000 service fixtures | Entire DTO arrays and oracle equal | PASS |
| 1000-worker compiled L fixture | All DTO fields/types, IDs/order and visible strings equal | PASS |

Grouping solely by worker_id prevents cross-worker mixing. There is no join fanout. ID list comes from the unchanged master selection, bound as one JSON parameter. Group absence defaults to numeric zero exactly as original COALESCE(empty SUM). Signs, kind inclusion/exclusion and SQLite integer SUM affinity/overflow behavior remain the same expressions. No TOTAL, REAL conversion, rounding tolerance, net balance or new commission DTO was introduced. Existing valid integer-domain boundary is exact; unsupported overflows/historical invalid states are not manufactured or repaired.

## 8. Smallest correct design and read consistency

| Option | Assessment |
|---|---|
| A — one grouped aggregate over relevant IDs | Selected. Reuses existing two canonical SQL fragments, one bound JSON array / built-in json_each, Map keyed by worker ID, original master array mapping. Constant two SQL executions; empty one. |
| B — bounded batches | Unnecessary: JSON table-valued parameter avoids per-ID SQLite variable limits. Batches would add machinery and separate balance snapshots without benefit at measured scale. |

Existing json_each precedent: `src/main/services/notifications/notifications.service.ts:142`. Measured EXPLAIN QUERY PLAN uses existing `worker_transactions_worker_idx (worker_id=?)`; JSON virtual table supplies relevant IDs. It does not full-scan unrelated ledger history. No index/schema change. [SQLite json_each](https://www.sqlite.org/json1.html#jeach) documents the built-in table-valued function; [SQLite SUM](https://www.sqlite.org/lang_aggfunc.html#sumunc) documents integer input/overflow behavior.

Both original and corrected use the same synchronous connection. No transaction was added, removed or widened. A controlled second process commits two legitimate fictional worker withdrawals (7 minor each) through existing service/transaction/audit logic at executor barriers:

| Commit boundary | Original returned debts | Grouped returned debts | Interpretation |
|---|---|---|---|
| After master SELECT, before balance lookup | [7,7] | [7,7] | Both retain separate master and balance statement snapshots outside a caller transaction. |
| After first balance execution | [0,7] | [0,0] | Original can mix per-worker snapshots; grouped execution has already read both values in one snapshot. |
| After master inside caller-owned transaction | [0,0] | [0,0] | Existing transaction snapshot/ownership preserved; post-commit balances [7,7]. |

All scenarios pass; raw inTransaction states false outside / true inside before and after. No new lock, BEGIN or COMMIT in list trace. Grouping improves consistency between worker balances; it does not claim the master and aggregate share one default snapshot. [SQLite isolation](https://www.sqlite.org/isolation.html) supports the statement/transaction snapshot model.

## 9. Exact production diff

```diff
--- before/src/main/services/production/workers.service.ts
+++ after/src/main/services/production/workers.service.ts
@@ -49,7 +49,19 @@
     .from(workers)
     .where(clauses.length ? and(...clauses) : undefined)
     .all()
-  return rows.map((worker) => ({ ...worker, ...workerBalances(worker.id) }))
+  if (!rows.length) return []
+  // Keep the master query's order; aggregate only its IDs with the same CC04 expressions.
+  const balances = new Map(getDatabase().all<{ workerId: number; payableMinor: number; debtMinor: number }>(sql`
+    SELECT worker_id AS workerId, ${WORKER_PAYABLE_SQL} AS payableMinor, ${WORKER_DEBT_SQL} AS debtMinor
+    FROM worker_transactions
+    WHERE worker_id IN (SELECT value FROM json_each(${JSON.stringify(rows.map((worker) => worker.id))}))
+    GROUP BY worker_id
+  `).map((balance) => [balance.workerId, balance]))
+  return rows.map((worker) => ({
+    ...worker,
+    payableMinor: balances.get(worker.id)?.payableMinor ?? 0,
+    debtMinor: balances.get(worker.id)?.debtMinor ?? 0
+  }))
 }
 
 /** SQL for the two separate worker balances; never netted against each other (CC04). */
```

The entire original source tail beginning with the CC04 balance-expression comment (including both constants, workerBalances and all writer/history functions) is byte-identical to external backup. New permanent files: `tests/integration/perf03-worker-list.test.ts` and `tests/electron/perf03-worker-list.mjs`. No existing test altered, removed, skipped or weakened.

## 10. GREEN SQL counts and matched service latency

Focused GREEN: **9/9 tests**, exit 0. Counts: **2 / 2 / 2**, empty list **1**. Old copied implementation still demonstrates **11 / 101 / 1001** on identical fictional facts. Query classes: master SELECT + grouped ledger SELECT; no per-worker query remains in list. Two is a hard execution bound for all nonempty sizes, with no batches.

| Workers | SQL before → after | Service p50 before → after (ms) | p50 absolute / percentage | Service p95 before → after (ms) | p95 absolute / percentage |
|---:|---|---|---|---|---|
| 10 | 11 → 2 | 0.415083 → 0.158709 | -0.256374 ms / -61.76% | 0.482708 → 0.230125 | -0.252583 ms / -52.33% |
| 100 | 101 → 2 | 3.147916 → 0.329041 | -2.818875 ms / -89.55% | 3.499208 → 0.373666 | -3.125542 ms / -89.32% |
| 1000 | 1001 → 2 | 28.980042 → 1.796458 | -27.183584 ms / -93.80% | 33.144458 → 1.890375 | -31.254083 ms / -94.30% |

SQL absolute / relative reductions: 10 workers **−9 / −81.82%**; 100 **−99 / −98.02%**; 1,000 **−999 / −99.80%**. Service samples are 30 valid uninstrumented trials per size per version after one discarded warm-up; executor counting/EXPLAIN recorded separately. Fictional deterministic fixtures use real services, including sparse debt facts. These are current matched baselines, distinct from historical .37 / 2.99 / 29.14 ms.

## 11. Real compiled macOS Electron protocol and correctness

`tests/electron/perf03-worker-list.mjs` launches installed actual compiled Electron with real renderer, unchanged preload, registered handler/guards and immutable fictional SQLite copy. Original compiled outputs were preserved before edits; final build was freshly compiled. External observer copies add a delegation wrapper to exactly one compiled list function (round-trip assertion proves original body retained) and actual SQLite executor/main-handler observers. No new IPC, mocked DTO, bypassed projection or guard substitution. Renderer runs its normal application; observers cannot issue renderer database SQL.

Primary matched native runs were isolated from full Vitest/build load. Each has one excluded UI warm-up + **20 valid navigation/click-visible trials**, and one excluded fixed-preload IPC warm-up + **20 valid IPC trials**. Latencies use nearest-rank p50/p95. Service/main-handler/SQLite times are measured separately in main; IPC is renderer window.erp round-trip; visible time begins at actual Workers navigation click and ends after rows appear/loading ends and frame stabilization. Raw per-trial queries/times retained. Compiled tracing adds observer overhead; uninstrumented service measurements above are reported separately. Same observation protocol for both versions.

Verified healthy startup/owner UI login, actual Workers link, all 1000 rows, actual financial formatting, repeated reload/navigation away/back, filtered state, clear/reset, empty state, real statement IPC and history dialog, anonymous denial, denied-role denial and view-only reader/history restriction. No application page errors or network requests. Actual webPreferences retain contextIsolation, sandbox, webSecurity=true, nodeIntegration=false; all **260 registered channel names** equal between builds.

Current worker-list contract is normalized IpcResult<Worker[]> with worker fields `id`, `name`, `phone`, `defaultMethod`, `defaultCostingUnit`, `defaultRateMicro`, `active`, `notes`, `createdAt`, plus numeric `payableMinor` and `debtMinor`. Nullable fields and boolean active retain their types. There is no separate commission/net-balance field or page metadata; accrual is preserved through posted facts and exact payable, rather than inventing a new DTO field.

Complete native DTO SHA-256 (canonical JSON): **`571c16ac8436d88a9a9e4a49e1b05fdbf4d57f91fd9e98eee9fc0b9fe0c0c370`** in both runs. UI checks compare each worker's exact name, phone, payable and debt strings in master order, all 1000 rows; before/after screenshots retained. Original L fixture workers are all settled (zero current balances); nonzero financial edge values are verified by real service/registered integration cases rather than claimed as native L fixture coverage.

## 12. Mandatory before/after comparison

| Metric | Before | After |
|---|---|---|
| SQL executions at 10 workers | 11 actual | 2 actual |
| SQL executions at 100 workers | 101 actual | 2 actual |
| SQL executions at 1,000 workers | 1,001 actual | 2 actual |
| Worker-list service p50/p95 (uninstrumented, 1000) | 28.980 / 33.144 ms | 1.796 / 1.890 ms |
| Compiled worker-list service p50/p95 (observed) | 33.229 / 34.515 ms | 2.101 / 2.302 ms |
| Registered main IPC handler p50/p95 | 33.358 / 34.662 ms | 2.229 / 2.424 ms |
| Registered IPC round-trip p50/p95 | 37.100 / 38.300 ms | 5.900 / 6.100 ms |
| UI visible p50/p95 | 299.200 / 330.600 ms | 247.700 / 250.700 ms |
| Actual SQL execution time p50/p95 (compiled observed) | 6.236 / 6.458 ms | 0.905 / 0.961 ms |
| Renderer memory working set | 466.375 MiB | 438.391 MiB |
| Complete financial DTO equivalence | Original + independent oracle agree | Exact, all workers/types/order |
| Financial reconciliations | 73/73 each fresh and populated | 73/73 each fresh and populated |
| Business-table mutations during list workflows | 0 (85 hashes unchanged) | 0 (85 hashes unchanged) |

| Metric | Absolute p50 change | Relative p50 change | Absolute p95 change | Relative p95 change |
|---|---:|---:|---:|---:|
| Compiled service | -31.128 ms | -93.68% | -32.213 ms | -93.33% |
| Registered handler | -31.129 ms | -93.32% | -32.238 ms | -93.01% |
| Renderer fixed-preload IPC | -31.200 ms | -84.10% | -32.200 ms | -84.07% |
| Action to visible | -51.500 ms | -17.21% | -79.900 ms | -24.17% |
| SQLite execution time | -5.331 ms | -85.49% | -5.497 ms | -85.12% |

Renderer working set absolute change **−27.984 MiB (−6.00%)**, same checkpoint after 20 navigation trials. This is a matched checkpoint observation, not a heap/leak qualification. Long tasks: **21 before / 21 after**, maximum **132 / 134 ms**; heavy 1000-row rendering remains. No claim that grouping eliminates renderer long tasks. Actual measured visible improvement is local to this machine/fixture/protocol, not inferred solely from service time or a new SLO. No confirmed material regression in worker history, payments, debt guards, archive/delete or permissions.

## 13. Permissions and confidentiality

Existing workers.view remains the list permission. Anonymous registered/native requests: UNAUTHENTICATED; authenticated without workers.view: FORBIDDEN. View-only role receives the same current list financial DTO as baseline; no expanded financial authority. workers.finance-protected history remains FORBIDDEN for that reader. Malformed filter remains VALIDATION_ERROR; restore exclusivity still denies admission. Tests invoke actual registered routes and session/permission owner, not service-only authorization assertions. Production guards/preload/channel map byte-identical. No cross-worker aggregation contamination or data disclosure to denied callers.

## 14. SQLite and financial preservation

Fresh migrated database and populated immutable-copy database each have all **53 migrations**, integrity_check **ok**, foreign_key_check **0 violations**, **73 reconciliations**, **0 findings / errors / warnings**, before and after. Every table logical hash remains unchanged across list reads, including cash/FIFO/customers/orders/worker facts; SELECT-only execution and total_changes separately asserted. Populated cash **509390000 minor**, material stock **19890000000 micro**, unchanged. The independent oracle agrees for all 1000 fixture workers.

Native workflow read-only boundary begins after fictional role/user setup and excludes later login/logout security audit activity. Within boundary **all 85 table hashes equal**. Between independently initialized runtime copies, only audit_log/roles/users differ from legitimate fixture auth/setup timestamps; financial/business tables are equal. These explained setup differences are not reported as list mutations. No repair write, historical date change or real database access.

## 15. Environment and regression/typecheck/lint/build

MacBook Air10,1, Apple M1 (8 cores), 16 GB RAM; macOS 26.5.2 build 25F84, Darwin 25.5.0 arm64. CLI Node 24.17.0; Electron 43.6.0 / runtime Node 24.20.0 / Chromium 150.0.7871.250. SQLite 3.53.4, better-sqlite3 13.0.3, Drizzle 0.33.0, React 18.3.1, Vitest 2.1.9, installed Playwright 1.63.0. Environment logs omit hardware serial/UUID. system_profiler emitted `Error fetching hw.cpufamily: -1` while returning successful M1/core/memory output; no measurement gate depends on that optional field.

Baseline full Vitest: **283/283 files, 3651/3651 tests**, exit 0, internal duration **819.60 s**, wall **821.191 s**. Final full Vitest: **284/284 files, 3660/3660 tests**, exit 0, internal duration **818.43 s**, wall **819.008 s**. Exactly +9 tests / +1 file. Zero failures, skips or unhandled errors. Both runs emit the same **25 existing React server-render useLayoutEffect warnings**; deliberate fault-injection/recovery and no-printer fallback logs are retained, not treated as unexpected test failures. No warning suppression added.

Focused financial/CC04/permission/worker regression: **207 tests / 12 files**, all passed, 0 skips. Typecheck passes; lint passes with **26 existing warnings, 0 errors**, identical before/after (prior PERF-02 test typing warnings). Build passes; no build warning. No dependency/lockfile/config changes. Baseline/full durations are wall times in tables; Vitest internal duration reported separately where available.

| Evidence log | Exact command | Exit | Wall seconds |
|---|---|---:|---:|
| `baseline-full.log` | `npx vitest run --maxWorkers=2 --minWorkers=2` | 0 | 821.191 |
| `baseline-typecheck.log` | `npm run typecheck` | 0 | 21.053 |
| `baseline-lint.log` | `npm run lint` | 0 | 19.101 |
| `baseline-health.log` | `npx vite-node --config vitest.config.ts /tmp/aura-perf03/health.ts before` | 0 | 6.919 |
| `baseline-snapshot.log` | `npx vite-node --config vitest.config.ts /tmp/aura-perf03/snapshot.ts before` | 0 | 6.355 |
| `graph-baseline-update.log` | `graphify update .` | 0 | 22.130 |
| `graph-baseline-diagnose.log` | `graphify diagnose multigraph` | 0 | 1.545 |
| `graph-worker-query.log` | `graphify query listWorkers --budget 2200` | 0 | 0.911 |
| `deterministic-red.log` | `npx vitest run tests/integration/perf03-worker-list.test.ts --maxWorkers=2 --minWorkers=2` | 1 | 9.283 |
| `deterministic-red-sealed.log` | `npx vitest run tests/integration/perf03-worker-list.test.ts --maxWorkers=2 --minWorkers=2` | 1 | 9.429 |
| `matched-before-scale.log` | `npx vite-node --config vitest.config.ts /tmp/aura-perf03/scale.ts before` | 0 | 4.096 |
| `matched-before-electron.log` | `node tests/electron/perf03-worker-list.mjs before` | 1 | 29.266 |
| `focused-green.log` | `npx vitest run tests/integration/perf03-worker-list.test.ts --maxWorkers=2 --minWorkers=2` | 0 | 7.391 |
| `final-typecheck.log` | `npm run typecheck` | 0 | 14.416 |
| `final-lint.log` | `npm run lint` | 0 | 13.521 |
| `final-build.log` | `npm run build` | 0 | 5.667 |
| `matched-after-scale.log` | `npx vite-node --config vitest.config.ts /tmp/aura-perf03/scale.ts after` | 0 | 2.886 |
| `matched-after-electron.log` | `node tests/electron/perf03-worker-list.mjs after` | 0 | 23.532 |
| `final-health.log` | `npx vite-node --config vitest.config.ts /tmp/aura-perf03/health.ts after` | 0 | 11.960 |
| `final-snapshot.log` | `npx vite-node --config vitest.config.ts /tmp/aura-perf03/snapshot.ts after` | 0 | 13.491 |
| `focused-regressions.log` | `npx vitest run tests/integration/perf03-worker-list.test.ts tests/integration/customer-change-04-worker-commission-ledger.test.ts tests/integration/customer-change-04b-single-source-preparation.test.ts tests/integration/e2e03-worker-commission-reconciliation.test.ts tests/integration/worker-full-delete.test.ts tests/integration/worker-financial-transaction-corrections.test.ts tests/integration/bl17-remediation.test.ts tests/integration/ui-wf05-commission-account-selection.test.ts tests/ipc/worker-financial-transaction-security.test.ts tests/ipc/router-coverage.test.ts tests/database/db10-budgets-totals.test.ts tests/integration/post-bl03-financial-projection-ownership.test.ts --maxWorkers=2 --minWorkers=2` | 0 | 92.740 |
| `final-full.log` | `npx vitest run --maxWorkers=2 --minWorkers=2` | 0 | 819.008 |
| `graph-final-update.log` | `graphify update .` | 0 | 32.581 |
| `graph-final-diagnose.log` | `graphify diagnose multigraph` | 0 | 1.463 |
| `graph-final-worker-query.log` | `graphify query listWorkers --budget 2200` | 0 | 0.932 |
| `graph-seal-update.log` | `graphify update .` | 0 | 15.562 |
| `graph-seal-diagnose.log` | `graphify diagnose multigraph` | 0 | 1.258 |

Earlier native observer diagnostics (excluded from primary matched performance samples):

| Evidence log | Exact command | Exit | Wall seconds |
|---|---|---:|---:|
| `native-red.log` | `node tests/electron/perf03-worker-list.mjs before` | 1 | 0.930 |
| `native-red-launch.log` | `node tests/electron/perf03-worker-list.mjs before` | 1 | 5.903 |
| `native-red-complete.log` | `node tests/electron/perf03-worker-list.mjs before` | 1 | 39.502 |
| `native-red-sealed.log` | `node tests/electron/perf03-worker-list.mjs before` | 1 | 36.649 |

Native matched commands include environment values recorded in harness JSON: `PERF03_FIXTURE=$HOME/aura-evidence/perf02/fixture/erp.db`, `PERF03_EVIDENCE_DIR=/tmp/aura-perf03/matched`; both runs used workspace out at their respective pre-edit/post-build stages; original main SHA `a92371b6da444817cedaa2f6b7ac7739e166bf26405a4dfd0696c5cbe7a22200` equals durable backup. Replaying before now requires `PERF03_BUILD_DIR=$HOME/aura-evidence/perf03/backup/out`. Native execution required permitted macOS process access; automatic approval did not reject the action. Exact command arrays, script content, SHA identity and logs are retained. Replaying pre-edit service benchmarks requires an isolated source copy with the preserved original worker owner; a before phase label alone does not restore original code.

## 16. Final SHA-256 scope comparison

Final manifest contains **4,210** files, including this report. Against the sorted 4,206-file preservation baseline: **14 modified, 4 added, 0 deleted**. Modified: the single production worker service, `out/main/index.js`, and 12 generated Graphify artifacts. Added: the two PERF-03 test files, this report, and one generated Graphify AST cache file. All exact relative paths and before/after hashes are in `comparison.json` and the manifests; manifest/report hashes are in durable external `seal.json`. Compiled preload and all nine renderer files are byte-identical. No other existing source/test/config/schema/asset/report file changed.

No unrelated source, existing tests, configuration, manifests/lockfiles, assets, schema/migrations, authentication/security, reports/PDF or backup/recovery changes. Preserved original helper/constants/writers/history tail and IPC/preload/renderer hashes independently checked. No pre-existing test deletion or skip. The report itself is added only after checks and hashed in external seal.

## 17. Mandatory gate matrix

| Gate | Result |
|---|---|
| N+1 reproduced in RED | PASS |
| Bounded SQL count in GREEN | PASS |
| Original vs grouped financial equivalence | PASS |
| Independent oracle agreement | PASS |
| Ordering/pagination preserved | PASS — original unpaged contract, master order and filters exact |
| Real Electron worker-list correctness | PASS |
| Permissions preserved | PASS |
| SQLite / 73 reconciliations | PASS |
| Full Vitest / Typecheck / Lint / Build | PASS |
| Graphify | PASS |
| Unauthorized changes | NO |
| STOP condition triggered | NO |

## 18. Limitations and preserved statuses

Windows-native: **NOT TESTED**. No Windows qualification, packaged release readiness or deployment claim. Native fixture has 1000 settled workers; varied nonzero states covered with deterministic real-service and registered-route tests. Existing unpaged rendering/long tasks remain outside authorization. No new performance SLO or broader security/data-recovery audit. Owner review is pending; recommendation is supported by this isolated evidence rather than a claim of owner approval.

Preserve PERF-01 **VERIFIED CLOSED** for documented M-scale case and PERF-02 **VERIFIED CLOSED** for documented L-scale customer-search case, each subject to latest owner-reviewed evidence. PERF-03 is recommended **VERIFIED CLOSED** based on this report. BDR-01 **OPEN**; BDR-02 **VERIFIED CLOSED**. STOP conditions triggered: **NONE**. Work stops after evidence sealing; await explicit owner authorization for any next task.
