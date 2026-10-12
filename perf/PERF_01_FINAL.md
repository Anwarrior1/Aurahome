# PERF-01 — bounded report presentation

## 1. Executive verdict

**PERF-01: PARTIAL.** The report viewer now mounts at most 50 data rows, preserves the complete logical report, and materially improves the matched compiled macOS Electron measurements. All 10,034 customer rows were verified across 201 pages without a value/order discrepancy. The strict compiled Electron harness still exits 1 because full M-scale native print/PDF delivery fails in the unchanged output owner with `ERR_INVALID_URL`; complete output HTML was prepared for both actions. This is a separately observed existing output-delivery boundary, not a pagination truncation. No printing fix or broader remediation was attempted.

Matched visible p50 improved from **795.56 ms to 83.40 ms** (89.52% lower). Mounted rows changed from 10,034 to 50; live DOM elements from 70,472 to 592. Renderer working set after three switches changed from 1125.16 MiB to 284.56 MiB. These are local observations, not a guaranteed SLO or evidence that all renderer memory risk is eliminated.

Full gate: **3619 passed (3619)**, files **280 passed (280)**; exit 0; wall 785.595 s. Final typecheck/lint/build: exit 0; wall 17.918 s; exit 0; wall 16.534 s; exit 0; wall 6.756 s. Fresh and populated SQLite health/reconciliation passed. Owner review is required; no VERIFIED CLOSED verdict is issued.

## 2. Exact PERF-01 scope

Only report-view presentation changed. `ReportsPage` retains the complete authorized report DTO and totals, uses a private report-only 50-row presentation component, and reuses the existing `Pager`. Shared `DataTable`, report SQL, aggregation, rounding, IPC requests, financial writers, session/permission owners and document output owners remain byte-identical. No dependency, schema, migration, configuration, existing test or previous report changed.

PERF-02 OPEN; PERF-03 OPEN; BDR-01 OPEN; BDR-02 VERIFIED CLOSED — all unchanged. No Windows qualification, release-readiness work or unrelated remediation occurred.

## 3. Ponytail FULL source and Graphify ownership

The complete `PERFORMANCE_AUDIT.md` was reviewed, including its M-scale UI measurements, L-scale service/IPC measurements and deliberate omission of L full-DOM rendering. Source review established this chain:

`ReportsPage` selection/date/month input → existing `useQuery('reports','available'/'build')` → fixed `window.erp.reports` preload API → `reports:available` / `reports:build` → registered router Zod validation → `createHandler` WebContents-bound session, permission and restore-lifecycle admission → `buildAuthorizedReport` report-specific permission → `buildReport` authoritative SQLite/financial owners → full `ReportDTO` → full renderer state → private `ReportRows` slice → unchanged `DataTable` cells → visible page.

Source references:

- `src/renderer/pages/reports/ReportsPage.tsx`: `ReportRows` line 14, `ReportsPage` line 45, `output` line 67, keyed presentation line 110. Old page function began at line 12; old unbounded table supplied every DTO row.
- `src/renderer/lib/useQuery.ts`: existing full DTO state/reload owner; replaced data after successful requests. No query cancellation, caching, race or IPC-contract redesign was introduced.
- `src/renderer/components/ui/index.tsx`: `DataTable` line 170 maps every supplied row; `Pager` line 315 supplies previous/next and total/page information. Both are unchanged and retain their unrelated consumers.
- `src/preload/api/build-api.ts` and `src/shared/constants/channels.ts`: existing fixed methods/channels; no page/offset argument introduced.
- `src/main/ipc/router.ts`: reports registration around 3045–3064; print around 3112–3129; PDF around 3134–3153.
- `src/main/ipc/guard.ts:38`: schema/session/permission handling and normalized responses. Unauthorized data is rejected before report construction.
- `src/main/services/reports/reports.service.ts`: report permission matrix around 48, `buildAuthorizedReport` 75, `buildReport` 81, customer balances 178. Ordering and totals remain authoritative main-process results.
- `src/main/services/parties/parties.service.ts:212`: customer financial projection, confirmed/completed order inclusion, remaining-descending/name-ascending order.
- `src/main/services/documents/print.service.ts:92`: complete `renderReportHtml`; `loadHtml` around 96 uses an encoded data URL; print/PDF owners around 106/166 remain unchanged.
- `src/main/reports/templates/documents.template.ts:498`: complete columns, every DTO row, period and complete totals rendered into independent output HTML.

