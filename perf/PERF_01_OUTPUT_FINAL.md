# PERF-01 output delivery — final evidence

## 1. Executive verdict

**The confirmed 10,034-row print/PDF failure is resolved. Recommend PERF-01 VERIFIED CLOSED for the documented M-scale finding, subject to owner review.** The existing 50-row viewer is intact. Actual compiled macOS Electron generated a **372-page PDF containing every one of the 10,034 authoritative rows, all six fields in exact order and the complete debt total**. The print request reached a controlled printer leaf after genuine loading; no physical print job was issued.

Current full gate: **3,626 tests / 281 files PASS**, zero failed/skipped tests or files, no Vitest unhandled errors. Typecheck, lint, build, fresh/populated SQLite health, all **73 reconciliations** and Graphify PASS. No STOP condition was triggered. This is not unlimited-size output qualification: the existing data-URL mechanism still has a finite URL ceiling; see section 18.

## 2. Exact authorization scope

Production modification: **`src/main/services/documents/print.service.ts` only**. It changes UTF-8 transport encoding within the existing `data:text/html` loader, closes rejected loading windows and stages PDF bytes before publishing the existing filename. No temporary HTML, new protocol, generic IPC, security exception, dependency, schema, report SQL, financial writer, authentication, permission or viewer change was introduced.

The existing strict Electron harness was strengthened for load/leaf/cleanup evidence and 20 samples; seven permanent focused cases were added. PERF-02/03 OPEN, BDR-01 OPEN and BDR-02 VERIFIED CLOSED remain unchanged. Prior reports were not rewritten.

## 3. Root cause and failing boundary

Actual pre-edit compiled Electron prepared complete **1,202,341-byte** report HTML. `encodeURIComponent` expanded it into a **2,290,896-character** data URL. Native `BrowserWindow.loadURL` rejected that URL with **`ERR_INVALID_URL (-300)`**, before printing or PDF generation. Neither financial aggregation nor the 50-row view truncated output.

The runtime load-only bisection admitted 2,093,910 characters and rejected 2,111,843; the bracket spans 2,097,152. Chromium's published source defines the cross-process URL ceiling as `2 * 1024 * 1024`. [Chromium URL constants](https://chromium.googlesource.com/chromium/src/+/HEAD/url/url_constants.h). This source corroborates the measured boundary; the installed engine was **Chrome 150.0.7871.250 / Electron 43.6.0**, not a locally rebuilt Chromium HEAD.

The **same full HTML SHA-256** (`1d0f6ac51e963659de54cba23c52fa7e514e8bb3f29b33b6a0e4962310ed9ad5`) loads using UTF-8 base64 in a **1,603,160-character** URL. Actual registered print and PDF then succeed. Encoding round-trip tests preserve every character. Native controls separate HTML generation, loading, printer admission, PDF generation and file persistence; the error is not inferred merely from its name. Same HTML/styles/assets and security preferences work when transport length falls below the boundary. Font CORS is a separate historical limitation.

## 4. Ponytail FULL ownership and Q1–Q12

Print: `ReportsPage.tsx:67 output('printReport')` → fixed `build-api.ts:24` channel closure → `router.ts:3112 documents:printReport` schema → `guard.ts:38 createHandler` trusted WebContents session / `reports.export` → `reports.service.ts:75 buildAuthorizedReport` report-specific authority → full authoritative financial/SQLite report → `print.service.ts:85 renderReportHtml` → `documents.template.ts:498 renderReport` → `loadHtml:89` → isolated `createPrintWindow:11` → `loadURL` → `printHtml:104` → final native print callback → destroy.

PDF: same UI and fixed bridge → `router.ts:3134 documents:exportReportPdf` schema/guard → complete authorized report → same template/loader → `exportPdf:153 printToPDF` → existing year/kind/sanitized filename → exclusive UUID scratch PDF in the same output directory → completed write → rename to original destination → remove scratch in finally → destroy window → return existing path result.

Report ordering/totals originate in `reports.service.ts` / `parties.service.ts:212`, not in the output transport. Template columns, all DTO rows and global totals remain complete. `ReportsPage.tsx:14 ReportRows` remains byte-identical; the page slice never enters output IPC. `src/main/printing/print-window.manager.ts` also has a legacy encoded loader consumed by `src/main/reports/renderer/{print,pdf}.service.ts`; no active registered application route imports those legacy services. They remain unchanged, rather than broadening this correction.

