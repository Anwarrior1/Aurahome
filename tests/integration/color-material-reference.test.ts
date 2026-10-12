import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { closeDatabase, getDatabase, getRawConnection } from '@main/db/connection'
import { colorFinishCatalog, materials } from '@main/db/schema/catalog.schema'
import {
  createCategory,
  createMaterial,
  createColor,
  updateColor,
  listColors,
  colorMaterialOptions,
  listMaterialTypeOptions
} from '@main/services/catalog/catalog.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { unitCostFromMajor } from '@shared/money/cost'
import { eq } from 'drizzle-orm'

let env: TestEnv
beforeEach(() => {
  env = setupTestDatabase()
})
afterEach(() => env.cleanup())

function material(name: string, sku: string): number {
  const root = createCategory({ name: `Root ${sku}` }, env.ctx)
  const child = createCategory({ name: `Child ${sku}`, parentId: root }, env.ctx)
  return createMaterial(
    {
      sku,
      name,
      categoryId: child,
      unit: 'لوح',
      currentMarketPriceMicro: unitCostFromMajor(100),
      pricingRule: 'exact'
    },
    env.ctx
  )
}
function color(id: number) {
  return listColors().find((entry) => entry.id === id)!
}

describe('Color material relationship', () => {
  it('persists a master ID, derives its label server-side, preserves an untouched edit and allows change/clear', () => {
    const a = material('MDF 18mm', 'MDF-18')
    const b = material('خشب زان', 'WOOD-B')
    const id = createColor(
      {
        code: '101',
        name: 'أبيض',
        relatedMaterialId: a,
        relatedMaterialType: 'untrusted label',
        notes: 'ملاحظات'
      },
      env.ctx
    )
    expect(color(id)).toMatchObject({
      relatedMaterialId: a,
      relatedMaterialType: 'MDF 18mm',
      notes: 'ملاحظات'
    })
    closeDatabase()
    expect(color(id).relatedMaterialId).toBe(a)
    updateColor(id, { name: 'أبيض جديد' }, env.ctx)
    expect(color(id)).toMatchObject({ relatedMaterialId: a, relatedMaterialType: 'MDF 18mm' })
    updateColor(id, { relatedMaterialId: b }, env.ctx)
    closeDatabase()
    expect(color(id)).toMatchObject({ relatedMaterialId: b, relatedMaterialType: 'خشب زان' })
    updateColor(id, { relatedMaterialId: null }, env.ctx)
    expect(color(id)).toMatchObject({ relatedMaterialId: null, relatedMaterialType: null })
    expect(createColor({ code: '102', name: 'اختياري' }, env.ctx)).toBeGreaterThan(0)
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  })

  it('rejects invented names, invalid IDs, nonexistent materials and newly selected inactive materials', () => {
    const a = material('MDF', 'MDF')
    const id = createColor({ code: '101', name: 'أبيض', relatedMaterialId: a }, env.ctx)
    expect(() =>
      createColor({ code: '102', name: 'غير صالح', relatedMaterialType: 'اسم عشوائي' }, env.ctx)
    ).toThrow(/اختر مادة/)
    expect(() => updateColor(id, { relatedMaterialType: 'اسم عشوائي' }, env.ctx)).toThrow(
      /اختر مادة/
    )
    for (const relatedMaterialId of [0, -1, 1.5, NaN, 999999]) {
      expect(() => updateColor(id, { relatedMaterialId }, env.ctx)).toThrow()
    }
    expect(color(id).relatedMaterialId).toBe(a)
    getDatabase().update(materials).set({ active: false }).where(eq(materials.id, a)).run()
    expect(() =>
      createColor({ code: '103', name: 'غير صالح', relatedMaterialId: a }, env.ctx)
    ).toThrow(/غير مفعّلة/)
    expect(listMaterialTypeOptions()).not.toContainEqual(expect.objectContaining({ id: a }))
    expect(colorMaterialOptions(id)).toContainEqual(
      expect.objectContaining({ id: a, sku: 'MDF', name: 'MDF' })
    )
    updateColor(id, { name: 'تعديل فقط' }, env.ctx)
    expect(color(id).relatedMaterialId).toBe(a)
  })

  it('loads legacy text without guessing and preserves it on unrelated edits until explicitly selected/cleared', () => {
    const a = material('MDF', 'MDF')
    const id = Number(
      getDatabase()
        .insert(colorFinishCatalog)
        .values({ code: 'LEGACY', name: 'قديم', relatedMaterialType: 'نوع قديم غير مطابق' })
        .run().lastInsertRowid
    )
    updateColor(id, { notes: 'ملاحظة جديدة' }, env.ctx)
    expect(color(id)).toMatchObject({
      relatedMaterialId: null,
      relatedMaterialType: 'نوع قديم غير مطابق'
    })
    closeDatabase()
    expect(color(id).relatedMaterialType).toBe('نوع قديم غير مطابق')
    updateColor(id, { relatedMaterialId: a }, env.ctx)
    expect(color(id)).toMatchObject({ relatedMaterialId: a, relatedMaterialType: 'MDF' })
    getDatabase().delete(materials).where(eq(materials.id, a)).run()
    expect(color(id)).toMatchObject({ relatedMaterialId: null, relatedMaterialType: 'MDF' })
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  })

  it('uses only real material master rows, without exposing organizational category nodes', () => {
    material('MDF 18mm', 'MDF-18')
    const root = createCategory({ name: 'جذر تنظيمي فقط' }, env.ctx)
    expect(colorMaterialOptions()).toEqual(listMaterialTypeOptions())
    expect(colorMaterialOptions()).toHaveLength(1)
    expect(colorMaterialOptions().some((entry) => entry.name === 'جذر تنظيمي فقط')).toBe(false)
    // This root has no material in the master, even though category IDs
    // and material IDs occupy separate numeric namespaces.
    expect(
      getDatabase().select().from(materials).where(eq(materials.hierarchyNodeId, root)).all()
    ).toEqual([])
  })
})