The affected viewer serves all 16 existing keys: sales, orders, customer_balances, supplier_balances, purchases, inventory, inventory_valuation, material_consumption, waste, expenses, order_costs, order_profitability, monthly_profit, cancelled_orders, worker_balances, payroll. Their calculations/permissions were not changed. All share the same generic string-column presentation; no service result is sliced. Runtime scale evidence concentrates on customer balances; existing report regressions cover other owners, not a claim of 16 separate M-scale UI benchmarks.

Every report output entry point was inventoried by `rg`: the report viewer's print/PDF buttons and `ProfitPage`'s monthly-profit print/PDF buttons. Each sends report parameters to existing documents methods. Main rebuilds the complete authorized report; it never consumes `ReportRows` or the visible slice. No report CSV/XLS export or renderer `window.print` path was found. Native physical printer testing is NOT TESTED.

## 4. Baseline SHA-256 and environment

No Git repository: `git rev-parse --is-inside-work-tree` returned 128; no clean Git state is claimed. A sorted 4,189-file manifest was captured before the new tests and production edit: `/tmp/aura-perf01/before.json`, SHA-256 `8a3f65d28315704d0bc78b5c9f11f9a0d7524fefaeaa4aca8f8ade020437083c`. It covers source, existing tests, migrations/schema, scripts/configuration, resources, lockfiles, prior reports, compiled output and Graphify artifacts. Existing workspace content was preserved, not assumed pristine.

macOS 26.5.2 / 25F84, arm64 MacBookAir10,1, Apple M1 8 cores / 16 GiB RAM; Node 24.17.0, Electron 43.6.0, SQLite 3.53.4. Native read-only `sysctl` hardware verification was executed after its sandboxed invocation was unavailable. Disk inspection reported 28 GiB available. Environment evidence: `/tmp/aura-perf01/environment.json`. Runtime is unpackaged compiled macOS Electron, not a signed Windows installer.

Only fictional disposable data was used. The existing service-seeded M fixture `/tmp/aura-performance-audit/M-run2/data/erp.db` was copied into new isolated userData/sessionData directories. Its source SHA was `682e541efb6cb327d562d42c1761c17e38a8f8a296a83aecfabff8b5e9c5584d` and matched before/after. One fictional customer was created through real registered IPC before measurement, yielding 10,034 rows with 1,010 orders, 510 expenses, 200 FIFO layers and 60 worksheets. The fixture's independent cash/stock oracles remain 143,140,000 minor units / 1,940,000,000 micro units. No real user database or real backup was accessed.

## 5. Deterministic RED evidence

Before production edits:

```sh
npx vitest run tests/unit/renderer/perf01-report-rendering.test.ts --maxWorkers=2 --minWorkers=2
```

Actual React server rendering of the real `ReportsPage` and `DataTable` failed the mounted-row bound at both 51 and 10,034 rows: expected 50, received 51 / 10034. Four existing logical-preservation/boundary cases passed (0/1/49/50), two bounded-render requirements failed. Exit 1, 1.083 s wall; Vitest 452 ms. Immutable DTO/order/value/totals assertions intentionally protect already-correct logical content; they do not manufacture a financial failure. Logs: `/tmp/aura-perf01/red.log` and `red-result.json`.

Actual pre-fix compiled Electron used the isolated M fixture, real login, fixed preload, registered handlers and SQLite. It mounted 10,034 rows and 70,472 live elements; the explicit final at-most-50 assertion failed `10034 !== 50`. Command `node /tmp/aura-perf01/electron.mjs before`; exit 1; wall 10.374 s. Machine evidence/screenshot: `before-electron.json`, `before-report.png`. Full DTO and totals were captured, not mocked.