| Question | Evidence (file:line, log or measurement) | Result |
|---|---|---|
| Q1 Exact ownership of loadHtml? | `src/main/services/documents/print.service.ts:89`; graph-owner-call-edges.json | Private owner shared by active printHtml/exportPdf. |
| Q2 Encoded data URL? | Original external backup line 90; current line 93; native load logs | Before percent encoding; now UTF-8 base64, same data scheme/MIME/charset and opaque origin semantics. |
| Q3 Size effect? | after-electron.json loadEvidence; final-green/after-electron.json outputEvidence | 1,202,341 HTML bytes → 2,290,896 percent URL versus 1,603,160 base64 URL. |
| Q4 Failure mechanism? | Native bisection + same-content encoding control + Chromium source in section 3 | Cross-process URL-size admission demonstrated; not malformed report content, report SQL, CSP or font CORS. |
| Q5 Shared loader? | `print.service.ts:105,158` and graph call edges | Yes; both await loadHtml. |
| Q6 Complete HTML first? | Strict native harness compares every ordered cell of both output HTMLs; complete DTO hash | Yes, all 10,034 rows / six columns / totals before load failure. |
| Q7 Cleanup on success? | Final native outputEvidence.windows contains only visible main window; directory inspection; lines 113,174,181 | PASS: print/PDF windows destroyed and scratch removed; two intended PDFs retained. |
| Q8 Cleanup on failure? | Original native RED retained two blank hidden windows; new focused rejected-load, native-generation and publication-failure cases | Fixed owner catch/finally: injected failures close windows and remove scratch. Native boundary controls separately destroy their own rejected windows. Post-fix disk-full/process-kill failures are not native-tested. |
| Q9 Publication after completion? | `print.service.ts:160–180`; real PDF signature/extraction; exact destination and write/rename-fault tests | Complete native buffer and successful scratch write precede final rename; prior PDF preserved on injected failures. No partial final PDF reported successful. |
| Q10 Permissions before generation? | `router.ts:3112–3153`, `guard.ts:56–66`, `reports.service.ts:75`; actual anonymous/restricted output calls | PASS: UNAUTHENTICATED/FORBIDDEN before output construction; existing report-specific confidentiality preserved. |
| Q11 Untrusted text escaped? | `documents.template.ts:14 esc`, :195 shell/:208 header/:498 renderReport; unchanged template hash and security suites | Yes: titles, company strings, columns, cells and totals remain escaped. No renderer-supplied HTML IPC added. |
| Q12 Offline/isolation preserved? | unchanged print-window.ts/main-window.ts/protocol.ts/index.html hashes; actual preferences; local source URLs and offline harness | PASS for existing controls: contextIsolation/sandbox/webSecurity true; nodeIntegration false; no output preload/new IPC/network loader. Main CSP and SEC-03 allowlist unchanged. Print shell had no separate CSP meta before this fix; none was relaxed. |

## 5. Graphify baseline and final

Executed/awaited `graphify update .` and `graphify diagnose multigraph`, baseline and final: exit 0. Baseline update/diagnosis **17.957 / 1.254 s**; final **15.747 / 1.259 s**. The final update reported no further code-topology changes. Earlier post-change rebuild established the delta below.

| Metric | Baseline | Final |
|---|---:|---:|
| Nodes | 7,192 | 7,196 |
| Raw/valid edges | 13,806 | 13,810 |
| Communities | 413 | 403 |
| Unverified / missing / dangling endpoints | 0 / 0 / 0 | 0 / 0 / 0 |
| Exact duplicates / directed or undirected collapses | 0 / 0 / 0 | 0 / 0 / 0 |
| Self-loops | 32 | 32 |
| Producer-suppression sites | 12 | 12 |

Four added nodes: new test file, its fault fixture, windowFixture and a built-in `node:fs/promises` extraction node. Four added edges, no removed nodes/edges. No new renderer→filesystem/database authority or IPC capability. Community re-clustering is structural, not correctness proof. Existing loops/suppression sites are disclosed and unchanged.

Evidence: graph-baseline/final JSON, graph-delta.json, graph-output-query.txt, graph-print-window-query.txt and graph-owner-call-edges.json under the external evidence directory. The broad output query returned all 46 nodes/121 edges over its suggested budget; a window query truncated 4 of 45 nodes. Exact source-owner call-edge inspection and complete direct reads resolved the missing relationships. Eight unsupported assets/config formats were skipped by AST extraction. An attempted CLI help query was interpreted as query text, not CLI documentation; no inference relies on it.

## 6. SHA-256 preservation baseline and fixtures

No Git repository: current `git rev-parse --is-inside-work-tree` exited 128. Sorted **4,194-file** baseline `/tmp/aura-perf01-output/before.json`, SHA-256 **45cd022195393946083abe107e5594f9c3af671c53d9d994bc514ea0a6c5e3e1**. It covers source, tests, schema/migrations, configuration/scripts, package manifests/lockfiles, assets, prior reports, compiled output and Graphify. It does not claim a byte manifest of the entire node_modules tree; no package installation/upgrade occurred.

MacBookAir10,1 / Apple M1 / 16 GiB (same prior benchmark hardware); current macOS **26.5.2 (25F84)**, arm64, CLI Node **24.17.0**, Electron Node **24.20.0**, Electron **43.6.0**, SQLite **3.53.4**. Unpackaged compiled macOS; 28 GiB available disk observed. No Windows or installer qualification.

Immutable service-generated fictional M fixture: `/tmp/aura-performance-audit/M-run2/data/erp.db`, SHA-256 **682e541efb6cb327d562d42c1761c17e38a8f8a296a83aecfabff8b5e9c5584d** unchanged. Original generator remains `/tmp/aura-performance-audit/services.ts`, untouched. It supplies 10,033 customers, 1,010 orders, 510 expenses, 200 FIFO layers, 60 worksheets, 1,266 cash transactions and 15,309 audit rows. Each harness copies it into separate userData/sessionData and creates the same fictional `PERF UI created` customer through authorized IPC, before the measured read-only boundary.

