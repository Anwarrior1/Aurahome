import Database from 'better-sqlite3'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadMigrationBundle } from '@main/migrations/compatibility'
import { CANONICAL_MIGRATION_HISTORY, CURRENT_MIGRATION_INDEX } from '@main/migrations/migration-history'
import { runMigrationsFromFolder } from '@main/migrations/migration-runner'

const FOLDER = 'drizzle/migrations/'

function bundleBefore(dir: string): string {
  const previous = join(dir, 'previous')
  mkdirSync(join(previous, 'meta'), { recursive: true })
  const journal = JSON.parse(readFileSync(`${FOLDER}meta/_journal.json`, 'utf8'))
  writeFileSync(join(previous, 'meta/_journal.json'), JSON.stringify({
    ...journal, entries: journal.entries.filter((entry: { idx: number }) => entry.idx < 53)
  }))
  for (const file of readdirSync(FOLDER).filter((file) => file.endsWith('.sql') && file < '0053')) {
    copyFileSync(`${FOLDER}${file}`, join(previous, file))
  }
  return previous
}

describe('0053 explicit Raw Materials category visibility', () => {
  it('pins one new migration without changing the historical bundle', () => {
    expect(CURRENT_MIGRATION_INDEX).toBe(53)
    expect(CANONICAL_MIGRATION_HISTORY[53]).toMatchObject({
      idx: 53, tag: '0053_raw_material_category_visibility'
    })
    expect(() => loadMigrationBundle(FOLDER, true)).not.toThrow()
  })

  it('upgrades populated data selectively and preserves assignments across reopening', () => {
    const dir = mkdtempSync(join(tmpdir(), 'category-visibility-upgrade-'))
    const dbPath = join(dir, 'upgrade.db')
    const raw = new Database(dbPath)
    raw.pragma('foreign_keys = ON')
    try {
      runMigrationsFromFolder(raw, bundleBefore(dir))
      raw.exec(`
        INSERT INTO material_categories (id, name, node_kind) VALUES
          (1, 'Root', 'main_category'),
          (5, 'Unused root', 'main_category');
        INSERT INTO material_categories (id, name, node_kind, parent_id) VALUES
          (2, 'Family', 'material_family', 1),
          (3, 'Type', 'material_type', 2),
          (4, 'Linked leaf', 'inventory_leaf', 3);
        INSERT INTO materials (id, sku, name, category_id, unit, pricing_rule) VALUES
          (10, 'DIRECT-FAMILY', 'Direct family', 2, 'unit', 'exact');
        INSERT INTO materials (id, sku, name, category_id, hierarchy_node_id, unit, pricing_rule) VALUES
          (11, 'LINKED', 'Linked', 4, 4, 'unit', 'exact');
      `)
      const before = raw.prepare('SELECT id, sku, category_id, hierarchy_node_id FROM materials ORDER BY id').all()
      runMigrationsFromFolder(raw, FOLDER)
      expect(raw.prepare('SELECT id, show_in_raw_materials FROM material_categories ORDER BY id').all()).toEqual([
        { id: 1, show_in_raw_materials: 0 },
        { id: 2, show_in_raw_materials: 1 },
        { id: 3, show_in_raw_materials: 1 },
        { id: 4, show_in_raw_materials: 0 },
        { id: 5, show_in_raw_materials: 0 }
      ])
      expect(raw.prepare('SELECT id, sku, category_id, hierarchy_node_id FROM materials ORDER BY id').all()).toEqual(before)
      raw.prepare('UPDATE material_categories SET show_in_raw_materials = 1 WHERE id = 5').run()
      raw.close()

      const reopened = new Database(dbPath)
      try {
        expect(reopened.prepare('SELECT show_in_raw_materials FROM material_categories WHERE id = 5').get())
          .toEqual({ show_in_raw_materials: 1 })
        expect(reopened.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
        expect(reopened.pragma('foreign_key_check')).toEqual([])
        expect(reopened.prepare('SELECT COUNT(*) AS c FROM __drizzle_migrations').get()).toEqual({ c: 54 })
      } finally {
        reopened.close()
      }
    } finally {
      if (raw.open) raw.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