No artificial sleep or timing threshold was used as the RED trigger. The condition was deterministic DOM cardinality. Navigation was absent before the change; new first/previous/next/last behavior was exercised after implementation in the permanent compiled harness.

## 6. Selected design and rationale

| Approach | Contract fit | Cost / decision |
|---|---|---|
| Report-only fixed pagination | Full DTO/totals retained; no SQL/IPC/output changes; native buttons and existing RTL styling | Chosen: 50 rows, first/previous/next/last, existing Pager, no dependency |
| Virtualization | Could preserve logical rows, but requires scroll-window/overscan, row height, focus/accessibility and RTL handling | Rejected for this isolated fix: greater complexity without a demonstrated need |

The shared DataTable is deliberately unchanged. Complete data is not duplicated into page state; state is one integer and a temporary slice contains at most 50 references. Output remains independent of the page. Native buttons support normal keyboard activation and expose disabled boundaries; Arabic labels and `nav[aria-label="صفحات التقرير"]` identify report navigation. No formal screen-reader certification is claimed. Controls are below the table and can require scrolling through the 50-row page.

## 7. Exact production changes

Only `src/renderer/pages/reports/ReportsPage.tsx` changed:

1. Import existing `Pager`.
2. Add private `REPORT_PAGE_SIZE = 50` and `ReportRows`.
3. Clamp displayed page to the current row count; slice only the presentation array.
4. Use original absolute row ordinal `offset + index` as identity within authoritative ordering, replacing page-local ordinals. DTOs do not provide a generic persistent ID; no unsupported identity field was invented.
5. Add first/previous/next/last controls with disabled bounds, full logical row/page count, Arabic labels.
6. Key the local component by existing report parameters so report/filter/month selection remounts page state at zero.

Loading/empty behavior, original column mapping/numeric styling, full title/totals, period inputs and output payloads remain intact. Loading hides the table and pager; changing results replaces the old DOM. Existing `useQuery` lifecycle remains unchanged; this does not claim to repair unrelated asynchronous request races.

Exact review diff: `/tmp/aura-perf01/production.diff`. The pre-fix page was reconstructed from the reviewed source and verified to match its preserved baseline hash before generating this diff; it was not reinstalled into production.

## 8. GREEN and permanent coverage

New permanent files:

- `tests/unit/renderer/perf01-report-rendering.test.ts`: actual React/actual page/table, 0/1/49/50/51/10034 row cases, at most 50 initial rows, exact visible order/strings, unchanged frozen logical DTO and complete totals/metadata.
- `tests/ipc/perf01-report-contracts.test.ts`: fresh migrated service-created 101-customer fixture; real registered router/guards/session/SQLite with Electron shell stub; full ordered rows and exact supported monetary formatting; print/PDF HTML each contains all 101 rows; anonymous/forbidden/confidential report/export denial; whole-table snapshots remain identical; 73 reconciliations have no findings. Only printer/PDF delivery leaves are substituted in this integration suite.
- `tests/electron/perf01-report-pagination.mjs`: permanent real compiled harness; requires an explicit fictional `/tmp` M fixture, copies it into unique temporary runtime directories, never runs against its source DB. Traverses and compares all 201 pages/10,034 rows and all six columns; checks first/previous/next/last disabled bounds, last-page 34 rows, sales/customer switching/reset, repeated navigation, real report IPC, output preparations, real small-report PDF, real permission denial and read-only logical hash. It deliberately retains the strict failing large-output delivery assertion.

| Check | RED / pre-fix | GREEN / changed viewer |
|---|---|---|
| 51 logical rows | 51 mounted; bound fails | 50 mounted; passes |
| 10,034 logical rows | 10,034 mounted; bound fails | 50 mounted; passes |
| Empty / 1 / 49 / exactly 50 | Logical content already correct | Initial presentation passes |
| Full DTO / money / totals | Correct, preserved | Exact same content hash and independent oracle |
| First/middle/last page | No bounded page controls | 201 pages, all 10,034 rows exact; final 34 |
| Switch and return | Unbounded dataset remounted | Page 1 of 201 after switch/reset |
| Authorization/read-only | Existing trusted owners | Integration and actual Electron denial/no-write proof |
| Full print/PDF preparation | Main owner builds full DTO | Both actual M requests prepared all 10,034 rows |
| Full M native output delivery | Existing unchanged owner | FAIL `ERR_INVALID_URL`; not hidden or bypassed |

