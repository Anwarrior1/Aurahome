# PERF-02 — Customer search coalescing

## 1. Executive verdict

**PERF-02: VERIFIED CLOSED — recommended for owner review.** The correction is confined to `src/renderer/pages/customers/CustomersPage.tsx`. The actual customer input remains immediate; a customer-local 150 ms timer coalesces nonblank search changes. Pending results are hidden, and a keyed result-query instance prevents an old response from becoming the new query's rows. The shared query hook and all trusted main-process owners remain unchanged.

The matched 20-trial macOS Electron comparison reduced a 13-character burst from **13 registered searches to one**. Primary matched results: accumulated handler p50 **426.04 → 42.35 ms**, input-to-visible p50 **494.40 → 244.20 ms**, p95 **512.40 → 332.20 ms**. Deliberate waiting increased; downstream request-to-visible latency did not improve. These measurements include observation overhead and are not product SLOs.

Final gates: **3,651 tests / 283 files passed**, no failures/skips/unhandled Vitest errors; typecheck/lint/build and Graphify exit 0. Lint has 26 disclosed test typing warnings. Fresh/populated SQLite integrity and all 73 reconciliations pass. Native hardware IME is not certified; actual component and compiled Electron DOM composition are tested.

## 2. Authorization and preservation scope

Only PERF-02 was remediated. No SQL, filter, ordering, query-limit, cursor, schema, migration, IPC, preload, authentication, permission, restore-admission, financial, report, print, backup or recovery contract was changed. No dependencies were installed or upgraded. No real customer database was opened. There is no Git repository (`git status --short` exits 128); comparison uses a sorted file-hash manifest and an external original-file copy.

Ponytail FULL and Graphify were applied for owner discovery and direct source tracing. Existing tests and thresholds were not edited. PERF-03 and BDR-01 remain OPEN; BDR-02 remains VERIFIED CLOSED. `PERF_01_OUTPUT_FINAL.md` recommends scoped M-scale viewer/output closure subject to owner review; this task preserves that implementation and report rather than independently granting official closure.

## 3. Root cause

Originally the search input's `onChange` updated the exact state passed into `usePagedQuery`. Every changed serialized filter caused its effect to issue `customers:list`; typing 13 characters produced 13 SQLite-backed handler executions. The main service already returns bounded cursor pages, but each search also computes the matching count and authoritative balances. Debouncing SQL or changing substring matching is unnecessary for this finding.

The existing hook's sequence guard protects the newest **issued** request. It does not make unissued pending input own a request, nor does its passive filter-reset effect prevent a previous page being rendered once under a newly changed query. A simple delayed filter alone is therefore insufficient. One intermediate implementation passed the lightweight component driver but failed native frame observation: old 50-row content appeared after the new settled input. That attempt is retained as failed evidence; it is not the shipped implementation.

## 4. Ponytail FULL trace and Q1–Q13

Current chain: `CustomersPage.tsx:159` controlled input → page-local immediate/committed state and timer (`65–82`) → private `CustomerQuery:36–45`, keyed at `165` → unchanged `usePagedQuery.ts:59–115` → `api.ts` result unwrap → `src/preload/api/build-api.ts:24–30` fixed `customers:list` closure (`channels.ts:80`) → `router.ts:535–550` schema and `customers.view` → `guard.ts:38–83` payload validation, pending-restore check, WebContents-bound session, permission and restore admission → `parties.service.ts:59–111` → real SQLite keyset rows and bounded balance aggregation (`37–50`) plus matching count (`103–109`) → unchanged DTO → hook-owned state → table rows (`CustomersPage:168–202`) and pager (`203`). Customer history remains four separately paged sections (`53–59,104–107`); save/lifecycle reload uses the current query's existing reload (`110–134`). Read-only list operations have no business/audit writer.

