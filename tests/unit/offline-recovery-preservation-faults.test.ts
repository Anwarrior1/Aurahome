import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { preserveOriginalTuple } from '../../src/main/recovery/offline-state'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

function fiction(healthy = false): { root: string; data: string; retention: string } {
  const root = mkdtempSync(join(tmpdir(), 'aura-bdr01-fiction-')); roots.push(root)
  const data = join(root, 'data'); mkdirSync(data)
  if (healthy) {
    const db = new Database(join(data, 'erp.db'))
    db.exec('CREATE TABLE fictional (id INTEGER PRIMARY KEY, amount_minor INTEGER NOT NULL); INSERT INTO fictional VALUES (1, 50000)')
    db.close()
  } else writeFileSync(join(data, 'erp.db'), Buffer.from('corrupt fictional SQLite'))
  return { root, data, retention: join(root, 'retained') }
}
function sha(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

describe('raw tuple preservation fault injection on fictional files', () => {
  it.each([true, false])('preserves exact bytes for healthy=%s database', async (healthy) => {
    const f = fiction(healthy)
    const original = readFileSync(join(f.data, 'erp.db'))
    const result = await preserveOriginalTuple(f.data, f.retention)
    expect(readFileSync(join(f.retention, 'erp.db'))).toEqual(original)
    expect(result.files[0]).toEqual({ name: 'erp.db', present: true, size: original.length, sha256: sha(original) })
    expect(result.files.slice(1).map((entry) => entry.present)).toEqual([false, false])
  })

  it.each([[true, false], [false, true], [true, true]])('records WAL=%s and SHM=%s exactly', async (wal, shm) => {
    const f = fiction()
    if (wal) writeFileSync(join(f.data, 'erp.db-wal'), Buffer.from([1, 2, 3]))
    if (shm) writeFileSync(join(f.data, 'erp.db-shm'), Buffer.from([4, 5, 6]))
    const result = await preserveOriginalTuple(f.data, f.retention)
    expect(result.files.map((entry) => entry.present)).toEqual([true, wal, shm])
    for (const entry of result.files.filter((value) => value.present)) {
      expect(readFileSync(join(f.retention, entry.name))).toEqual(readFileSync(join(f.data, entry.name)))
    }
  })

  it.each(['EACCES', 'ENOSPC', 'EINTR'])('fails closed on injected %s and never overwrites retained bytes', async (code) => {
    const f = fiction()
    const original = readFileSync(join(f.data, 'erp.db'))
    await expect(preserveOriginalTuple(f.data, f.retention, { afterCopy: () => {
      throw Object.assign(new Error(code), { code })
    } })).rejects.toThrow(code)
    expect(readFileSync(join(f.retention, 'erp.db'))).toEqual(original)
    await expect(preserveOriginalTuple(f.data, f.retention)).rejects.toThrow()
  })

  it('rejects an injected file-flush failure and retains the copied bytes', async () => {
    const f = fiction()
    const original = readFileSync(join(f.data, 'erp.db'))
    await expect(preserveOriginalTuple(f.data, f.retention, { beforeFlush: () => {
      throw Object.assign(new Error('EIO flush'), { code: 'EIO' })
    } })).rejects.toThrow('EIO flush')
    expect(readFileSync(join(f.retention, 'erp.db'))).toEqual(original)
  })

  it('rejects a partial copied file and retains the evidence', async () => {
    const f = fiction()
    await expect(preserveOriginalTuple(f.data, f.retention, { afterCopy: (name) => {
      truncateSync(join(f.retention, name), 2)
    } })).rejects.toThrow(/changed during preservation/)
    expect(readFileSync(join(f.retention, 'erp.db')).length).toBe(2)
  })

  it('rejects a same-length hash mismatch without deleting the retained bytes', async () => {
    const f = fiction()
    const original = readFileSync(join(f.data, 'erp.db'))
    await expect(preserveOriginalTuple(f.data, f.retention, { afterCopy: (name) => {
      writeFileSync(join(f.retention, name), Buffer.alloc(original.length, 8))
    } })).rejects.toThrow(/changed during preservation/)
    expect(readFileSync(join(f.retention, 'erp.db'))).toEqual(Buffer.alloc(original.length, 8))
  })
})
