import type Database from 'better-sqlite3'
import { performance } from 'node:perf_hooks'
import { getRawConnection } from '@main/db/connection'

export interface QueryTrace<T> {
  result: T
  /** Statement executions (all/get/run/iterate) on the process connection. */
  count: number
  statements: string[]
  statementDurationsMs: number[]
  sqlDurationMs: number
}

const EXECUTORS = ['all', 'get', 'run', 'iterate'] as const

/**
 * Counts every statement execution issued through the single process
 * connection while `fn` runs. Drizzle and raw better-sqlite3 calls both
 * prepare through `Database.prepare`, so wrapping the returned statement's
 * executors observes both paths without changing production code.
 */
export function traceQueries<T>(fn: () => T): QueryTrace<T> {
  const connection = getRawConnection() as Database.Database & { prepare: Database.Database['prepare'] }
  const originalPrepare = connection.prepare
  const statements: string[] = []
  const statementDurationsMs: number[] = []
  connection.prepare = function prepare(this: Database.Database, source: string) {
    const statement = originalPrepare.call(this, source) as Database.Statement & Record<string, unknown>
    for (const name of EXECUTORS) {
      const executor = statement[name] as (...args: unknown[]) => unknown
      statement[name] = function execute(this: unknown, ...args: unknown[]) {
        statements.push(source.replace(/\s+/g, ' ').trim())
        const start = performance.now()
        try {
          return executor.apply(statement, args)
        } finally {
          statementDurationsMs.push(performance.now() - start)
        }
      }
    }
    return statement
  } as Database.Database['prepare']
  try {
    const result = fn()
    return {
      result,
      count: statements.length,
      statements,
      statementDurationsMs,
      sqlDurationMs: statementDurationsMs.reduce((sum, duration) => sum + duration, 0)
    }
  } finally {
    connection.prepare = originalPrepare
  }
}

export function payloadBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
}