RED/GREEN report content is logically identical: full DTO **1,837,371 UTF-8 bytes**, SHA **d8a70c9713da75710142e49a050e32ef7ca1bb135e2ea407a79e92e09d48b7f9**. Runtime database byte hashes can differ due to SQLite pages and legitimate setup/auth audits. Across initial RED/GREEN, only audit_log and the new customer's created_at differ; all pre-existing business rows and the new customer's other fields match. This timestamp is documented setup, not an output mutation or historical financial-date change. Every runtime's whole logical before/after output hash matches itself exactly.

External original copies, preserving relative paths and hashes: **`/tmp/aura-perf01-output-backup/`**. No backup directory was created inside the project. Historical 3,619/280 is the prior verified full-suite baseline, not a newly rerun pre-edit full gate; pre-edit focused/native RED was executed instead.

## 7. Deterministic RED

Before production correction:

```sh
PERF01_FIXTURE=/tmp/aura-performance-audit/M-run2/data/erp.db \
PERF01_EVIDENCE_DIR=/tmp/aura-perf01-output \
node /tmp/aura-perf01-output/red-electron.mjs after
npx vitest run tests/unit/main/perf01-large-output.test.ts --maxWorkers=2 --minWorkers=2
```

Actual compiled native RED: exit **1**, wall **24.723 s**. Real owner login, renderer, preload, registered guards, SQL/report/template and original loadURL were used. Both full report requests returned INTERNAL_ERROR; load logs identify ERR_INVALID_URL before the printer leaf, with **zero leaf admissions**. Full print handler 93.84 ms; PDF handler 82.88 ms. Both complete HTMLs matched all DTO cells. No large PDF was created or returned successful. Small monthly-profit real PDF succeeded in 524.34 ms and PDFKit read one page.

Permanent focused RED: **3 failed / 2 passed**, one failed file, exit **1**, wall **2.547 s**, Vitest **1.76 s**. Exact failed tests: `loads a complete 10,034-row UTF-8 report without percent-encoding expansion`; `destroys a rejected loading window before the print leaf`; same `pdf leaf`. Original URL failed the base64 transport assertion; both rejected-load destroy spies observed **0 calls**. Native RED, not those mocked delivery leaves, proves the actual loading defect. Two additional write/rename safety cases were subsequently added for the narrow publication change, not misrepresented as pre-edit native RED.

Raw red-electron.log, focused-red.log, result JSON, after-electron.json, child log and screenshots remain external. Native load failure left two blank hidden windows in the old implementation; no confidential document loaded into them. The scoped cleanup correction addresses that directly.

## 8. Controlled size ladder

The formal ladder uses the existing production template and unchanged full DTO. 100/1,000/5,000-row controls are explicitly labeled fictional ordered prefixes with totals omitted, rather than falsely claiming a full-report grand total describes a prefix. The 10,034-row case is the exact full authorized report HTML. These are native transport controls, not extra registered financial reports. Full M RED/GREEN separately exercise actual registered application output.

| Main-table rows | Encoding | HTML UTF-8 bytes | URL characters | Load ms/result | Native PDF ms/result | Output/cleanup |
|---|---|---:|---:|---|---|---|
| 100 | percent | 19,333 | 34,792 | 290.13 | 173.45 | PASS; closed |
| 100 | base64 | 19,333 | 25,816 | 217.23 | 195.6 | PASS; closed |
| 1000 | percent | 127,253 | 239,912 | 335.14 | 489.17 | PASS; closed |
| 1000 | base64 | 127,253 | 169,708 | 342.94 | 476.46 | PASS; closed |
| 5000 | percent | 603,253 | 1,147,912 | 1462.42 | 2002.37 | PASS; closed |
| 5000 | base64 | 603,253 | 804,376 | 1347.35 | 2045.61 | PASS; closed |
| 10034 | percent | 1,202,341 | 2,290,896 | ERR_INVALID_URL (-300) | NOT REACHED | Rejected; closed |
| 10034 | base64 | 1,202,341 | 1,603,160 | 3208.03 | 5086.18 | PASS; closed |

Small actual monthly-profit control: 8,400 bytes; original URL 14,641 characters, new URL 11,236; native PDF success in RED and GREEN. Final small request **474.06 ms**; valid PDF header and EOF verified.

Six additional load-only bisection trials on valid ordered prefix content:

| Prefix rows | HTML bytes | URL characters | Native load |
|---|---:|---:|---|
| 7517 | 902,795 | 1,719,360 | Loaded |
| 8775 | 1,052,497 | 2,004,926 | Loaded |
| 9404 | 1,127,348 | 2,147,709 | ERR_INVALID_URL (-300) |
| 9089 | 1,089,863 | 2,076,204 | Loaded |
| 9246 | 1,108,546 | 2,111,843 | ERR_INVALID_URL (-300) |
| 9167 | 1,099,145 | 2,093,910 | Loaded |

