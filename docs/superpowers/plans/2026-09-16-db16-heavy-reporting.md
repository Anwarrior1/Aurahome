# DB-16 Heavy Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure and minimally remediate justified synchronous Main-process reporting and profitability bottlenecks without changing financial semantics or DB-15 observational reads.

**Architecture:** Reuse the existing deterministic scale fixture and service entry points so benchmarks exercise the same synchronous functions invoked by IPC. Make only evidence-backed SQL/index/service changes, with oracle and read-only gates around every changed path.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, Drizzle SQL, Electron Main IPC, SQLite `EXPLAIN QUERY PLAN`.

**Spec:** `docs/superpowers/specs/2026-09-16-db16-heavy-reporting-design.md`

## Global Constraints

- Work only on DB-16; do not start DB-17 or DB-18.
- Ponytail full mode: prefer the smallest measured fix and no speculative infrastructure.
- Complete reports remain complete; do not paginate or cap report/export semantics.
- Preserve exact integer financial results and all existing ERP guarantees.
- Preserve DB-15 derive-in-reads/post-in-commands behavior and zero read-triggered financial writes.
- Never modify the production database; all scale work uses isolated test databases.

---

### Task 1: Baseline inventory and benchmark harness

**Files:**
- Create: `tests/database/db16-scale-benchmark.test.ts`
- Read: `tests/helpers/db10-fixtures.ts`
- Read: `tests/helpers/db10-measure.ts`
- Read: production services identified in the design

**Interfaces:**
- Consumes: `seedDb10Fixture(orderCount)`, `measure(...)`, `traceQueries(...)`, `queryPlan(...)`, and existing production service functions.
- Produces: reproducible `DB16_MEASURE`, `DB16_BREAKDOWN`, and `DB16_PLAN` output for every candidate.

- [ ] Add a smoke-scale benchmark that invokes every candidate and asserts financial/read-only invariants, not timing constants.
- [ ] Run `npx vitest run tests/database/db16-scale-benchmark.test.ts` and verify the harness passes at the control scale.
- [ ] Run the same suite with `DB16_SCALES=10000,100000` and capture baseline logs.
- [ ] Run a larger scale only if 10k→100k evidence does not establish the curve.
- [ ] Record classifications, root causes, and FIX/LEAVE decisions before editing production code.

### Task 2: First evidence-backed remediation slice

**Files:**
- Modify only the production service or append-only migration proven necessary by Task 1.
- Modify: `tests/database/db16-scale-benchmark.test.ts`
- Modify existing oracle/regression tests only to add coverage, never to weaken expectations.

**Interfaces:**
- Consumes: exact baseline fixture, SQL plans, and financial oracle outputs from Task 1.
- Produces: unchanged payload/value semantics with lower measured Main blocking for the selected path.

- [ ] Add a behavior/query-plan test that fails under the measured root cause and names the production regression it catches.
- [ ] Run the focused test and verify the expected failure before production edits.
- [ ] Implement the smallest SQL/index/materialization change that addresses the measured cause.
- [ ] Run the focused test and existing financial equivalence suites until green.
- [ ] Repeat the identical benchmark and retain before/after evidence.

### Task 3: Remaining justified remediation slices

**Files:**
- Modify only additional services/migrations independently justified by Task 1.
- Modify: `tests/database/db16-scale-benchmark.test.ts`

**Interfaces:**
- Consumes: Task 1 candidate decisions and the green financial/DB-15 gates from Task 2.
- Produces: one independently verified change per remaining FIX decision; no code for LEAVE decisions.

- [ ] For each remaining FIX decision, add and run one failing behavior or query-plan test.
- [ ] Implement one minimal change, then run its focused and financial equivalence tests.
- [ ] Repeat identical before/after measurements before moving to another candidate.
- [ ] Stop when all remaining candidates are measured LEAVE decisions or meet the response target.

### Task 4: Cross-audit regression and final scale qualification

**Files:**
- Modify tests only if a missing DB-16 regression is demonstrated.

**Interfaces:**
- Consumes: final production code and unchanged deterministic fixtures.
- Produces: recorded results for DB-02/05/10/12/13/14/15 and full project verification.

- [ ] Run focused DB-16, profitability/costing equivalence, report/dashboard/financial, and DB-15 observational-read tests.
- [ ] Run DB-02, DB-05, DB-10, DB-12, DB-13, and DB-14 regression groups.
- [ ] Run final 10k/100k DB-16 scale qualification and compare identical scenarios.
- [ ] Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`.
- [ ] Remove non-permanent scratch databases and benchmark artifacts.

### Task 5: Final audit

**Files:**
- Create: `DB16_FINAL_AUDIT.md`

**Interfaces:**
- Consumes: Graphify trace, source verification, baseline/final logs, query plans, tests, and build results.
- Produces: the 22 requested audit sections and exact final closure lines.

- [ ] Write every requested section with measured evidence and explicit FIX/LEAVE decisions.
- [ ] List files changed, storage/write cost, remaining risks, and deliberately unchanged candidates.
- [ ] End exactly with the two required DB-16/DB-17 disposition lines.
