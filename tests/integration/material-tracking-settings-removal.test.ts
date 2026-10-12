import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { IpcMainInvokeEvent } from 'electron'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import {
  createCategory,
  createChildMaterial,
  createColor,
  getMaterial,
  updateMaterial
} from '@main/services/catalog/catalog.service'
import { recordRemainder } from '@main/services/inventory/inventory.service'
import { registerIpcRouter } from '@main/ipc/router'
import { IPC_CHANNELS } from '@shared/constants/channels'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function materialType(): number {
  const main = createCategory({ name: 'ألواح' }, env.ctx)
  const family = createCategory({ name: 'MDF' , parentId: main }, env.ctx)
  return createCategory({ name: '18 مم', parentId: family }, env.ctx)
}

describe('obsolete Material Tracking Settings removal', () => {
  it('removes the section and all three settings from renderer state and payloads', () => {
    const form = readFileSync('src/renderer/pages/materials/MaterialFormModal.tsx', 'utf8')
    const page = readFileSync('src/renderer/pages/materials/MaterialsPage.tsx', 'utf8')
    const router = readFileSync('src/main/ipc/router.ts', 'utf8')
    for (const obsolete of [
      'إعدادات التتبع',
      'يسمح ببواقٍ قابلة لإعادة الاستخدام بدل اعتبارها هالكاً',
      'تتبّع الدفعات (Batch/Lot)',
      'يدعم اختيار لون/تشطيب من كتالوج الألوان',
      'allowsRemainder',
      'trackRemainderPieces',
      'trackBatches',
      'supportsColor'
    ]) expect(form).not.toContain(obsolete)
    expect(page).not.toContain('supportsColor')
    expect(router).not.toContain('trackBatches: z.boolean()')
    expect(router).not.toContain('supportsColor: z.boolean()')
  })

  it('leaves legacy columns in place but excludes them from active reads and writes', () => {
    const typeId = materialType()
    const created = createChildMaterial({
      parentId: typeId,
      clientRequestId: 'legacy-columns-not-active',
      leafType: 'raw',
      colorId: null,
      sku: 'RAW-18',
      name: 'خام',
      unit: 'لوح',
      currentMarketPriceMicro: 0,
      pricingRule: 'exact'
    }, env.ctx)
    const columns = (getRawConnection().pragma('table_info(materials)') as Array<{ name: string }>)
      .map((column) => column.name)
    expect(columns).toEqual(expect.arrayContaining([
      'allows_remainder', 'track_remainder_pieces', 'track_batches', 'supports_color'
    ]))
    expect(getMaterial(created.materialId)).not.toHaveProperty('track_batches')
    expect(getMaterial(created.materialId)).not.toHaveProperty('trackBatches')

    getRawConnection().prepare(`
      UPDATE materials
      SET allows_remainder = 0, track_remainder_pieces = 0,
          track_batches = 1, supports_color = 1
      WHERE id = ?
    `).run(created.materialId)
    updateMaterial(created.materialId, { notes: 'تعديل عادي' }, env.ctx)
    expect(getRawConnection().prepare(`
      SELECT allows_remainder, track_remainder_pieces, track_batches, supports_color
      FROM materials WHERE id = ?
    `).get(created.materialId)).toEqual({
      allows_remainder: 0,
      track_remainder_pieces: 0,
      track_batches: 1,
      supports_color: 1
    })

    recordRemainder({ materialId: created.materialId, sizeMicro: 500_000, ctx: env.ctx })
    expect((getRawConnection().prepare('SELECT COUNT(*) AS c FROM material_remainders').get() as { c: number }).c)
      .toBe(1)
  })

  it('preserves Color Catalog and authoritative colored material leaves', () => {
    const typeId = materialType()
    const colorId = createColor({ code: 'C-01', name: 'أبيض مطفي' }, env.ctx)
    const created = createChildMaterial({
      parentId: typeId,
      clientRequestId: 'colored-leaf-still-supported',
      leafType: 'colored',
      colorId,
      sku: 'MDF-C-01',
      name: 'ignored',
      unit: 'لوح',
      currentMarketPriceMicro: 0,
      pricingRule: 'exact'
    }, env.ctx)

    expect(getMaterial(created.materialId)).toMatchObject({
      colorId,
      name: 'C-01 — أبيض مطفي'
    })
    expect((getRawConnection().prepare('SELECT COUNT(*) AS c FROM color_finish_catalog').get() as { c: number }).c)
      .toBe(1)
  })

  it('strips obsolete direct-IPC fields instead of persisting them', async () => {
    const typeId = materialType()
    const handlers = new Map<string, (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>>()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => {
      handlers.set(channel, handler)
    }) as never)
    registerIpcRouter()
    spy.mockRestore()

    const result = await handlers.get(IPC_CHANNELS.categories.createChildMaterial)!(
      { sender: { id: 1 } } as unknown as IpcMainInvokeEvent,
      {
        parentId: typeId,
        clientRequestId: 'obsolete-ipc-fields-stripped',
        leafType: 'raw',
        colorId: null,
        sku: 'IPC-RAW',
        name: 'خام IPC',
        unit: 'لوح',
        currentMarketPriceMicro: 0,
        pricingRule: 'exact',
        trackBatches: true,
        supportsColor: true
      }
    ) as { ok: boolean; data?: { materialId: number } }
    expect(result.ok).toBe(true)
    const row = getRawConnection().prepare(
      'SELECT track_batches, supports_color FROM materials WHERE id = ?'
    ).get(result.data!.materialId)
    expect(row).toEqual({ track_batches: 0, supports_color: 0 })
  })
})