The initial load-only observer counted all tbody rows, including one global totals row. The formal ladder and strict HTML/PDF checks select the primary report tbody, giving exactly 10,034 data rows. This is observer scope, not a report-row discrepancy.

All attempts have a **120-second hard harness timeout**, distinct TIMEOUT labeling and owned window cleanup; none timed out. Formal controls also recorded timestamp/identity at the final substituted print leaf, native printToPDF, PDF write duration, output signature/hash and resource peaks. All successful files persist, all test windows close. Peak observed Electron process working set across the native ladder was **2,012.08 MiB**; output rendering still builds a complete document and is not claimed to be memory-bounded like the viewer. This supplementary ladder overlapped regression activity; its timings are diagnostic samples, not matched UI percentiles or an SLO. Earlier native RED/final GREEN and viewer controls ran without those gates competing.

## 9. Exact production changes and review diff

1. `loadHtml`: base64 encodes the same complete UTF-8 HTML in the existing data URL; catches rejected loads, destroys the window and rethrows the original error. Existing 150-ms layout wait is unchanged.
2. `exportPdf`: native PDF generation remains unchanged; writes the complete returned buffer to an exclusive UUID `.tmp` sibling, renames to the original final PDF, removes scratch in finally. Existing filename sanitization, year/kind location and same-name replacement are preserved and tested. This is PDF publication staging, **not temporary HTML loading**.
3. Imports only existing Node fs/promises and crypto functionality. No new framework, protocol, runtime service or dependency.

Complete line-by-line review files: `/tmp/aura-perf01-output/print.service.ts.diff` and `perf01-report-pagination.mjs.diff`, generated against the external original copies. Permanent test source is the added `tests/unit/main/perf01-large-output.test.ts`.

## 10. GREEN and permanent coverage

Focused final: **18 tests / 4 files PASS**, exit 0; includes the seven new cases, unchanged approved-invoice fallback/output tests, PERF-01 actual page/table rendering and registered-handler report contracts. Security/financial/document focused gate: **342 tests / 9 files PASS**. Combined selected coverage: **360 tests / 13 files**; no skips or weakened assertions.

| Requirement | RED | GREEN |
|---|---|---|
| Full M native load | ERR_INVALID_URL | Complete base64 document loaded |
| Full M printer leaf | Not reached | Reached after actual load; no physical job |
| Full M real PDF | No PDF | 372 pages; independent full coverage |
| Rejected loading window | 0 destroy calls; two native blank windows retained | Owner tests close rejected windows |
| Native generation failure | No successful output | Error preserved/window closed |
| Write/publication failure | Historical direct write vulnerable to partial publication | Existing final file unchanged/scratch removed in both injected cases |
| Existing filename/collision | Established same-name replacement | Exact original destination/updated bytes preserved |
| Viewer | 50 mounted, 201 pages | Same bound/order/all pages |

All seven permanent cases exercise the real service with substituted Electron leaves and real filesystem publication. Faults occur after scratch writing / before rename; these are controlled unit/integration faults, not a native disk-full test. Assertions remain exact.

## 11. Real compiled Electron proof

Final command: `PERF01_FIXTURE=... PERF01_EVIDENCE_DIR=/tmp/aura-perf01-output/final-green node tests/electron/perf01-report-pagination.mjs after`; exit **0**, wall **30.060 s**. Evidence class **REAL_UI_ELECTRON / REAL_IPC_ELECTRON**: actual compiled main/preload/renderer, session/guards, authorized full report, real output loading and native printToPDF, isolated fictional runtime.

Final full print **2437.35 ms**, full PDF **6431.12 ms** (handler end-to-end, not SQL-only). Large PDF: `/tmp/aura-perf01-output/final-green/after-runtime-43168/documents/2026/reports/customer_balances-1791541595098.pdf`. Source/runtime fixture hashes, payloads, full DTO, HTML hashes, successes, permission denials and logical read-only hash are in final-green/after-electron.json.

The final native print call alone is substituted. The external entry observes BrowserWindow.loadURL and delegates it unchanged. **Only after its genuine Promise fulfills** does it install the `webContents.print` callback interceptor; it logs time, window ID, loaded status and HTML SHA. Final print load began at 1791541592016; interception installed at **1791541594232**; leaf reached at **1791541594384**, window 2, loaded=true, complete HTML SHA above. No physical printer was invoked. No HTML loading or report/guard/service step was mocked. The RED wrapper had installed its final-method observer on window creation, but did not alter loading and recorded no admission; the final permanent harness explicitly installs only after success.

Native printToPDF is never substituted in the compiled proof. Final runtime recorded **315 explicit UI actions / 88 actual registered IPC calls**, including setup/auth/reads/output and denial controls, not 88 output jobs. Final native output jobs: two full report actions and one small PDF. All 201 viewer pages are exact; three successful load records; zero TIMEOUT; only the visible main window remains. Screenshots: red after-report/after-failure.png, green/after-report.png and final-green/after-report.png. Native picker/physical-printer/Windows evidence is not claimed.