| Question | Evidence (file:line, log or measurement) | Result |
|---|---|---|
| Q1 Immediate request on change? | Original external copy: input at 114, list at 58; `usePagedQuery:47,106–115`; `before-electron.json` | Before: yes. After: input updates immediately; nonblank query waits 150 ms. |
| Q2 Intermediate searches while newer text exists? | RED-01 original replay; 20 original native bursts each 13 searches | Yes before; GREEN bursts each one final `NO-MATCH-PERF` request. |
| Q3 Can older response render after input changes? | Hook `70,97,100`; component RED-04 and pre-effect render test; `after-unkeyed-ownership-red-after-electron.json` | Issued-request sequencing alone is insufficient for pending input/one-render handoff. Final keyed result owner plus pending suppression prevents current-display contamination. |
| Q4 Existing identity/cancellation/latest guard? | `usePagedQuery:52,61,70,97–100` | Sequence guard retained. No backend cancellation introduced; an already admitted request may finish. |
| Q5 Pagination reset? | Hook `18,106–115`; keyed child `CustomersPage:165`; GREEN cursor/whitespace-reset cases and native pagination | Settled non-equivalent query/filter starts page one. Clear/blank changes preserve immediate default-list reset. Later pages use settled filters. |
| Q6 Filters/sorting? | `parties.service:64–97`; existing active/archived Select `154–157`; registered contract tests | Active/archived, substring name/phone, ascending name/id and server cursor limits unchanged. |
| Q7 Clearing immediate/delayed? | `CustomersPage:75–78`; RED-06 and whitespace default-page regression | Immediate, with timer cancellation. Blank/whitespace-only input changes reset default pagination; no stale filtered rows. |
| Q8 Work after unmount? | Local effect cleanup `81`; child key ownership `165`; hook event cleanup `usePagedQuery:146–166`; RED-11/native navigation | Pending timer is cancelled. Already-issued work is not cancelled, but React-disposed/key-replaced instances cannot publish current rows. No pending-navigation query in GREEN. |
| Q9 Other hook consumers? | `rg -n usePagedQuery src/renderer --glob '*.tsx'`; unchanged hash | 19 TSX consumers including this page: cash, deliveries, expenses, employees, uncollected, withdrawals, final invoices, purchases, inventory, worksheets, releases, suppliers, orders, audit, order detail, workers, quotations and SearchableOrderSelect. All remain unchanged. |
| Q10 Trimming/normalization? | `src/main/services/base/pagination.ts:29,42–48`; shared max 200; `CustomersPage:68–72` | Main first enforces raw length, then trims. Only valid trim-equivalent nonblank terms are deduplicated. No case folding, wildcard escaping or new normalization. Over-limit whitespace remains invalid. |
| Q11 IME? | Existing shared `Input:139` forwards HTML attributes; original component no composition handlers; final `159–161` | Original could query intermediate composition input. Local composition state now keeps text immediate and holds queries until end. Arabic/component and native DOM-event checks pass; actual hardware IME is NOT TESTED. |
| Q12 Enter/search button? | Original and final search JSX; RED-08 actual component props | Neither exists. NOT APPLICABLE; no new submission behavior introduced. |
| Q13 Old results shown as current while pending? | `CustomersPage:147,167–169,203`; `DataTable:185` loading short-circuit; native frame/race observations | Rows, errors and count are suppressed while pending; paging is disabled. Only result subtree remounts; toolbar/input and dialogs retain identity/focus. |

Graph edges support discovery; direct source and executed cases establish the contracts above. A layout-effect-only ownership attempt was rejected by native evidence; correctness of the final design relies on keyed query-instance identity, not assumptions about passive/layout-effect paint ordering.

## 5. Graphify baseline and final

Commands: `graphify update .`, then `graphify diagnose multigraph` (awaited to completion). Narrow queries: `graphify query CustomersPage --budget 2400`, `graphify query usePagedQuery --budget 2400`, final `graphify query CustomerQuery --budget 1800`. Initial broader search was truncated; narrower searches and `owner-edges.json` plus source inspection resolved relevant owners.

| Metric | Baseline | Final |
|---|---:|---:|
| Nodes | 7,219 | 7,271 |
| Edges | 13,832 | 13,919 |
| Communities | 411 | 410 |
| Unverified code nodes | 0 | 0 |
| Missing/dangling endpoints | 0 / 0 | 0 / 0 |
| Exact duplicate edges | 0 | 0 |
| Endpoint collapses | 0 | 0 |
| Self-loops | 32 | 34 |
| Producer-suppression sites | 12 | 12 |

52 new nodes, none removed, and 87 additional edges belong to the private query owner/type and three new test/harness files. The two new loops are deliberate recursive test tree walkers (`elements`, `resolveQuery`); community regrouping is extraction topology, not business coupling. Producer diagnostics are post-build and cannot prove zero upstream producer loss. No new main-process permission or recovery edge exists. Update: exit 0, 21.98 s; diagnose: exit 0, 1.68 s. Final post-native update (`graph-seal-update`): exit 0, 16.24 s, no topology changes detected; its diagnosis repeats the metrics above. Graph evidence was sealed after source/test implementation; final report prose is not used as functional proof.

## 6. Preservation baseline and fixture identity

Durable evidence: **`/Users/macbook/aura-evidence/perf02/`**, private directory, retained for owner review. Original source copy: `backup/src/renderer/pages/customers/CustomersPage.tsx`; SHA-256 `2155bf2eea062dff3b029e10262b70e88dfd61a247f48052daa596a6d461c3f6`. Baseline `before.json`: 4,238 sorted files, SHA-256 `0b33dbacca8495640075655c7c2a2c7af5dc33a1b73d9b20b88956ad267e2d6f`; records relative path, hash, size, mode and mtime. Dependency contents are not copied; manifests/lockfiles are hashed, and no dependency operation occurred.

