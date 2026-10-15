import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { readdirSync } from 'node:fs'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { closeDatabase, getRawConnection, setDatabasePath } from '@main/db/connection'
import { registerIpcRouter } from '@main/ipc/router'
import { IPC_CHANNELS } from '@shared/constants/channels'
import {
  categoryTree, createCategory, createMaterial, getMaterial, listCategories,
  listMaterials, updateCategory, updateMaterial
} from '@main/services/catalog/catalog.service'
import {
  assignmentCategoryOptions, flattenCategoryOptions
} from '@renderer/pages/materials/MaterialFormModal'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function addMaterial(categoryId: number, sku: string): number {
  return createMaterial({ sku, name: sku, categoryId, unit: 'لوح', pricingRule: 'exact' }, env.ctx)
}
const details = (sku: string) => ({ sku, unit: 'لوح', currentMarketPriceMicro: 0, pricingRule: 'exact' as const })

describe('explicit Raw Materials category visibility', () => {
  it('selects enabled second and fourth levels, including a parent with children, regardless of depth', () => {
    const root = createCategory({ name: 'Wood', showInRawMaterials: false }, env.ctx)
    const second = createCategory({ name: 'MDF', parentId: root, showInRawMaterials: true, materialDetails: details('MDF-CAT') }, env.ctx)
    const third = createCategory({ name: '18', parentId: second, showInRawMaterials: false }, env.ctx)
    const fourth = createCategory({ name: 'Raw', parentId: third, showInRawMaterials: true, materialDetails: details('RAW-CAT') }, env.ctx)
    const disabledFourth = createCategory({ name: 'Colored', parentId: third, showInRawMaterials: false }, env.ctx)
    const options = assignmentCategoryOptions(flattenCategoryOptions(categoryTree()))
    expect(options.map((option) => option.id)).toEqual([second, fourth])
    expect(addMaterial(second, 'SECOND')).toBeGreaterThan(0)
    expect(addMaterial(fourth, 'FOURTH')).toBeGreaterThan(0)
    expect(() => addMaterial(root, 'ROOT')).toThrow(/لا يظهر في مواد الخام/)
    expect(() => addMaterial(third, 'THIRD')).toThrow(/لا يظهر في مواد الخام/)
    expect(() => addMaterial(disabledFourth, 'DISABLED')).toThrow(/لا يظهر في مواد الخام/)
  })

  it('keeps disabled current assignments visible, editable, searchable and unchanged', () => {
    const root = createCategory({ name: 'Hinges' }, env.ctx)
    const black = createCategory({ name: 'Black', parentId: root }, env.ctx)
    const red = createCategory({ name: 'Red', parentId: root }, env.ctx)
    const id = addMaterial(black, 'HINGE-BLACK')
    updateCategory(black, { showInRawMaterials: false }, env.ctx)

    const options = flattenCategoryOptions(categoryTree())
    expect(assignmentCategoryOptions(options).map((option) => option.id)).not.toContain(black)
    expect(assignmentCategoryOptions(options, black)).toContainEqual(expect.objectContaining({
      id: black, label: expect.stringContaining('غير متاح للتعيينات الجديدة')
    }))
    expect(() => addMaterial(black, 'NEW-BLACK')).toThrow(/لا يظهر في مواد الخام/)
    expect(() => updateMaterial(id, { categoryId: red }, env.ctx)).not.toThrow()
    expect(() => updateMaterial(id, { categoryId: black }, env.ctx)).toThrow(/لا يظهر في مواد الخام/)
    updateMaterial(id, { categoryId: red }, env.ctx)
    updateCategory(black, { showInRawMaterials: true, materialDetails: details('BLACK-CAT') }, env.ctx)
    updateMaterial(id, { categoryId: black }, env.ctx)
    updateCategory(black, { showInRawMaterials: false }, env.ctx)
    // Disabling does not make the existing value invalid for ordinary edits.
    updateMaterial(id, { categoryId: black, name: 'Existing hinge' }, env.ctx)
    expect(getMaterial(id)).toMatchObject({ categoryId: black, name: 'Existing hinge' })
    expect(listMaterials({ categoryId: root }).map((row) => row.id)).toContain(id)
    expect(listMaterials({ search: 'Black' }).map((row) => row.id)).toContain(id)
  })

  it('saves category create/edit flags and retains them after reopening SQLite', () => {
    const root = createCategory({ name: 'Root', showInRawMaterials: false }, env.ctx)
    const child = createCategory({ name: 'Child', parentId: root, showInRawMaterials: true, materialDetails: details('CHILD-CAT') }, env.ctx)
    expect(listCategories().find((row) => row.id === root)?.showInRawMaterials).toBe(false)
    updateCategory(root, { showInRawMaterials: true, materialDetails: details('ROOT-CAT') }, env.ctx)
    updateCategory(child, { showInRawMaterials: false }, env.ctx)
    const dbPath = join(env.dir, readdirSync(env.dir).find((name) => name.endsWith('.db'))!)
    closeDatabase()
    setDatabasePath(dbPath)
    expect(listCategories()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: root, showInRawMaterials: true }),
      expect.objectContaining({ id: child, showInRawMaterials: false })
    ]))
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  })

  it('accepts the setting through category create and edit IPC and reloads it in the tree', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>>()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => {
      handlers.set(channel, handler)
    }) as never)
    registerIpcRouter()
    spy.mockRestore()
    const event = { sender: { id: 1 } } as IpcMainInvokeEvent
    const invoke = (channel: string, payload?: unknown) => handlers.get(channel)!(event, payload)
    const created = await invoke(IPC_CHANNELS.categories.create, {
      name: 'IPC category', showInRawMaterials: false
    }) as { ok: boolean; data: { id: number } }
    expect(created).toMatchObject({ ok: true, data: { id: expect.any(Number) } })
    expect(await invoke(IPC_CHANNELS.categories.update, {
      id: created.data.id, showInRawMaterials: true, materialDetails: details('IPC-CAT')
    })).toMatchObject({ ok: true })
    expect(await invoke(IPC_CHANNELS.categories.tree)).toMatchObject({
      ok: true,
      data: [expect.objectContaining({ id: created.data.id, showInRawMaterials: true })]
    })
  })
})
