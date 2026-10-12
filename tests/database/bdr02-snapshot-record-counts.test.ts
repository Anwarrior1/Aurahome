import { afterEach, describe, expect, it } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createBackup, validateBackup } from '@main/backup/backup.service'
import { extractArchiveBounded, readArchive, writeArchive } from '@main/backup/archive'
import { MANIFEST_ENTRY, DATABASE_ENTRY, type BackupManifest } from '@main/backup/manifest'
import { getRawConnection } from '@main/db/connection'
import { reconcileDatabase } from '@main/db/reconciliation'
import { restoreFromBackup } from '@main/restore/restore.service'
import { createCustomer } from '@main/services/parties/parties.service'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'

const tables = [
  'users', 'customers', 'suppliers', 'materials', 'fifo_layers', 'inventory_movements',
  'quotations', 'orders', 'customer_payments', 'customer_payment_refunds', 'expenses', 'cash_transactions'
]
let env: TestEnv | undefined
afterEach(() => env?.cleanup())

async function inspectArchive(path: string, candidate: string) {
  const extracted = await extractArchiveBounded(path, candidate)
  const manifest = JSON.parse(extracted.manifest.toString('utf8')) as BackupManifest
  const db = new BetterSqlite3(candidate, { readonly: true, fileMustExist: true })
  try {
    const counts = Object.fromEntries(tables.map(table => [table,
      (db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count
    ]))
    return { manifest, counts, customers: db.prepare('SELECT * FROM customers ORDER BY id').all(),
      integrity: db.pragma('integrity_check'), foreignKeys: db.pragma('foreign_key_check'),
      reconciliation: reconcileDatabase(db) }
  } finally { db.close() }
}

describe('BDR-02 manifest counts describe the packaged SQLite snapshot', () => {
  it('keeps every archived count at the snapshot epoch while an authorized live write commits after the snapshot', async () => {
    env = setupTestDatabase()
    createCustomer({ name: 'BDR02 archived customer' }, env.ctx)
    const raw = getRawConnection()
    const beforeCustomers = raw.prepare('SELECT * FROM customers ORDER BY id').all()
    let release!: () => void
    let arrived!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const snapshotEstablished = new Promise<void>(resolve => { arrived = resolve })
    const pending = createBackup({ destinationFilePath: join(env.dir, 'concurrent.aurabak'), includeConfig: false }, env.ctx, {
      afterSnapshotAsync: async () => { arrived(); await barrier }
    })
    await snapshotEstablished
    try { createCustomer({ name: 'BDR02 later live customer' }, env.ctx) } finally { release() }
    const backup = await pending
    const archived = await inspectArchive(backup.path, join(env.dir, 'inspection.db'))
    expect(archived.customers).toEqual(beforeCustomers)
    expect(raw.prepare('SELECT COUNT(*) AS count FROM customers').get()).toEqual({ count: 2 })
    expect(archived.counts.customers).toBe(1)
    expect(Object.keys(archived.manifest.recordCounts).sort()).toEqual([...tables].sort())
    console.log('BDR02 snapshot oracle', { liveCustomers: 2, archivedCustomers: archived.counts.customers,
      manifestCustomers: archived.manifest.recordCounts.customers })
    expect(archived.manifest.recordCounts).toEqual(archived.counts)
    expect(backup.manifest.recordCounts).toEqual(archived.counts)
    expect(archived.integrity).toEqual([{ integrity_check: 'ok' }])
    expect(archived.foreignKeys).toEqual([])
    expect(archived.reconciliation).toMatchObject({ checksRun: 73, errorCount: 0, warningCount: 0, findings: [] })
    expect(await validateBackup(backup.path)).toMatchObject({ valid: true, manifest: backup.manifest })
    expect(raw.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='backup.create'").get()).toEqual({ count: 1 })
    await restoreFromBackup({ backupFilePath: backup.path }, env.ctx)
    const restored = getRawConnection()
    expect(restored.prepare('SELECT * FROM customers ORDER BY id').all()).toEqual(beforeCustomers)
    expect(restored.prepare('SELECT * FROM cash_transactions').all()).toEqual([])
    expect(restored.prepare('SELECT * FROM inventory_movements').all()).toEqual([])
    expect(reconcileDatabase(restored).findings).toEqual([])
  })

  it('counts empty and populated tables exactly on repeated backups without changing business rows', async () => {
    env = setupTestDatabase()
    createCustomer({ name: 'BDR02 repeated customer' }, env.ctx)
    const customersBefore = getRawConnection().prepare('SELECT * FROM customers ORDER BY id').all()
    const counts: Record<string, number>[] = []
    for (let i = 0; i < 2; i++) {
      const backup = await createBackup({ destinationFilePath: join(env.dir, `repeated-${i}.aurabak`) }, env.ctx)
      const archived = await inspectArchive(backup.path, join(env.dir, `repeated-${i}.db`))
      expect(archived.manifest.recordCounts).toEqual(archived.counts)
      expect(archived.counts.customers).toBe(1)
      expect(archived.counts.users).toBeGreaterThan(0)
      expect(archived.counts.orders).toBe(0)
      expect(archived.counts.cash_transactions).toBe(0)
      counts.push(archived.counts)
    }
    expect(counts[1]).toEqual(counts[0])
    expect(getRawConnection().prepare('SELECT * FROM customers ORDER BY id').all()).toEqual(customersBefore)
  })

  it('preserves legacy AURABAK1 reading and the existing numeric representation for large descriptive counts', async () => {
    env = setupTestDatabase()
    const backup = await createBackup({ destinationFilePath: join(env.dir, 'current.aurabak'), includeConfig: false }, env.ctx)
    const entries = readArchive(backup.path)
    const manifest = JSON.parse(entries.get(MANIFEST_ENTRY)!.toString('utf8')) as BackupManifest
    delete manifest.migration
    // Older metadata remains readable; validation never authenticated its descriptive counts.
    const largeCount = 2 ** 32 + 123
    manifest.recordCounts.customers = largeCount
    const legacy = join(env.dir, 'legacy.aurabak')
    writeArchive(legacy, [
      { name: MANIFEST_ENTRY, data: Buffer.from(JSON.stringify(manifest)) },
      { name: DATABASE_ENTRY, data: entries.get(DATABASE_ENTRY)! }
    ])
    expect(readFileSync(legacy).subarray(0, 8).toString('ascii')).toBe('AURABAK1')
    const validated = await validateBackup(legacy)
    expect(validated.valid).toBe(true)
    expect(validated.manifest?.recordCounts.customers).toBe(largeCount)
  })

  it('does not publish a backup when the deterministic post-snapshot barrier fails', async () => {
    env = setupTestDatabase()
    const path = join(env.dir, 'failed.aurabak')
    await expect(createBackup({ destinationFilePath: path }, env.ctx, {
      afterSnapshotAsync: async () => { throw new Error('BDR02 controlled interruption') }
    })).rejects.toThrow('BDR02 controlled interruption')
    expect(existsSync(path)).toBe(false)
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(getRawConnection().prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='backup.create'").get()).toEqual({ count: 0 })
  })
})