The original fictional L fixture was reused unchanged: `/tmp/aura-performance-audit/L-run2/data/erp.db`, with durable copy `fixture/erp.db`. SHA-256 **`b019cb1282f74ab9349be20263693933ba0ab18879663780a9c76a63f62df915`**, 102,486,016 bytes. Generator/evidence retained alongside it. Counts: 100,033 customers, 10,010 orders, 5,010 expenses, 2,000 FIFO layers, 110 worksheets, 1,001 workers, 12,091 cash transactions and 148,034 audit rows before runtime setup. 85 SQLite tables. RED/GREEN use exclusive runtime copies, never modify this source fixture, and verify its final hash.

Runtime paths and initial/final hashes are in each native JSON. Authentication and fictional role setup occur before the read-only observation boundary; login/logout audit changes after that boundary are identified separately. No production userData is accessed.

## 7. Deterministic RED evidence

Before production changes:

```sh
npx vitest run tests/unit/renderer/perf02-customer-search.test.ts tests/ipc/perf02-customer-search-contracts.test.ts --maxWorkers=2 --minWorkers=2
```

`focused-red-sealed`: exit 1; **9 failed / 14 passed**, 23 tests, 2 files, wall 4.14 s. RED-01 expected no request before settling but observed 13; final query included `first` and `final`; pending/clear/composition/trim-equivalence/unmount/reversion cases exposed redundant or obsolete state. This was executed on the unchanged production component.

The final 25-case matrix was subsequently replayed through an external Vitest alias to the **byte-identical original component**, real unchanged shared hook and API unwrap:

```sh
npx vitest run --config /tmp/aura-perf02/red.config.mjs tests/unit/renderer/perf02-customer-search.test.ts tests/ipc/perf02-customer-search-contracts.test.ts --maxWorkers=2 --minWorkers=2
```

Exit 1; **10 failed / 15 passed**, 2 files, Vitest 2.29 s / wall 2.87 s. The six registered-service/security contracts passed on the original implementation too. Failed assertions include 13 calls before settling, obsolete rows at query handoff, two composition requests, pending clear issuing extra work and redundant trim-equivalent/reverted requests. Missing-module/JSX alias setup failures retained separately are **not** counted as behavioral RED.

Native pre-edit compiled RED (`node /tmp/aura-perf02/electron.mjs before`): exit 1, wall 19.43 s; 20/20 bursts issued 13 real searches and failed the strict one-request assertion. All preceding pagination, read-only and permission controls passed. An initial observer failure on trailing JSX spacing was corrected by reading the name text node rather than trimming business names; that setup run is not the primary RED.

## 8. Design comparison

**Selected: Option A, customer-page-local debounce and result ownership.** Existing shared hook has no debounce configuration, so Option B would require expanding shared behavior and trigger the authorization boundary. It remains byte-identical.

The input and committed query are separate. The page holds no duplicate customer DTO: the child owns rows/pagination; the parent publishes only authoritative summary and existing reload callback. Semantically unchanged input cancels redundant work; composition suppresses intermediate terms. Query keys bind settled raw search/filter identity. Previous rows never become the new query's rows during effect handoff. Toolbar/input/edit/history dialogs remain outside the keyed child, preserving focus and selection. Existing lifecycle reload behavior remains available.

## 9. Interval choice and latency disclosure

Named constant: `CUSTOMER_SEARCH_DEBOUNCE_MS = 150`, below the 300 ms ceiling. Exploration tested 150/200/250/300 ms with five native trials each, same fixture and actual downstream IPC. The test wrapper adjusted only the existing customer 150-ms timer and restored native timers afterwards; it did not replace IPC/services/responses or change production configuration.

| Exploratory interval | Measured wait p50 | Observed input-to-visible p50 | Requests per burst |
|---|---:|---:|---:|
| 150 ms | 152.47 ms | 245.70 ms | 1 |
| 200 ms | 204.62 ms | 311.70 ms | 1 |
| 250 ms | 254.23 ms | 347.80 ms | 1 |
| 300 ms | 303.36 ms | 830.40 ms | 1 |

The last value contains particularly large locator-observation overhead; it is not proof of an 830 ms paint time. Larger delays offered no request-count advantage in this protocol. 150 ms is the lowest authorized candidate that coalesced every measured burst, not a universal optimum.

150 ms is **30.34%** of matched baseline input-to-visible p50 (494.40 ms), exceeding the requested 25% disclosure trigger. Actual wait p50 was 152.30 ms. Single deliberate searches therefore incur intentional waiting; the burst still improved total observed median by 250.20 ms. Slow typing separated by completed responses legitimately issues one request per distinct settled term. No automatic failure threshold or SLO is inferred.

## 10. Exact production diff