## 12. Independent PDF completeness

`pdftotext` and Python PDF packages were unavailable. Already-installed **Swift + macOS PDFKit** supplied an equivalent independent parser. Compiler caches were directed to writable /tmp after the default cache was denied; no installation or privilege/security change.

`pdf-extract.swift` extracts every PDF page's text. `pdf-layout.swift` reads each line's PDF selection bounds. `verify-final-pdf.py` independently reconstructs data rows by page order, descending row position and fixed six column positions, excluding repeated headings; it does not select rows by expected names. Empty phone cells remain empty. Coordinate tolerances group glyph lines only; monetary strings/rows/order use **exact equality, no financial tolerance**.

Results: **372 pages / 10,034 rows / six columns**, no missing/extra rows or altered fields; legitimate repeated customer names have the exact expected multiplicity. First 10, last 10 and 100 deterministic interior samples are retained, but verification compares **all** rows, not sampling. Report title and every total match; debt **42.750,00 د.ل**. First page has fewer rows due to the header; later pages accommodate approximately 27; the resulting 372 pages are consistent with the full content. Original output HTML was also compared in full before loading.

Final PDF: **1,751,726 bytes**, `%PDF` header and `%%EOF` trailer; SHA **466adf31661db2e431545b86fb4ef36186905de7c747efd15e9d35b78ed8f7e1**. Independently reconstructed row SHA and authoritative row SHA both **b19da6c92b9d334b0a8ccc6d507a5f3eddf478ba9e53f8bfc6a33318e28872a8**. This was verified for both initial GREEN and final strict GREEN PDFs, whose byte hashes differ due to creation metadata. Full PDF completeness is **PASS**, not inferred from file signature/page count/IPC success.

Artifacts: final-large-pdf-text.json, final-large-pdf-layout.json, final-pdf-all-rows.json, final-pdf-completeness.json; prior independent results also retained. PDFKit-rendered first/last page PNGs (`pdf-page-1.png`, `pdf-page-372.png`) were captured, and the last page visually inspected. These are PDFKit artifact renderings, not physical-printer proof.

## 13. Security, cleanup and partial-file safety

Actual anonymous print/PDF calls return UNAUTHENTICATED; restricted fictional employee calls return FORBIDDEN. Existing security/financial suites pass. Fixed API/schema/session/report-export/report-specific authority are unchanged. No renderer filesystem or HTML-delivery capability is introduced.

UTF-8 base64 keeps the same data-origin mechanism, document MIME, templates and approved local static assets. No protocol route/CSP expansion, file navigation, network server or renderer-security relaxation. The actual window preferences remain isolated, sandboxed and web-secure. SEC-01–04 owners/tests, main renderer CSP and SEC-03's exact asset allowlist remain byte-identical.

Success: native windows close and only the two intended final PDFs remain. Failure: real-owner unit faults verify load/native/write/rename cleanup and preserved prior PDF bytes. No incomplete customer PDF was falsely published in RED. UUID exclusive scratch creation and same-directory rename preserve final collision behavior on tested macOS. No temp HTML or startup cleanup sweep. Abrupt process termination/power loss during scratch writes is not qualified; cleanup finally cannot run after a process kill and a scratch PDF may remain. No new fsync/durability guarantee is claimed.

## 14. PERF-01 viewer performance preservation

Same immutable M fixture, identical DTO hash, one warm-up, two-animation-frame visible completion, nearest-rank percentiles and **20 valid samples** per run. No outliers removed or forced GC. Raw samples remain in each JSON. Automation latency includes actionability/IPC/UI/observer work, not just React CPU.

| Metric | Prior PERF-01 | Final matched run | Evidence |
|---|---:|---:|---|
| Visible p50 | 83.40 ms (n=5) | 83.41 ms (n=20) | REAL_UI_ELECTRON |
| Visible p95 | 83.57 ms (n=5) | 85.38 ms (n=20) | REAL_UI_ELECTRON |
| Mounted rows | 50 | 50 maximum / last 34 | All 201 pages exact |
| Live DOM elements | 592 | 592 | Actual document count |
| Renderer after three switches | 284.56 MiB | 284.89 MiB | Electron Tab workingSetSize |
| Full M report IPC p50/p95 | 47.80 / 50.00 ms | 47.90 / 50.00 ms, n=10 | Existing registered API |
| Full report service p50/p95 | 25.09 / 26.85 ms | 25.28 / 28.01 ms, n=10 | Same real SQLite owner |
| Complete DTO bytes | 1,837,371 | 1,837,371 | Exact content hash |
| Full output | ERR_INVALID_URL | Print leaf / full PDF PASS | Actual output / PDFKit |

Final memory checkpoints: login 140.16 MiB; first report 254.63; three switches 284.89; after all-page/repeated navigation 418.25; after leaving 418.88. Full DTO/Chromium caching remains; no leak-elimination claim. Every logical row is accessible across 201 pages with exact financial strings/order/totals. Renderer bundle, viewer/table and report service bytes are unchanged.