Focused final command and full file list are recorded verbatim in `/tmp/aura-perf01/focused-corrected-result.json`; **434/434 tests, 13/13 files, 0 failures**, exit 0; wall 72.943 s, Vitest 72.38 s. Initial focused runs revealed errors in the new test's assumptions about phone/count columns and Arabic money display; the new expectations were corrected to exact real contracts (empty phone, `0` order count, `0,00 د.ل`). No production financial behavior or existing assertion was changed. The original deterministic mounted-row assertions were unchanged.

## 9. Actual Electron before/after protocol and observations

`REAL_UI_ELECTRON` / `REAL_IPC_ELECTRON`: actual compiled main, preload, renderer, real session/permission guards and real fictional SQLite; network set offline. Original compiled main and preload are byte-identical after rebuild. The external launcher only selects disposable runtime paths, observes handlers and intercepts the native printer leaf; it does not replace business services, report responses or guards.

Protocol: login owner, create one fictional customer, capture complete report, 10 full report IPC samples, then one warm-up report cycle and five measured sales→customer selections. A measured selection completes when the actual title and expected tbody row count are present followed by two animation frames. Controller monotonic `performance.now` includes interaction/IPC/state/DOM completion and test-observation overhead; it is neither SQL time nor pure paint time. Warm OS caches; no cache flushing or forced GC. No tests/builds ran concurrently with those UI measurement samples. Nearest-rank p50/p95; with five samples p95 is the maximum, not a statistically stable tail guarantee. No p99 claim.

Historical audit and matched current baseline are distinguished below:

| Metric | Before | After | Evidence |
|---|---|---|---|
| 10,034-row visible p50, historical audit | 852.26 ms (audit n=3) | 83.40 ms (current n=5) | REAL_UI_ELECTRON; different warm-up history |
| Visible p95, historical audit | 885.42 ms | 83.57 ms | REAL_UI_ELECTRON; limited sample count |
| Matched current visible p50 / p95 | 795.56 / 851.36 ms | 83.40 / 83.57 ms | Same source fixture, same warm-up/observer protocol |
| Mounted rows | 10,034 | 50 (last page 34) | Actual DOM; 201-page comparison |
| Live DOM elements | 70,473 historical; 70,472 matched | 592 | Actual document element count; one-node historical difference disclosed |
| Renderer after repeated switching | 1,142.5 MiB historical; 1125.16 MiB matched | 284.56 MiB | Actual Electron Tab workingSetSize / 1024 |
| Full M report IPC p50 / p95 | 48.60 / 50.10 ms | 47.80 / 50.00 ms | Fixed preload → registered IPC; n=10 |
| Full M report service p50 / p95 | 25.67 / 29.04 ms | 25.09 / 26.85 ms | REAL_SERVICE_SQLITE; n=10, same unchanged source |
| Complete DTO UTF-8 bytes | 1,837,371 | 1,837,371 | JSON bytes; not a complete wire-protocol byte count |
| Financial/report parity | Complete expected dataset | All rows/order/columns/totals exact | Independent integer oracle + full logical comparisons |
| Export/print completeness | Main rebuilds full report | Complete HTML; large native delivery FAIL | Actual handler/window admission; no truncation |

Raw before visible samples: `[782.9239160000002, 851.3595409999998, 749.878084, 795.5556659999993, 804.2391670000015]` ms. Raw after: `[83.42254099999991, 83.37704199999962, 83.56750000000011, 83.39416699999992, 83.40420900000026]` ms. All raw service/IPC/page navigation, process and heap samples are retained in the JSON evidence; outliers were not removed. Middle-page previous+next pair n=5 p50/p95 99.84/100.19 ms. Last+first round-trip n=20 p50/p95 116.62/118.79 ms. These are two-action round trips, not single-page latency. All pages were also compared without a timer-based pass threshold.