```diff
--- before/src/renderer/pages/customers/CustomersPage.tsx
+++ after/src/renderer/pages/customers/CustomersPage.tsx
@@ -1,7 +1,7 @@
-import { useState, type ReactElement } from 'react'
+import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
 import { Archive, ArchiveRestore, Eye, Trash2 } from 'lucide-react'
-import { usePagedQuery } from '@renderer/lib/usePagedQuery'
-import type { CursorPage } from '@shared/pagination/cursor-page'
+import { usePagedQuery, type PagedQuery } from '@renderer/lib/usePagedQuery'
+import { SEARCH_MAX_LENGTH, type CursorPage } from '@shared/pagination/cursor-page'
 import { call, ApiError } from '@renderer/lib/api'
 import { useToast } from '@renderer/lib/toast'
 import { useSession } from '@renderer/state/session.store'
@@ -27,6 +27,24 @@
   approvedInvoices: CursorPage<HistoryDocument>
 }
 
+// Customer-local coalescing; other paged-query consumers remain immediate.
+const CUSTOMER_SEARCH_DEBOUNCE_MS = 150
+
+type CustomerQueryState = PagedQuery<Customer, { totalCount: number }>
+
+/** Keyed by the settled filters: late responses belong to the old instance. */
+function CustomerQuery({ search, state, onQuery, children }: {
+  search: string
+  state: 'active' | 'archived'
+  onQuery: (identity: string, summary: CustomerQueryState['summary'], reload: CustomerQueryState['reload']) => void
+  children: (query: CustomerQueryState) => ReactElement
+}): ReactElement {
+  const list = usePagedQuery<Customer, { totalCount: number }>('customers', 'list', { search, state })
+  const { summary, reload } = list
+  useLayoutEffect(() => onQuery(JSON.stringify({ search, state }), summary, reload), [search, state, summary, reload, onQuery])
+  return children(list)
+}
+
 export function CustomerCountBadge({ count }: { count: number }): ReactElement {
   return <span className="customer-count-badge" dir="ltr" aria-label={`عدد العملاء المطابقين: ${count}`}>{count}</span>
 }
@@ -45,6 +63,23 @@
   const { can } = useSession()
   const toast = useToast()
   const [search, setSearch] = useState('')
+  const [searchInput, setSearchInput] = useState('')
+  const [composing, setComposing] = useState(false)
+  // Main trims only after enforcing the raw length bound. Do not deduplicate
+  // over-limit input into a valid query and conceal its validation error.
+  const inputKey = searchInput.length <= SEARCH_MAX_LENGTH ? searchInput.trim() : searchInput
+  const queryKey = search.length <= SEARCH_MAX_LENGTH ? search.trim() : search
+  const searchPending = composing || inputKey !== queryKey
+  useEffect(() => {
+    if (composing) return
+    if (searchInput.length <= SEARCH_MAX_LENGTH && !searchInput.trim()) {
+      setSearch(searchInput)
+      return
+    }
+    if (!searchPending) return
+    const timer = setTimeout(() => setSearch(searchInput), CUSTOMER_SEARCH_DEBOUNCE_MS)
+    return () => clearTimeout(timer)
+  }, [searchInput, searchPending, composing])
   const [editing, setEditing] = useState<Partial<Customer> | undefined>()
   const [error, setError] = useState<string>()
 
@@ -55,7 +90,17 @@
   const [actionError, setActionError] = useState<string>()
   const [historyFor, setHistoryFor] = useState<Customer>()
 
-  const list = usePagedQuery<Customer, { totalCount: number }>('customers', 'list', { search, state })
+  const queryIdentity = JSON.stringify({ search, state })
+  const [publishedSummary, setPublishedSummary] = useState<{ identity: string; summary: CustomerQueryState['summary'] }>({ identity: '', summary: undefined })
+  const reloadQuery = useRef<CustomerQueryState['reload']>()
+  const publishQuery = useCallback((identity: string, summary: CustomerQueryState['summary'], reload: CustomerQueryState['reload']) => {
+    reloadQuery.current = reload
+    setPublishedSummary({ identity, summary })
+  }, [])
+  const list = {
+    summary: publishedSummary.identity === queryIdentity ? publishedSummary.summary : undefined,
+    reload: async () => { await reloadQuery.current?.() }
+  }
   const historyOrders = useStatementSection<HistoryDocument>(historyFor?.id, 'orders')
   const historyPayments = useStatementSection<PaymentEntry>(historyFor?.id, 'payments', (row) => row.rowKey)
   const historyPreliminary = useStatementSection<HistoryDocument>(historyFor?.id, 'preliminaryInvoices')
@@ -99,7 +144,7 @@
   return (
     <>
       <PageHeader
-        title={<span className="customer-title"><span>العملاء</span><CustomerCountBadge count={list.summary?.totalCount ?? 0} /></span>}
+        title={<span className="customer-title"><span>العملاء</span>{!searchPending && publishedSummary.identity === queryIdentity && <CustomerCountBadge count={list.summary?.totalCount ?? 0} />}</span>}
         subtitle="بيانات العملاء وأرصدتهم المستحقة"
         actions={can(P.customers.manage) && <Button onClick={() => { setEditing({}); setError(undefined) }}>+ عميل جديد</Button>}
       />
@@ -111,13 +156,17 @@
             <option value="archived">العملاء المؤرشفون</option>
           </Select></Field>
           <Field label="بحث">
-            <Input placeholder="الاسم أو رقم الهاتف" value={search} onChange={(e) => setSearch(e.target.value)} />
+            <Input placeholder="الاسم أو رقم الهاتف" value={searchInput} onChange={(e) => setSearchInput(e.target.value)}
+              onCompositionStart={() => setComposing(true)}
+              onCompositionEnd={(e) => { setSearchInput(e.currentTarget.value); setComposing(false) }} />
           </Field>
         </Toolbar>
 
-        <ErrorNote>{list.error}</ErrorNote>
+        <CustomerQuery key={queryIdentity} search={search} state={state} onQuery={publishQuery}>
+        {(list) => <>
+        <ErrorNote>{searchPending ? undefined : list.error}</ErrorNote>
         <DataTable
-          loading={list.loading}
+          loading={searchPending || list.loading}
           rows={list.items}
           rowKey={(row) => row.id}
           empty="لا يوجد عملاء"
@@ -151,7 +200,9 @@
             }
           ]}
         />
-        <Pager pageIndex={list.pageIndex} hasPrev={list.hasPrev} hasNext={list.hasNext} loading={list.loading} onPrev={() => void list.prev()} onNext={() => void list.next()} />
+        <Pager pageIndex={list.pageIndex} hasPrev={list.hasPrev} hasNext={list.hasNext} loading={searchPending || list.loading} onPrev={() => void list.prev()} onNext={() => void list.next()} />
+        </>}
+        </CustomerQuery>
       </Card>
 
       <Modal open={Boolean(action)} title={action?.kind === 'archive' ? 'أرشفة العميل' : action?.kind === 'restore' ? 'استعادة العميل' : 'حذف نهائي'}
```