describe('Color picker direct IPC validation and RBAC', () => {
  it('lets a color manager use lightweight master options without invoice/inventory grants and rejects invalid saves', async () => {
    const handlers = new Map<
      string,
      (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>
    >()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((
      channel: string,
      handler: never
    ) => {
      handlers.set(channel, handler)
    }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()
    const a = material('MDF 18mm', 'MDF-18')
    const roleId = createRole(
      { name: 'Color manager', permissions: [P.colors.view, P.colors.manage] },
      env.ctx
    )
    createUser(
      { username: 'colors-manager', password: 'secret123', fullName: 'Color manager', roleId },
      env.ctx
    )
    login('colors-manager', 'secret123', 33001)
    const event = { sender: { id: 33001 } } as IpcMainInvokeEvent
    const options = await handlers.get(IPC_CHANNELS.colors.materialOptions)!(event, {})
    expect(options.ok && options.data).toEqual([
      expect.objectContaining({ id: a, name: 'MDF 18mm', sku: 'MDF-18' })
    ])
    for (const payload of [
      { code: '101', name: 'أبيض', relatedMaterialId: 999999 },
      { code: '101', name: 'أبيض', relatedMaterialType: 'not a material' }
    ]) {
      const result = await handlers.get(IPC_CHANNELS.colors.create)!(event, payload)
      expect(result.ok).toBe(false)
    }
    const created = await handlers.get(IPC_CHANNELS.colors.create)!(event, {
      code: '101',
      name: 'أبيض',
      relatedMaterialId: a
    })
    expect(created.ok).toBe(true)
    expect(listColors()[0]!.relatedMaterialId).toBe(a)
    const viewerRole = createRole({ name: 'Color viewer', permissions: [P.colors.view] }, env.ctx)
    createUser(
      { username: 'colors-viewer', password: 'secret123', fullName: 'Viewer', roleId: viewerRole },
      env.ctx
    )
    login('colors-viewer', 'secret123', 33002)
    const denied = await handlers.get(IPC_CHANNELS.colors.materialOptions)!(
      { sender: { id: 33002 } } as IpcMainInvokeEvent,
      {}
    )
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.error.code).toBe('FORBIDDEN')
  })
})