Initial GREEN n=20: p50 **85.29**, p95 **136.59**, max **219.53 ms**, one 53-ms long task. This exceeded the diagnostic tail band and was retained. Isolated matched viewer control subsequently measured **83.41 / 83.52**, max **83.63 ms**, three-switch memory **284.45 MiB**. Final strict n=20 above is another complete run, not a selectively passing retry of a failed output gate. Output functions have not executed during these pre-output viewer samples, and no viewer/report-read code changed. No reproducible material regression attributable to the output correction was found. The reference bands are diagnostic, not invented SLOs.

## 15. SQLite, financial and reconciliation evidence

Fresh migrated disposable DB and RED, initial GREEN, control and final GREEN runtime copies: **53 migrations, SQLite 3.53.4, integrity ok, zero FK violations, all 73 read-only checks, zero findings/errors/warnings**. Health runner also verifies all table hashes unchanged across report/service/reconciliation reads. No check was removed.

Final document/viewing whole logical hash before and after is **ff8675a5452a81775ed2fa65946d47f50680c1174546e6726669eb4c301f7085**. Fixture/auth activities precede or follow that read-only boundary. Customers, orders, payments/refunds, cash, inventory/FIFO and audit records receive no output mutation. A separate independent integer oracle reduces fictional customer/order facts, preserves confirmed/completed inclusion and ordering, and matches all 10,034 rows/columns and **42,750,000 debt minor units**. Cash **143,140,000 minor units**, FIFO stock **1,940,000,000 micro units**, worker commission facts and all pre-existing financial tables remain exact. No repair writes or historical-date changes.

Fresh/data health: health-service.json / final-health.log; independent oracle: oracle.ts/json. Across RED/GREEN setup only the documented new customer's created_at and audit instants differ; runtime-setup-differences.json records it. Business viewing/output itself is wholly read-only. Original fixture bytes remain unchanged.

## 16. Regression gates and test-count reconciliation

Historical 3,619/280 baseline → **3,626/281 current PASS**: exactly **seven new cases / one new Vitest file**. No removed/newly skipped test, no unexplained decrease. Every pre-existing Vitest file remains byte-identical. The existing Electron harness was explicitly authorized and retains its strict `result.delivery.every(r => r.ok)` assertion; success now comes from actual corrected delivery.

Full command `npx vitest run --maxWorkers=2 --minWorkers=2`: exit **0**, wall **841.515 s**, Vitest **840.70 s** (transform 3.84; collect 76.99; tests 1556.97; environment 40 ms; prepare 11.74). **281 passed files, 3,626 passed tests, 0 failures/skips/unhandled errors**. Expected negative-case logger stderr is not hidden or classified as an unhandled test failure. DB-08 elapsed **688.45775 ms**, unchanged 2,000-ms threshold and unchanged test SHA `3cae17a65e2bdcaa96019126452f8614ebba29ac6cbb286dabb3d2b92b9c4a98`; no isolated rerun substitutes for full PASS.

Final typecheck **9.632 s**, lint **8.817 s**, build **3.059 s**, each exit 0. Build: main 1,086.46 kB, preload 13.03 kB, renderer JS 1,266.71 kB / CSS 62.18 kB; no build warning observed. Full suite includes unchanged backup/restore/BDR, E2E-01–03, UI-WF, FIFO/freeze, Contract C, BL-22 and audit atomicity regressions.

All exact commands/results are retained:

| Evidence run | Command | Exit | Monotonic wall seconds |
|---|---|---:|---:|
| `focused-red` | `npx vitest run tests/unit/main/perf01-large-output.test.ts --maxWorkers=2 --minWorkers=2` | 1 | 2.547 |
| `red-electron` | `node /tmp/aura-perf01-output/red-electron.mjs after` | 1 | 24.723 |
| `bisect-electron` | `node /tmp/aura-perf01-output/bisect-electron.mjs after` | 1 | 30.332 |
| `focused-green-final` | `npx vitest run tests/unit/main/perf01-large-output.test.ts tests/unit/main/approved-invoice-print-output.test.ts tests/ipc/perf01-report-contracts.test.ts tests/unit/renderer/perf01-report-rendering.test.ts --maxWorkers=2 --minWorkers=2` | 0 | 3.746 |
| `focused-security` | `npx vitest run tests/ipc/sec01-document-authorization.test.ts tests/ipc/sec02-avatar-containment.test.ts tests/ipc/sec04-login-audit.test.ts tests/unit/main/sec03-asset-protocol.test.ts tests/ipc/rbac-commercial-documents.test.ts tests/integration/db13-sargable-reports.test.ts tests/integration/permissions-documents.test.ts tests/integration/invoice-charges-print-visibility.test.ts tests/integration/post-bl03-financial-projection-ownership.test.ts --maxWorkers=2 --minWorkers=2` | 0 | 115.929 |
| `full` | `npx vitest run --maxWorkers=2 --minWorkers=2` | 0 | 841.515 |
| `final-typecheck` | `npm run typecheck` | 0 | 9.632 |
| `final-lint` | `npm run lint` | 0 | 8.817 |
| `final-build` | `npm run build` | 0 | 3.059 |
| `final-health` | `npx vite-node --config vitest.config.ts /tmp/aura-perf01-output/health-service.ts` | 0 | 3.995 |
| `final-green-electron` | `node tests/electron/perf01-report-pagination.mjs after` | 0 | 30.06 |
| `final-pdf-text` | `swift /tmp/aura-perf01-output/pdf-extract.swift /tmp/aura-perf01-output/final-green/after-runtime-43168/documents/2026/reports/customer_balances-1791541595098.pdf /tmp/aura-perf01-output/final-large-pdf-text.json` | 0 | 8.893 |
| `final-pdf-layout` | `swift /tmp/aura-perf01-output/pdf-layout.swift /tmp/aura-perf01-output/final-green/after-runtime-43168/documents/2026/reports/customer_balances-1791541595098.pdf /tmp/aura-perf01-output/final-large-pdf-layout.json` | 0 | 6.998 |
| `final-pdf-completeness` | `python3 /tmp/aura-perf01-output/verify-final-pdf.py` | 0 | 1.495 |
| `final-graph-update` | `graphify update .` | 0 | 15.747 |
| `final-graph-diagnose` | `graphify diagnose multigraph` | 0 | 1.259 |