Only existing production file changed: `CustomersPage.tsx`. New permanent files: 19 component cases in `tests/unit/renderer/perf02-customer-search.test.ts`, six actual registered-handler/SQLite cases in `tests/ipc/perf02-customer-search-contracts.test.ts`, and strict native `tests/electron/perf02-customer-search.mjs`. No existing test changed. External original copies and full unified diff are retained in `evidence/production.diff`.

## 11. GREEN matrix

| Requirement | Executed evidence | Result |
|---|---|---|
| RED-01 rapid input/one settled request | Actual page/hook fake clocks; 20 native trials | PASS |
| RED-02 exact final rows | Component and actual native/service DTO equality | PASS |
| RED-03 reverse responses | Deferred transport component test; existing sequence retained | PASS |
| RED-04 old in-flight response during pending input | Component and native actual in-flight frame capture | PASS |
| RED-05 pending stale presentation | Old rows/count/errors hidden, disabled pager; render-history/native frames | PASS |
| RED-06 clear | Timer cancellation, default first page; whitespace later-page regression | PASS |
| RED-07 page/filter/selection | Component; independent registered SQL oracle; actual native next/previous/history | PASS |
| RED-08 immediate submit | No original Enter/search action | N/A |
| RED-09 Arabic/composition | Component and Electron DOM composition events | PASS at event boundary; native hardware IME NOT TESTED |
| RED-10 normalization/dedup | Trim-equivalence, significant interior spaces, raw over-limit input, wildcards/ASCII SQL | PASS |
| RED-11 unmount/navigation | Timer cancellation; disposed child ownership; native away/back | PASS; admitted backend work may complete |
| RED-12 permissions | Real registered guards and native anonymous/denied/reader principals | PASS |

`focused-final`: **40 tests / 4 files PASS**, including unchanged DB-10 paged-query and customer UI contracts. Broader selected regressions: **378 tests / 18 files PASS**, exit 0, Vitest 55.93 s / wall 56.72 s. Exact commands and names are retained in corresponding result JSON/logs. No skips, retries or weakened original assertions.

The lightweight driver executes the actual component/hook, with controlled transport and dependency-tracked hooks patterned after DB-10. It models discarded child state, not Chromium paint. Native observation caught an issue the first driver missed; the final pre-effect render-history assertion and keyed-instance implementation address it. Failed intermediate logs remain preserved, including `ownership-red`, `after-unkeyed-ownership-red-*` and `clear-boundary-red`.

## 12. Real compiled Electron protocol

macOS 26.5.2 (25F84), Apple M1 MacBookAir10,1, 8 cores, 16 GiB RAM. CLI Node 24.17.0; Electron 43.6.0, Chromium 150.0.7871.250, runtime Node 24.20.0; SQLite 3.53.4 / better-sqlite3 13.0.3; React 18.3.1; Playwright 1.63.0. Available disk at baseline 28 GiB. Unpackaged compiled macOS runtime, **not Windows qualification**.