The matched pre-fix session recorded 19 main-renderer long tasks, maximum 624 ms; the final post-fix monitored session recorded 0. Observer starts after login and covers the monitored report session, not every process or a multi-hour soak. Dashboard navigation completed while leaving reports; no quantitative claim about all unrelated modules is made.

## 10. DOM and boundedness

50 data rows is independent of logical dataset size. Column count is still the existing report-specific count. Initial/return page had 50 rows, the last page had 34; every row was encountered exactly in its authoritative position. Page changes issue no report build IPC; only existing report selection/filter changes rebuild data. Full title and debt totals remain from the full DTO, not a page subtotal. Departing reports returned live DOM count to 323.

Screenshots `/tmp/aura-perf01/before-report.png` and `after-report.png` were captured; the post-fix screenshot was visually inspected. DOM measurements and complete row comparisons are the primary boundedness proof, not appearance alone.

## 11. Renderer memory

| Checkpoint | Matched before MiB | After MiB |
|---|---:|---:|
| Login | 139.73 | 140.08 |
| First report | 764.44 | 254.14 |
| After three switches | 1125.16 | 284.56 |
| After all-page verification and 20 last/first pairs | NOT TESTED / no equivalent pagination | 449.89 |
| Immediately after leaving | 1139.92 | 420.67 |

Used JS heap after three switches: 80.48 → 39.90 MiB; after leaving: 45.39 → 8.72 MiB. CDP readings are observations, not forced-GC retained-object analysis. The complete DTO is still fetched/retained while viewing; Chromium allocator/working-set caching remains and memory grows during extensive page traversal. No leak elimination, low-memory guarantee or long-duration stability claim is made. Memory checkpoints were taken before full-output attempts, so output windows do not contaminate the viewer comparison.

## 12. Backend and IPC impact

Service timings were collected sequentially from the preserved before-run and after-run SQLite files using the byte-identical backend after the presentation correction. They are not a time-series measurement of a backend code change. Report service, permission guards and IPC contracts are unchanged; tiny measured service/IPC differences are normal local variation, not an optimization claim. The full DTO content SHA is `d8a70c9713da75710142e49a050e32ef7ca1bb135e2ea407a79e92e09d48b7f9`, exactly equal to before. Final compiled session observed 54 registered calls, including fixture/auth/read/output activity; raw channels, payloads, normalized codes and handler timings are in `after-electron.json`. Each of the 201 pages uses already-loaded data; no server page parameter is added.

Audit's L service p50 311.43 ms / IPC 511.60 ms are historical L context only. This change did not remeasure L full-DOM rendering or L payload/memory. Large full DTO, backend calculations and transport costs remain residual limitations.

## 13. Financial, output and security preservation

Independent oracle (`/tmp/aura-perf01/oracle.ts` / `oracle.json`) reads fictional customer/order facts, selects only confirmed/completed orders, reduces integer totals/paid values, orders by debt/name and uses only the existing shared display formatter. All 10,034 rows/six fields match, including the complete debt **42,750,000 minor units → 42.750,00 د.ل**. This expectation was not copied from the report service result. Cash and FIFO independent fixture oracles also match.

Normal report viewing/output preparation preserved a whole-database logical SHA before/after: `159105d3c3c3590ce6ec4512e952651b3b8749fff115095b5f343f779d97de73`. Real compiled calls after logout returned UNAUTHENTICATED; the fictional restricted reader returned FORBIDDEN. Permanent registered-handler tests additionally cover a permitted customer-report reader denied worker financial details and export authority. No new write path or IPC channel was added. Runtime contextIsolation/sandbox/webSecurity stayed true and nodeIntegration false; authentication/session/permission owners remain unchanged.

