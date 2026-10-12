import { performance } from 'node:perf_hooks'
import { getRawConnection } from '@main/db/connection'
import { traceQueries, payloadBytes } from './query-counter'

export interface Measurement {
  scenario: string
  dbRows?: number
  rowsReturned: number
  queries: number
  medianMs: number
  p95Ms: number
  runs: number
  payloadBytes: number
  heapDeltaBytes: number
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!
}

/** Runs a synchronous main-process read; its duration is also its event-loop block. */
export function measure<T>(
  scenario: string,
  fn: () => T,
  rowsOf: (value: T) => number,
  options: { runs?: number; dbRows?: number } = {}
): Measurement & { result: T } {
  const runs = options.runs ?? 5
  fn()
  const heapBefore = process.memoryUsage().heapUsed
  const traced = traceQueries(fn)
  const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore
  const durations: number[] = []
  for (let run = 0; run < runs; run += 1) {
    const start = performance.now()
    fn()
    durations.push(performance.now() - start)
  }
  durations.sort((a, b) => a - b)
  const measurement = {
    scenario,
    dbRows: options.dbRows,
    rowsReturned: rowsOf(traced.result),
    queries: traced.count,
    medianMs: Number(percentile(durations, 0.5).toFixed(2)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(2)),
    runs,
    payloadBytes: payloadBytes(traced.result),
    heapDeltaBytes
  }
  console.log(`DB10_MEASURE ${JSON.stringify(measurement)}`)
  return { ...measurement, result: traced.result }
}

export function queryPlan(sqlText: string, ...params: unknown[]): string[] {
  return (getRawConnection().prepare(`EXPLAIN QUERY PLAN ${sqlText}`).all(...params) as Array<{ detail: string }>)
    .map((row) => row.detail)
}

export function tableCount(table: string): number {
  return (getRawConnection().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
}