Actual main/preload/renderer run against the same fictional fixture, isolated userData/sessionData and offline context. Owner login uses real UI; actual search input uses `pressSequentially('NO-MATCH-PERF')`. Clear and settle precede each trial; one warm-up is excluded; 20 valid samples per phase, no silent outlier removal. Wrapper delegates actual registered handlers, logs payload/start/duration/result identity, and observes SQLite statement timings without replacing results. Main/renderer security flags remain context isolation/sandbox/web security true, Node integration false; 260 existing registered channels, no recovery channel. No external HTTP(S) request observed.

Monotonic `performance.now()` clocks anchored to each process's time origin align renderer input with handler admission. A = first actual input event to observed empty/final result plus two animation frames. B = **final main-handler admission** to the same visible observation, excluding inbound renderer→main dispatch. C = summed main-handler durations across the burst, including unchanged validation/session/service work, not pure SQL time. Locator polling and observation overhead are included; p95 is an empirical 20-sample estimate, no p99 claim. Original per-character main work backpressures automated typing (burst median 424.20 ms); final burst median 14.20 ms falls wholly inside the debounce window. Same controller protocol, actual event timestamps retained.

Primary matched raw data: `evidence/before-electron.json`, `evidence/after-electron.json`. Permanent harness seal run: `PERF02_FIXTURE=/Users/macbook/aura-evidence/perf02/fixture/erp.db PERF02_EVIDENCE_DIR=/tmp/aura-perf02/sealed node tests/electron/perf02-customer-search.mjs after`: exit 0, wall 16.84 s, 20/20 one-request bursts. Independent repeat A p50/p95 243.70/329.90 ms; B 75.51/164.11 ms; C 41.24/52.58 ms. All raw samples are retained in `evidence/sealed/after-electron.json`; the primary matched comparison was not replaced by this replication. Every post-change sampled race frame has zero stale rows; strict observed-overlap admission passed.. Its source-fixture hash guard permits only the preserved fictional dataset; external evidence path and unique runtime directories prevent production-data use or overwriting existing runtimes.

## 13. Matched comparison

| Metric | Before | After |
|---|---|---|
| 13-character burst search IPC count | 13 in each of 20 trials | 1 in each of 20 trials |
| Accumulated main-handler work p50 / p95 | 426.04 / 447.87 ms | 42.35 / 52.93 ms |
| Input-to-visible-result p50 / p95 | 494.40 / 512.40 ms | 244.20 / 332.20 ms |
| Request-to-visible-result p50 / p95 | 69.20 / 72.06 ms | 76.33 / 167.23 ms |
| Net total visible latency | Reference | p50 −250.20 ms; p95 −180.20 ms |
| Deliberate/request admission wait p50 / p95 | 0.18 / 0.28 ms | 152.30 / 153.11 ms |
| Final correctness | Exact final no-match and substring DTO | Exact same semantics/DTO |
| Stale response safety | Issued-request guard; pending/handoff RED failures | Pending suppression plus keyed current owner, native race PASS |
| Clear | Immediate original default-list behavior | Immediate, including later default page after whitespace |
| Pagination | Name/id keyset; 50 rows | Same keyset/order/limits; settled query reset and same selected IDs |
| Enter / IME | No Enter action; intermediate composition requests | Enter N/A; composition event coalescing; hardware IME NOT TESTED |
| Renderer working set after primary trials | 205.88 MiB | 207.61 MiB (+0.84%) |
| Main-thread long tasks in primary trials | 0 observed | 0 observed |
| Business-table mutation during search | None across all 85 table hashes | None across all 85 table hashes |

A improves in this matched workload while B increases; no claim of faster SQL or downstream service is made. The unchanged standalone service was also sampled 20 times against both runtime copies: p50 72.73/64.50 ms, p95 93.91/77.90 ms. Those health-run samples overlapped regression work and cache state; they are supporting service observations, **not causal before/after performance proof**. Native SQL shapes/timings are separately retained. No SQL/index optimization was attempted.

## 14. Final-result ownership and race proof

Primary final native race issued actual search `0`, changed input to `NO-MATCH-PERF` while its handler was still in flight, then admitted the final request. Old handler duration 20.4413 ms, new input at +20.1238 ms, overlap 0.3176 ms; 23 sampled frames retained. No stale rows appeared after the new input's transition; final request returned zero rows. This is real handler/SQLite work, not a deferred fake response. Earlier keyed run also observed an actual overlap; failed unkeyed frame evidence remains for comparison. The final strict harness repeats the race with 9.90 ms independently recorded overlap and rejects any post-input sampled frame containing old rows. It requires observing a real overlap, not merely assuming one.

Pending input never mutates the old query's filter. Its rows can finish internally but remain hidden. Once the final query commits, a new key creates clean hook state; old-instance setters cannot become current state. Sequence protection still handles competing reload/page responses within the same instance. It is acceptable for already admitted read-only work to finish; no cancellation IPC is introduced.

## 15. Clearing, pagination, Enter, IME and unmount

Native substring `0009` returns 111 matches. First/next/previous page IDs and displayed names match real registered DTOs exactly; server summary is not inferred from the displayed 50 rows. History opens for the actual selected customer. Default clear and whitespace-only page reset retain first-page order. Filtered/archived and invalid cursor contracts are covered by actual registered tests, including 105-row complete cursor traversal and no duplicates.