Print/PDF on page 201 sent only existing `key/year/month` report parameters, never visible rows. Both preparations contained all 10,034 rows and matched every ordered cell against the logical DTO. Both full-size native deliveries returned INTERNAL_ERROR; child logs show `ERR_INVALID_URL (-300)` at unchanged `loadHtml`'s data URL. A real monthly-profit PDF subsequently succeeded and its `%PDF` header was verified at `/tmp/aura-perf01/after-runtime-40414/documents/2026/reports/monthly_profit-1791538077130.pdf`. Full customer-report PDF was not delivered; it is not labeled PASS. Printer leaf was intercepted to avoid a real print job, and the large request failed before reaching it; no physical printer proof exists.

Backend output source hashes and compiled main match pre-change baseline, establishing that this boundary was not introduced by the report-view modification. No encoded URL transport, print security/CSP or file-format change was made to solve it. The strict permanent Electron harness remains exit 1 on this gate. No blanket skip or permissive matcher converts it to PASS.

## 14. SQLite integrity and reconciliations

`npx vite-node --config vitest.config.ts /tmp/aura-perf01/health-service.ts`: exit 0; wall 2.891 s. Fresh disposable migrated DB and both populated runtime DBs: 53 migrations, SQLite 3.53.4, integrity ok, zero FK violations, 73 checks, zero errors/warnings/findings. Read-only report/service/reconciliation work preserved every table hash. Expected cash 143,140,000 minor units and FIFO stock 1,940,000,000 micro units remained exact. Customer creation and login/logout audit events occur during setup/authentication, outside the measured no-write boundary; they are legitimate operational changes, not report mutations. PDF writes stayed under disposable userData/documents.

`npx vite-node --config vitest.config.ts /tmp/aura-perf01/oracle.ts`: exit 0; wall 0.847 s. No invented repairs, financial mirrors, schema changes or historical business-date mutations occurred.

## 15. Full regression/typecheck/lint/build

```sh
npx vitest run --maxWorkers=2 --minWorkers=2
npm run typecheck
npm run lint
npm run build
```

Current full result: files **280 passed (280)**, tests **3619 passed (3619)**, duration **784.99s (transform 3.77s, setup 0ms, collect 71.34s, tests 1453.81s, environment 38ms, prepare 11.08s)**, exit 0; wall 785.595 s. Failed tests/files: **0/0**. Skipped tests: **0**. Unhandled errors: **0**. No test or timing threshold was changed. DB-08 guarded admission elapsed **702.1672919999999 ms** against its unchanged **2,000 ms** threshold; `tests/database/db08-inflight-lifecycle.test.ts` SHA-256 stayed `3cae17a65e2bdcaa96019126452f8614ebba29ac6cbb286dabb3d2b92b9c4a98`. The historical 3,611/278 baseline is not substituted for this run. Eight new Vitest cases / two files explain the increase if the current counts are 3,619/280.

Focused final 434 tests/13 files passed, including report completeness, material consumption, financial projection ownership, SEC-01/02/03/04 and E2E-01/02/03. Full-suite output additionally supplies unchanged UI-WF-01..08, backup/restore/BDR, FIFO/freeze, required audit atomicity, BL-22, Contract C and other business gates. See `/tmp/aura-perf01/full.log` for exact test names and DB-08 timing output. No isolated retry is substituted for a full-suite result.

Final typecheck exit 0; wall 17.918 s, lint exit 0; wall 16.534 s, build exit 0; wall 6.756 s. Main/preload bundle hashes are unchanged; renderer bundle is regenerated. Build logs report the 1,266.71 kB renderer bundle and no warnings matching warning/deprecation/error diagnostics; this is not a claim that bundle size was optimized. Native output delivery is a separate failing gate despite passing Vitest/build.

## 16. Final Graphify

Both baseline and final executed/awaited `graphify update .` and `graphify diagnose multigraph`. Logs/result JSON are under `/tmp/aura-perf01/graph-*`. Baseline update exit 0; wall 17.661 s, diagnosis exit 0; wall 1.240 s; final update exit 0; wall 17.959 s, diagnosis exit 0; wall 1.251 s.