Focused security command includes SEC-01/02/03/04, commercial-document RBAC, db13 report queries, document permissions, print-visibility and financial projection ownership. Full file paths are in focused-security-result.json/log. Native benchmark/control timings were taken separately from competing validation gates, except the explicitly labeled supplementary size ladder.

## 17. Final SHA-256 comparison

Complete sorted before/after manifests and comparison are external. Only authorized production owner and strict harness changed; one new focused test and this final report added. No deletions. Generated build/Graphify differences are separately enumerated in comparison.json. The final report's own hash is sealed externally, avoiding a recursive self-hash claim.

| File | Before SHA-256 | After SHA-256 |
|---|---|---|
| `src/main/services/documents/print.service.ts` | `c69b19caa40ae62ceec612bd671370924dca1c38b064fe1435a0b8f46f691de1` | `62638bb69077057ca068c6f08168005af2b50d94468633a00f2facbd4067e762` |
| `tests/electron/perf01-report-pagination.mjs` | `68cd36a264b4396915c05a081807b6eb296fc0a9ab0389fc5afbd3d32aef4cef` | `e3ff7a6db3f9f5e69bbefb60bc05e66d9dcea5a93cd262f60ad3657f34341533` |
| `tests/unit/main/perf01-large-output.test.ts` | `NEW` | `ef0eab08c28e8f269ee7f30760e6230d8f72167539664a3a52d7bb5e8e8f45a5` |
| `src/renderer/pages/reports/ReportsPage.tsx` | `0845b35469c24114324fc08d18b5bac3548fdf5b1ca50dffa054f771cbc34f9c` | `0845b35469c24114324fc08d18b5bac3548fdf5b1ca50dffa054f771cbc34f9c` |
| `src/main/ipc/router.ts` | `5e2cbd86926b521a04e57c7ca6185e5c9c837b4576d73092d3b5a98ae61e3223` | `5e2cbd86926b521a04e57c7ca6185e5c9c837b4576d73092d3b5a98ae61e3223` |
| `src/main/windows/print-window.ts` | `2536f0671d47c3691f438751574d4a22bfe0faac95e31bf4a481a56bd7229095` | `2536f0671d47c3691f438751574d4a22bfe0faac95e31bf4a481a56bd7229095` |
| `src/main/app/protocol.ts` | `1d39adc4c4ee33ffc4e84db1853146a8e12538602bd7b552f1d5a074a1060357` | `1d39adc4c4ee33ffc4e84db1853146a8e12538602bd7b552f1d5a074a1060357` |
| `src/main/reports/templates/documents.template.ts` | `ea3b08b72c11026443a46f23b6587e004e995ae16abb2ed9cd0e5d7d20cf687c` | `ea3b08b72c11026443a46f23b6587e004e995ae16abb2ed9cd0e5d7d20cf687c` |
| `out/main/index.js` | `941aeccce10d0bac14cc31992e1c092d08ebf39fa26439d378d5a3cfda020120` | `a92371b6da444817cedaa2f6b7ac7739e166bf26405a4dfd0696c5cbe7a22200` |
| `out/preload/index.cjs` | `d4d0def0b98e03f884abc424199d4995da940495c5a346f73a66f56a60388d58` | `d4d0def0b98e03f884abc424199d4995da940495c5a346f73a66f56a60388d58` |

All report SQL/financial/business owners, source viewer/shared table, migrations/schema, auth/permission/session, preload/router/channel map, CSP/window/protocol, archive/restore/reconciliation, BDR-01 trust files, BDR reports, previous audit reports, original assets, package/lockfiles and pre-existing Vitest tests remain unchanged. Renderer index/JS/CSS and preload compiled bytes are unchanged; only compiled main changes for the authorized output fix. No concurrent work was reverted or real data inspected.