Slow typing `N`, `NO`, `NO-` retains focus and settles each valid query. Pending navigation cancels its timer and returning reinitializes the default customer page. Composition events preserve Arabic `عميل` with no intermediate searches in GREEN; this was synthetic DOM composition inside actual Electron, not a real OS input-method session. There is no original Enter handler/button to preserve or invent.

## 16. Permissions and confidentiality

Actual router registration tests execute real schema/session/permission/restore-admission owners; only Electron host registration is captured in the integration environment. Native evidence separately uses genuine Electron registration/preload. Anonymous/stale sessions return UNAUTHENTICATED, denied role returns FORBIDDEN, authorized customer-view employee receives the same permitted DTO as owner. Restore exclusivity denies search with CONFLICT; wrong-filter cursors and oversized raw text return VALIDATION_ERROR. Snapshots prove denial does not mutate database state or expose rows.

No new channel, generic invoker, renderer filesystem authority or financial writer exists. Guards and session binding remain unchanged. Successful enrollment/recovery privileges are neither added nor tested here. Offline/native security flags and byte-identical main/preload owners preserve the existing boundary; this is not a new whole-application security audit.

## 17. SQLite and financial integrity

Fresh migrated database and RED/GREEN populated copies: **53 migrations, integrity `ok`, zero foreign-key violations, 73 reconciliation checks, zero errors/warnings/findings**. Native read-only boundary hashes all 85 tables, including customer/order/payment/cash/FIFO/worker/audit tables, before and after search/view/history activity; every hash matches. Registered tests also compare whole logical snapshots around valid and denied search batches and reconciliation.

Independent source fixture oracles remain cash **509,390,000 minor units** on account 2 and stock **19,890,000,000 micro units** for material 1. Worker 1000 retains payable **0 minor** and debt **0 minor**, independently expected from the fictional workflow and checked through the unchanged worker projection. All balances and financial row values remain untouched. Authentication/setup operations have their normal audit/session effects outside the read-only boundary; no search audit or repair write is invented. Source fixture SHA is unchanged.

## 18. Regression, typecheck, lint and build

Baseline command, before production edits: `npx vitest run --maxWorkers=2 --minWorkers=2` — **3,626 PASS / 281 files**, no failures/skips; exit 0, Vitest 786.03 s / wall 786.84 s.

| Command | Exit | Wall duration | Result |
|---|---:|---:|---|
| `npx vitest run --maxWorkers=2 --minWorkers=2` | 0 | 800.11 s | 3,651 passed / 283 files; no failures/skips/unhandled Vitest errors |
| `npm run typecheck` | 0 | 20.51 s | PASS |
| `npm run lint` | 0 | 18.47 s | PASS; 26 test typing warnings, 0 errors |
| `npm run build` | 0 | 7.72 s | PASS; no emitted warnings |

The focused 18-file command is recorded verbatim in `focused-regressions-result.json`: new two suites, DB-10 hook/customer UI/filter-count/pagination, DB-08 lifecycle, DB-09 streaming, UI-WF-04, SEC-01/02/03/04, E2E-01/02/03 and PERF-01 report/output contracts. Full suite retains the broader financial, audit atomicity and business regressions.

Final Vitest-reported duration: **799.36 s**; wrapper wall duration is recorded separately. Test-count change is exactly **+25 tests / +2 Vitest files**: 19 customer component cases (including two parameterized raw-length cases) and six registered contracts. Native `.mjs` is a separate executable, not counted as a Vitest file. No existing test was removed, weakened or newly skipped.

DB-08's unchanged 2,000 ms guarded threshold passed baseline at **706.70 ms**; final observed 706.5371660000001 ms. Its SHA remains `3cae17a65e2bdcaa96019126452f8614ebba29ac6cbb286dabb3d2b92b9c4a98`; this run does not permanently resolve historical timing variability. Lint exits 0 with **26 `no-explicit-any` warnings**, all in the two new test drivers/contracts; no suppression/config change. Build exits 0 with no emitted warning. Expected test fault-injection stderr is retained; it is distinct from an unhandled Vitest error.

## 19. Final preservation comparison

Baseline 4238 files; final manifest includes the final report. Existing production changes: exactly one. Existing tests changed: zero. New permanent files: exactly three, plus this final report. Current customer page SHA-256 `ba2a29d6719389db555a71c1edcf2cf8e103b160ab915ebb931e313d6f877a5d`; original SHA above. Complete source/schema/configuration/asset/report comparison passed; unauthorized source changes: **NO**. Final sorted SHA manifest and path-level comparison are in the durable evidence directory; report SHA is sealed externally to avoid recursive self-hashing.

