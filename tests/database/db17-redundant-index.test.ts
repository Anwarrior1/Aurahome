import { performance } from 'node:perf_hooks'
import { statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getDatabasePath, getRawConnection } from '@main/db/connection'
import { setupTestDatabase } from '../helpers/test-db'

const CANDIDATE = 'final_invoice_terms_invoice_idx'
const RETAINED = 'final_invoice_terms_unique'
const scales = process.env.DB17_SCALES
  ? process.env.DB17_SCALES.split(',').map(Number)
  : [1_000]

interface IndexListRow {
  name: string
  unique: number
  origin: 'c' | 'u' | 'pk'
  partial: number
}

interface IndexXInfoRow {
  name: string | null
  desc: number
  coll: string
  key: number
}

function indexColumns(name: string): Array<{ name: string | null; desc: boolean; coll: string }> {
  return (getRawConnection().pragma(`index_xinfo(${JSON.stringify(name)})`) as IndexXInfoRow[])
    .filter(({ key }) => key === 1)
    .map((column) => ({ name: column.name, desc: Boolean(column.desc), coll: column.coll }))
}

function plan(sql: string): string {
  return (getRawConnection().prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
    .map(({ detail }) => detail)
    .join(' | ')
}

function relevantPlans(invoiceId: number): Record<string, string> {
  return {
    orderedRead: plan(`SELECT id, final_invoice_id, term_index, term_text, created_at
      FROM final_invoice_terms WHERE final_invoice_id = ${invoiceId} ORDER BY term_index`),
    updateByInvoice: plan(`UPDATE final_invoice_terms SET term_text = term_text WHERE final_invoice_id = ${invoiceId}`),
    deleteByInvoice: plan(`DELETE FROM final_invoice_terms WHERE final_invoice_id = ${invoiceId}`),
    removeByRowAndInvoice: plan(`DELETE FROM final_invoice_terms WHERE id = 1 AND final_invoice_id = ${invoiceId}`),
    parentCascade: plan(`DELETE FROM final_invoices WHERE id = ${invoiceId}`)
  }
}

function median(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
}

function warmMedian(run: () => void, runs = 7): number {
  run()
  const durations: number[] = []
  for (let attempt = 0; attempt < runs; attempt += 1) {
    const start = performance.now()
    run()
    durations.push(performance.now() - start)
  }
  return median(durations)
}

function savepointMedian(run: () => void, runs = 5): number {
  const raw = getRawConnection()
  const durations: number[] = []
  for (let attempt = 0; attempt < runs; attempt += 1) {
    raw.exec('SAVEPOINT db17_probe')
    const start = performance.now()
    run()
    durations.push(performance.now() - start)
    raw.exec('ROLLBACK TO db17_probe; RELEASE db17_probe')
  }
  return median(durations)
}

function seedTerms(termCount: number): { invoiceCount: number; probeInvoiceId: number } {
  const raw = getRawConnection()
  const termsPerInvoice = 10
  const invoiceCount = Math.ceil(termCount / termsPerInvoice)
  const insertInvoice = raw.prepare(`INSERT INTO final_invoices
    (document_number, customer_id, status, created_at) VALUES (?, 1, 'draft', ?)`)
  const insertTerm = raw.prepare(`INSERT INTO final_invoice_terms
    (final_invoice_id, term_index, term_text, created_at) VALUES (?, ?, ?, ?)`)
  const createdAt = '2026-09-16T00:00:00.000Z'
  raw.prepare("INSERT INTO customers (id, name, created_at) VALUES (1, 'DB17', ?)").run(createdAt)
  raw.transaction(() => {
    let inserted = 0
    for (let invoice = 0; invoice < invoiceCount; invoice += 1) {
      const invoiceId = Number(insertInvoice.run(`DB17-${termCount}-${invoice}`, createdAt).lastInsertRowid)
      for (let term = 0; term < termsPerInvoice && inserted < termCount; term += 1) {
        insertTerm.run(invoiceId, term, `term-${term}`, createdAt)
        inserted += 1
      }
    }
  })()
  return { invoiceCount, probeInvoiceId: Math.max(1, Math.floor(invoiceCount / 2)) }
}

function measure(probeInvoiceId: number, invoiceCount: number) {
  const raw = getRawConnection()
  const select = raw.prepare(`SELECT id, final_invoice_id, term_index, term_text, created_at
    FROM final_invoice_terms WHERE final_invoice_id = ? ORDER BY term_index`)
  const insert = raw.prepare(`INSERT INTO final_invoice_terms
    (final_invoice_id, term_index, term_text, created_at)
    VALUES (?, 10, 'write-probe', '2099-01-01T00:00:00.000Z')`)
  const update = raw.prepare("UPDATE final_invoice_terms SET term_text = term_text || '-u' WHERE final_invoice_id = ?")
  const remove = raw.prepare('DELETE FROM final_invoice_terms WHERE final_invoice_id = ?')
  const batch = Math.min(2_000, invoiceCount)
  const ids = Array.from({ length: batch }, (_, index) => index + 1)
  return {
    selectMedianMs: warmMedian(() => select.all(probeInvoiceId)),
    insertMedianMs: savepointMedian(() => { for (const id of ids) insert.run(id) }),
    updateMedianMs: savepointMedian(() => { for (const id of ids) update.run(id) }),
    deleteMedianMs: savepointMedian(() => { for (const id of ids) remove.run(id) })
  }
}

describe('DB-17 redundant-index evidence', () => {
  it('leaves no same-prefix overlap in the current migrated schema', () => {
    const env = setupTestDatabase()
    try {
      const raw = getRawConnection()
      const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").pluck().all() as string[]
      const indexes = tables.flatMap((table) =>
        (raw.pragma(`index_list(${JSON.stringify(table)})`) as IndexListRow[]).map((entry) => ({
          table,
          ...entry,
          columns: indexColumns(entry.name)
        }))
      )
      const overlaps = indexes.flatMap((left, index) => indexes.slice(index + 1).flatMap((right) => {
        if (left.table !== right.table || left.partial !== right.partial) return []
        const shared = Math.min(left.columns.length, right.columns.length)
        if (shared === 0 || JSON.stringify(left.columns.slice(0, shared)) !== JSON.stringify(right.columns.slice(0, shared))) return []
        return [{ table: left.table, names: [left.name, right.name].sort() }]
      }))
      expect(overlaps).toEqual([])
      expect(indexColumns(CANDIDATE)).toEqual([])
      expect(indexColumns(RETAINED)).toEqual([
        { name: 'final_invoice_id', desc: false, coll: 'BINARY' },
        { name: 'term_index', desc: false, coll: 'BINARY' }
      ])
      expect(raw.prepare("SELECT sql FROM sqlite_master WHERE name = ?").pluck().get(CANDIDATE)).toBeUndefined()
      expect(raw.prepare("SELECT sql FROM sqlite_master WHERE name = ?").pluck().get(RETAINED)).toContain('CREATE UNIQUE INDEX')
      console.log(`DB17_INVENTORY ${JSON.stringify({
        indexes: indexes.length,
        explicit: indexes.filter(({ origin }) => origin === 'c').length,
        autoConstraint: indexes.filter(({ origin }) => origin !== 'c').length,
        unique: indexes.filter((entry) => Boolean(entry.unique)).length,
        partial: indexes.filter((entry) => Boolean(entry.partial)).length,
        samePrefixOverlaps: overlaps.length
      })}`)
    } finally {
      env.cleanup()
    }
  })

  for (const scale of scales) it(`compares the candidate present/absent at ${scale} term rows`, () => {
    const env = setupTestDatabase()
    try {
      const raw = getRawConnection()
      const { invoiceCount, probeInvoiceId } = seedTerms(scale)
      raw.exec(`CREATE INDEX ${CANDIDATE} ON final_invoice_terms(final_invoice_id)`)
      raw.exec('ANALYZE')
      const beforePlans = relevantPlans(probeInvoiceId)
      const before = measure(probeInvoiceId, invoiceCount)
      const candidateBytes = Number(raw.prepare('SELECT COALESCE(SUM(pgsize), 0) FROM dbstat WHERE name = ?').pluck().get(CANDIDATE))
      raw.pragma('wal_checkpoint(TRUNCATE)')
      const beforeBytes = statSync(getDatabasePath()).size

      const dropStart = performance.now()
      raw.exec(`DROP INDEX ${CANDIDATE}`)
      const dropIndexMs = performance.now() - dropStart
      raw.exec('ANALYZE')
      const afterPlans = relevantPlans(probeInvoiceId)
      const after = measure(probeInvoiceId, invoiceCount)
      raw.exec('VACUUM')
      raw.pragma('wal_checkpoint(TRUNCATE)')
      const afterBytes = statSync(getDatabasePath()).size

      expect(beforePlans.orderedRead).toMatch(/USING INDEX final_invoice_terms_unique/)
      expect(afterPlans.orderedRead).toMatch(/USING INDEX final_invoice_terms_unique/)
      expect(afterPlans.updateByInvoice).toMatch(/USING (COVERING )?INDEX final_invoice_terms_unique/)
      expect(afterPlans.deleteByInvoice).toMatch(/USING (COVERING )?INDEX final_invoice_terms_unique/)
      expect(afterPlans.removeByRowAndInvoice).toMatch(/USING INTEGER PRIMARY KEY/)
      expect(afterPlans.parentCascade).toMatch(/final_invoice_terms_unique/)
      expect(Object.values(afterPlans).join(' ')).not.toContain(CANDIDATE)
      expect(candidateBytes).toBeGreaterThan(0)
      expect(afterBytes).toBeLessThan(beforeBytes)
      expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      expect(raw.pragma('foreign_key_check')).toEqual([])
      console.log(`DB17_MEASURE ${JSON.stringify({
        scale,
        invoiceCount,
        candidateBytes,
        beforeBytes,
        afterBytes,
        reclaimedBytes: beforeBytes - afterBytes,
        dropIndexMs: Number(dropIndexMs.toFixed(3)),
        beforePlans,
        afterPlans,
        before: Object.fromEntries(Object.entries(before).map(([key, value]) => [key, Number(value.toFixed(3))])),
        after: Object.fromEntries(Object.entries(after).map(([key, value]) => [key, Number(value.toFixed(3))]))
      })}`)
    } finally {
      env.cleanup()
    }
  }, 1_800_000)
})
