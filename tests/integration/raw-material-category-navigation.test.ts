import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import {
  categoryTree, createCategory, createMaterial, getMaterial, listMaterials, updateCategory
} from '@main/services/catalog/catalog.service'

const shell = vi.hoisted(() => ({ query: (_group: string, _method: string, _payload?: unknown): unknown => undefined }))
vi.mock('@renderer/state/session.store', () => ({ useSession: () => ({ can: () => true }) }))
vi.mock('@renderer/lib/toast', () => ({ useToast: () => ({ show: () => undefined }) }))
vi.mock('@renderer/lib/useQuery', () => ({ useQuery: (group: string, method: string, payload?: unknown) => ({
  data: shell.query(group, method, payload), loading: false, reload: async () => undefined
}) }))
import { MaterialsPage } from '@renderer/pages/materials/MaterialsPage'

let env: TestEnv
beforeEach(() => {
  env = setupTestDatabase()
  shell.query = (group, method, payload) => {
    if (group === 'categories' && method === 'tree') return categoryTree()
    if (group === 'materials' && method === 'list') return listMaterials(payload as { activeOnly?: boolean })
    if (group === 'inventory' && method === 'stock') return []
    return undefined
  }
})
afterEach(() => env.cleanup())

function page(): string {
  return renderToStaticMarkup(
    React.createElement(MemoryRouter, null, React.createElement(MaterialsPage))
  )
}

function navigation(): string {
  return page().match(/<select[^>]*>(.*?)<\/select>/s)?.[1] ?? ''
}
const details = (sku: string) => ({ sku, unit: 'قطعة', currentMarketPriceMicro: 0, pricingRule: 'exact' as const })

describe('Raw Materials category navigation from migrated SQLite', () => {
  it('shows moop only while enabled, with or without children, and refreshes on requery', () => {
    const moop = createCategory({ name: 'moop', showInRawMaterials: false }, env.ctx)
    expect(navigation()).not.toContain('moop')
    updateCategory(moop, { showInRawMaterials: true, materialDetails: details('MOOP') }, env.ctx)
    expect(page()).toContain('MOOP')
    expect(navigation()).toContain('moop')
    createCategory({ name: 'Child', parentId: moop, showInRawMaterials: false }, env.ctx)
    expect(navigation()).toContain('moop')
    updateCategory(moop, { showInRawMaterials: false }, env.ctx)
    expect(navigation()).not.toContain('moop')
    expect(page()).not.toContain('MOOP')
  })

  it('uses individual flags at every depth and retains disabled assignments', () => {
    const root = createCategory({ name: 'Wood', showInRawMaterials: true, materialDetails: details('WOOD-CAT') }, env.ctx)
    const second = createCategory({ name: 'MDF', parentId: root, showInRawMaterials: true, materialDetails: details('MDF-CAT') }, env.ctx)
    const third = createCategory({ name: '18', parentId: second, showInRawMaterials: true, materialDetails: details('18-CAT') }, env.ctx)
    const fourth = createCategory({ name: 'Raw', parentId: third, showInRawMaterials: true, materialDetails: details('RAW-CAT') }, env.ctx)
    const unused = createCategory({ name: 'Unused', parentId: third, showInRawMaterials: false }, env.ctx)
    const materialId = createMaterial({ sku: 'RAW-18', name: 'Board', categoryId: fourth, unit: 'لوح', pricingRule: 'exact' }, env.ctx)
    for (const name of ['Wood', 'MDF', '18', 'Raw']) expect(navigation()).toContain(name)
    expect(navigation()).not.toContain('Unused')
    updateCategory(second, { showInRawMaterials: false }, env.ctx)
    updateCategory(fourth, { showInRawMaterials: false }, env.ctx)
    expect(navigation()).not.toContain('MDF')
    expect(navigation()).not.toContain('Raw')
    expect(navigation()).toContain('Wood')
    expect(navigation()).toContain('18')
    expect(getMaterial(materialId).categoryId).toBe(fourth)
    expect(listMaterials({ categoryId: root }).map((row) => row.id)).toContain(materialId)
    expect(listMaterials({}).map((row) => row.id)).toContain(materialId)
    expect(categoryTree().find((row) => row.id === root)?.children[0]?.children[0]?.children.map((row) => row.id))
      .toEqual([fourth, unused])
  })
})