| Metric | Baseline | Final |
|---|---:|---:|
| nodes | 7152 | 7170 |
| raw_edges | 13758 | 13785 |
| unverified_code_nodes | 0 | 0 |
| missing_endpoint_edges | 0 | 0 |
| dangling_endpoint_edges | 0 | 0 |
| exact_duplicate_edges | 0 | 0 |
| directed_same_endpoint_collapsed_edges | 0 | 0 |
| undirected_same_endpoint_collapsed_edges | 0 | 0 |
| self_loop_edges | 32 | 32 |
| producer_suppression_sites | 12 | 12 |
| communities | 392 | 398 |

Queries recorded in `graph-reports.txt`, `graph-page.txt`, `graph-authority.txt` and `graph-final-page.txt`. The broad baseline query truncated 19 of 76 nodes; narrower source-owner queries plus full direct source reads resolved owners/output boundaries. Graph relationships are supporting structural evidence, not latency, financial or security proof. Static JSX/alias relationships can be incomplete; direct source/runtime checks supply actual integration. Communities are algorithmic and labels can be renamed during update; pre-existing self-loops and producer suppression are disclosed, not interpreted as regressions or repaired.

Exact topology delta: **18 nodes / 27 edges added, zero nodes/edges removed**; one production node `ReportRows`, two renderer-test nodes, seven IPC-test nodes and eight Electron-harness nodes. Communities changed 392→398 by re-clustering; self-loops remain 32 and suppression sites remain 12. The node/file attribution was inspected; no unexplained production-owner change was found. Topology changes are associated with the private presentation component, Pager import and new tests/harness. There is no new production renderer→database/filesystem edge, IPC method or backend owner. Diagnostic comparison and source-node details are retained in `/tmp/aura-perf01/graph-delta.json`.

## 17. SHA-256 comparison and change control

Sorted final manifest `/tmp/aura-perf01/after.json` and complete comparison `/tmp/aura-perf01/comparison.json` identify every modification/addition/deletion. The final report's own hash is sealed externally after report creation, avoiding a recursive self-hash claim.

Modified non-generated files:

- `src/renderer/pages/reports/ReportsPage.tsx`

Added non-generated files:

- `PERF_01_FINAL.md`
- `tests/electron/perf01-report-pagination.mjs`
- `tests/ipc/perf01-report-contracts.test.ts`
- `tests/unit/renderer/perf01-report-rendering.test.ts`

Generated renderer build and Graphify changes are separately enumerated in the complete comparison. Old renderer JS is replaced by its new content-hashed bundle; compiled index references it. Main/preload, branding, backend services, BDR trust/recovery, archive/restore, schema/migrations, configuration, package/lockfiles, every pre-existing test and prior report remain byte-identical. No real user data was touched. No concurrent work was reverted.

| Owner | Baseline SHA-256 | Final SHA-256 |
|---|---|---|
| `src/renderer/pages/reports/ReportsPage.tsx` | `3aa68fcfacc2ace4e664b33589a55ac049865cbd15959667c36082ca677dc208` | `0845b35469c24114324fc08d18b5bac3548fdf5b1ca50dffa054f771cbc34f9c` |
| `src/renderer/components/ui/index.tsx` | `a982d757895876c5af5fae64009c9edde487ca18ce50ffb146aca629a252e3a6` | `a982d757895876c5af5fae64009c9edde487ca18ce50ffb146aca629a252e3a6` |
| `src/main/services/reports/reports.service.ts` | `1d7ce5b6afbc774e971b7786309932dbec9f5726960ea4921346a1232d234c94` | `1d7ce5b6afbc774e971b7786309932dbec9f5726960ea4921346a1232d234c94` |
| `src/main/services/parties/parties.service.ts` | `47ad6f4ee3d14af2d00a5d0bf42a1b0d4f3f88d7585db80d717e0bba415501d3` | `47ad6f4ee3d14af2d00a5d0bf42a1b0d4f3f88d7585db80d717e0bba415501d3` |
| `src/main/services/documents/print.service.ts` | `c69b19caa40ae62ceec612bd671370924dca1c38b064fe1435a0b8f46f691de1` | `c69b19caa40ae62ceec612bd671370924dca1c38b064fe1435a0b8f46f691de1` |
| `src/main/reports/templates/documents.template.ts` | `ea3b08b72c11026443a46f23b6587e004e995ae16abb2ed9cd0e5d7d20cf687c` | `ea3b08b72c11026443a46f23b6587e004e995ae16abb2ed9cd0e5d7d20cf687c` |
| `src/main/ipc/router.ts` | `5e2cbd86926b521a04e57c7ca6185e5c9c837b4576d73092d3b5a98ae61e3223` | `5e2cbd86926b521a04e57c7ca6185e5c9c837b4576d73092d3b5a98ae61e3223` |
| `out/main/index.js` | `941aeccce10d0bac14cc31992e1c092d08ebf39fa26439d378d5a3cfda020120` | `941aeccce10d0bac14cc31992e1c092d08ebf39fa26439d378d5a3cfda020120` |
| `out/preload/index.cjs` | `d4d0def0b98e03f884abc424199d4995da940495c5a346f73a66f56a60388d58` | `d4d0def0b98e03f884abc424199d4995da940495c5a346f73a66f56a60388d58` |