Protected examples (before = after): shared hook `8a6f52ac4b18eec0b10907bb8a2dc8e55c2fa8eb03cb8e1433aadb2089c33913`; parties service `47ad6f4ee3d14af2d00a5d0bf42a1b0d4f3f88d7585db80d717e0bba415501d3`; router `5e2cbd86926b521a04e57c7ca6185e5c9c837b4576d73092d3b5a98ae61e3223`; backup service `b5e76c62d40e309f2b42d2475c535d0cfd4f18c06fb983d09aaec86fe19b8567`; BDR-01 trust `4aa46593a62f694544c5cbbc2dc48897bc73d9a3fce1636694c46ca32605bb3e`. Original reports remain byte-identical.

Generated artifacts are disclosed separately: Graphify graph/labels/manifests/cache/reports; renderer bundle/hash/index replacement; existing test-generated `.tmp/pdf-cases/*.html` and `tmp/pdfs/*.html`. These are test/build products, not source corrections. Compiled main/preload remain byte-identical. No migration/configuration/asset/package/lockfile changed. Durable `after.json` and `preservation.json` list every changed/new/removed path and hashes; original metadata remains available in baseline/copy.

## 20. Remaining limitations

The query still performs existing `%substring%` searches and full matching counts on large data. Slow typing outside the debounce window legitimately invokes more searches. Already-admitted calls cannot be cancelled; this change removes redundant admissions, not all backend work. It does not solve PERF-03 or arbitrary large-dataset scalability.

Native controller timing includes observation/polling overhead; trials were ordered RED then GREEN with no OS cache flush or randomized crossover. Device/environment variation affects tail latency. The actual new-input in-flight overlap was small but independently recorded; deterministic deferred cases exercise wider race windows. Hardware IME and native input-method candidate selection remain unverified; event-boundary behavior is tested and disclosed. 26 test typing warnings remain. No claim of a universal optimal interval or complete performance qualification.

## 21. Windows-native coverage

**NOT TESTED.** This is compiled unpackaged macOS Electron only. No NSIS installer, Windows native search/IME, Windows performance, recovery or release qualification was performed.

## 22. STOP conditions and mandatory gate matrix

**STOP conditions triggered: NONE.** Failed intermediate customer-local implementations were corrected inside the authorized boundary. No shared hook, SQL, IPC, security or external contract expansion was required. No auto-review rejection occurred. 

| Gate | Result | Evidence under durable `evidence/` |
|---|---|---|
| Redundant requests reproduced in RED | PASS | original-final-tests-red.log; before-electron.json |
| Request coalescing proven in GREEN | PASS | focused-final.log; focused-regressions.log |
| Real Electron IPC reduction | PASS | before/after-electron.json; sealed/after-electron.json |
| Final results and pagination | PASS | registered contracts; native checks.substring/pagination/clear/selection |
| Stale-response safety | PASS | pre-effect renderer test; native inFlight.frames and strict overlap assertion |
| Enter / IME correctness | PARTIAL | Enter N/A; component/native DOM composition PASS, hardware IME NOT TESTED |
| Permissions preserved | PASS | registered contracts; native anonymous/unauthorized/employee |
| SQLite / 73 reconciliations | PASS | health.json, fresh and populated, 0 findings |
| Full Vitest / Typecheck / Lint / Build | PASS | final-*-result.json and logs; lint warnings disclosed |
| Graphify | PASS | graph-final-update/diagnose logs |
| Unauthorized changes | NO | after.json; preservation.json; production.diff |
| STOP condition triggered | NO | single customer-file boundary retained |

## 23. Final verdict and owner review

```text
PERF-02:
VERIFIED CLOSED — RECOMMENDED FOR OWNER REVIEW

DETERMINISTIC RED / GREEN:
PASS / PASS

REAL COMPILED ELECTRON IPC:
PASS

FINAL RESULTS / PAGINATION / STALE-RESPONSE SAFETY:
PASS

ENTER:
NOT APPLICABLE

IME:
EVENT-BOUNDARY PASS / NATIVE HARDWARE NOT TESTED

PERMISSIONS / SQLITE / 73 RECONCILIATIONS:
PASS

FULL VITEST / TYPECHECK / LINT / BUILD:
PASS

PONYTAIL FULL:
COMPLETE

GRAPHIFY:
PASS

UNAUTHORIZED SOURCE CHANGES:
NO

STOP CONDITIONS TRIGGERED:
NONE

PERF-01:
SCOPED M-SCALE VIEWER/OUTPUT CLOSURE RECOMMENDATION UNCHANGED — OWNER REVIEW CONTROLS OFFICIAL CLOSURE

PERF-03:
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

Owner decision: review the single-file production diff, native raw samples/race frames, 25 new tests and debounce tradeoff. Preserve `/Users/macbook/aura-evidence/perf02/` until review; `/tmp/aura-perf02/` is auxiliary and ephemeral. Copy durable evidence to an owner-controlled archival location before future housekeeping. No evidence/baseline cleanup performed. Work stops after this report and its external SHA seal. No PERF-03, recovery, unrelated remediation or subsequent audit begins.