External baseline/evidence directories **must remain until owner review**: `/tmp/aura-perf01-output-backup/`, `/tmp/aura-perf01-output/`; prior `/tmp/aura-perf01/` and source fixture/generator are retained. **/tmp is ephemeral**: copy these evidence/baseline directories to owner-controlled durable storage before machine cleanup/restart policies remove them. No cleanup was performed against review artifacts.

## 18. Remaining limitations

- Base64 removes the confirmed percent-expansion failure for this unchanged 10,034-row fixture. It does **not remove Chromium's finite data-URL ceiling**. Above roughly 1.5 MiB of raw UTF-8 HTML, a future report can still exceed that ceiling; long text changes the capacity. No unlimited-size/L/XL output guarantee. A different loading security boundary requires separate owner approval; no temporary HTML/protocol workaround was silently added.
- Full output builds a complete document and native PDF buffer; observed native ladder peak was ~2 GiB. Viewer paging does not bound output DOM/native print memory or full report DTO/IPC. No PERF-02/03 work.
- Existing Cairo print-font CORS limitation remains; no security policy was relaxed to solve it. Field values/title/rows/totals are independently exact despite that limitation.
- Physical print jobs, printer-driver/native-dialog interaction, power-loss PDF durability, abrupt-kill scratch cleanup, real disk-full and Windows rename/security behavior NOT TESTED. The user explicitly required leaf interception; it proves admission, not paper output.
- Publication failure tests use controlled filesystem fault boundaries; they are not tests against a real failing device. No long-duration output soak or capacity SLA.
- The initial timing tail and prior failed loading windows were retained as evidence. The corrected boundary is not described as a new pagination regression.

## 19. Windows native

**NOT TESTED.** No Windows installer, printing, performance or recovery qualification. Only actual compiled unpackaged macOS Electron and macOS PDFKit executed.

## 20. STOP conditions

**NONE triggered.** The existing data loader was reused with different encoding. No protected protocol/custom scheme/CSP/security-control change, generic IPC, temporary HTML loader, database/business/auth/permission/dependency expansion or real customer data was needed. Failure cleanup and PDF publication stay in the authorized output owner; the 50-row presentation is untouched.

## 21. Final gate matrix and owner review

| Gate | Result | Actual evidence |
|---|---|---|
| Large-report RED reproduced | PASS | pre-edit native red-electron.log/after-electron.json, exit 1 |
| Root cause demonstrated | PASS | identical-content native encoding controls + six-step bracket + URL bytes |
| Large-report PDF delivery | PASS | final-green real native printToPDF, 372 pages / 1,751,726 bytes |
| Full PDF content independently verified | PASS | final PDFKit coordinate reconstruction: all 10,034 × six fields/order/totals exact |
| Large-report print reaches safe printer leaf | PASS | load fulfilled → interceptor installed → logged leaf; no physical job |
| Small-report PDF preserved | PASS | actual monthly-profit success, header/EOF; prior PDFKit one-page control |
| Security permissions preserved | PASS | real anonymous/restricted print/PDF denials; 342 focused security/finance tests |
| Cleanup and partial-file safety | PASS | only main native window remains; no scratch; exact owner failure/publication tests |
| PERF-01 50-row viewer preserved | PASS | 201 pages / all logical rows and cells exact |
| PERF-01 performance comparison | PASS | final 20-sample matched protocol + retained initial/control distributions; no attributable material regression |
| Full Vitest | PASS | 3,626 tests / 281 files, exit 0; seven-case increase explained |
| Typecheck / Lint / Build | PASS | final result JSON, exits 0 / 0 / 0 |
| SQLite / 73 reconciliations | PASS | fresh + all runtime copies, integrity ok / FK 0 / findings 0 |
| Graphify | PASS | final diagnostics, existing loops/suppression disclosed |
| Unauthorized changes | NO | complete hash comparison and external original diffs |
| STOP condition triggered | NO | existing data-origin/permissions preserved; no prohibited scope expansion |

```text
PERF-01:
VERIFIED CLOSED — RECOMMENDED FOR OWNER REVIEW (CONFIRMED 10,034-ROW CASE)

LARGE PRINT/PDF DELIVERY:
PASS

INDEPENDENT FULL PDF COMPLETENESS:
PASS

BOUNDED VIEWER / PERFORMANCE PRESERVATION:
PASS

FULL VITEST:
PASS — 3,626 TESTS / 281 FILES

TYPECHECK / LINT / BUILD:
PASS

SQLITE / 73 RECONCILIATIONS:
PASS

PONYTAIL FULL:
COMPLETE

GRAPHIFY:
PASS

UNAUTHORIZED CHANGES:
NO

STOP CONDITIONS:
NONE

PERF-02 / PERF-03:
OPEN — UNCHANGED

BDR-01:
OPEN — UNCHANGED

BDR-02:
VERIFIED CLOSED — UNCHANGED

WINDOWS / PHYSICAL PRINTING:
NOT TESTED

READY FOR OWNER REVIEW:
YES
```

Owner decision: review the scoped code, exact PDF proof and documented finite URL/native-memory limits. Official closure remains an owner decision. No follow-on remediation, recovery work, release-readiness phase or Windows qualification is started. Work stops after this report and its external preservation seal.