New test/harness files are permanent regression additions; external benchmark/oracle/health/report-generation helpers and all disposable databases/screenshots/logs remain in `/tmp/aura-perf01/`. Existing test files were neither removed nor weakened.

## 18. Remaining limitations

- Full M print/PDF delivery gate failed in the unchanged data-URL output owner. Complete data preparation is verified; successful full-size native delivery is not. This prevents the requested unconditional closure recommendation here.
- Full report SQL and IPC still transfer/retain all rows. M DTO is 1,837,371 bytes; L/XL full renderer memory and latency are NOT TESTED in this remediation.
- Fifty rows bound data DOM, not report column count, DTO size, all browser allocations or output HTML size. Long-lived/low-memory sessions were not qualified; no forced-GC leak claim.
- Empty/small/boundary initial rendering is real component SSR; complete 201-page navigation/switching is actual compiled Electron. Small synthetic navigation was not separately exercised through native Electron for each row-count case. No formal screen-reader certification, Windows-native or physical-printer coverage.
- Early verification attempts had harness-only collapsed-sidebar and default polling-window failures. Their raw evidence was retained (`after-navigation-harness-failed.*`, `after-output-observation-failed.*`). Subsequent strict runs exposed the real output error; it was not erased or treated as a passing observation. Final valid UI samples and all prior samples are retained separately; no performance outlier filtering occurred.
- Initial new IPC-test authoring mistakes were corrected to source-derived exact formatting/column contracts; existing tests and mounted-row bounds were untouched.

## 19. Windows native

NOT TESTED. Only compiled unpackaged macOS Electron was executed. No Windows installer, native ACL, Windows performance or recovery qualification claim is made.

## 20. Final verdict and owner review

```text
PERF-01:
PARTIAL

DETERMINISTIC RED:
PASS

BOUNDED REPORT DOM:
PASS — 50 DATA ROWS MAXIMUM

FULL LOGICAL REPORT / MONEY / ORDER / TOTALS:
PASS

REAL COMPILED ELECTRON VIEWER:
PASS

FULL M-SCALE PRINT/PDF DELIVERY:
FAIL — UNCHANGED OWNER, ERR_INVALID_URL

FULL VITEST:
PASS

TYPECHECK / LINT / BUILD:
PASS

SQLITE INTEGRITY / FOREIGN KEYS / RECONCILIATIONS:
PASS

PONYTAIL FULL:
COMPLETE

GRAPHIFY:
PASS

UNAUTHORIZED SOURCE CHANGES:
NO

PERF-02 / PERF-03:
OPEN — UNCHANGED

BDR-01:
OPEN — UNCHANGED

BDR-02:
VERIFIED CLOSED — UNCHANGED

WINDOWS NATIVE:
NOT TESTED

READY FOR OWNER REVIEW:
YES
```

Review the bounded viewer and measured benefit separately from the unchanged output-delivery limitation. No output remediation, PERF-02/03 work, recovery work, new audit phase or release-readiness claim is authorized or performed. Work stops after this report.
