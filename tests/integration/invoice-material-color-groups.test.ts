import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { closeDatabase, getRawConnection } from '@main/db/connection'
import { createCategory, createMaterial, createColor, updateColor, updateMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer } from '@main/services/parties/parties.service'
import { createQuotation, getQuotation, updateQuotation, createRevision } from '@main/services/sales/quotations.service'
import { createFinalInvoice, getFinalInvoice, updateFinalInvoice, approveFinalInvoice } from '@main/services/sales/final-invoices.service'
import { getOrder } from '@main/services/sales/orders.service'
import { buildPreliminaryInvoice, buildFinalInvoice } from '@main/services/documents/documents.service'
import { renderPreliminaryInvoice, renderFinalInvoice } from '@main/reports/templates/documents.template'
import { unmappedItemColors } from '@shared/documents/item-selections'
import { IPC_CHANNELS } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'
import { moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())
const LINE = { lineKind: 'custom' as const, description: 'مطبخ', specifications: 'ملاحظات التصنيع الأصلية', quantityMicro: quantityFromDisplay(2), unitPriceMinor: moneyFromMajor(1000) }
function seed() {
  const root = createCategory({ name: 'مواد' }, env.ctx)
  const accessoryRoot = createCategory({ name: 'إكسسوارات', isAccessory: true }, env.ctx)
  const material = (sku: string, name: string, categoryId = root) => createMaterial({ sku, name, categoryId, unit: 'قطعة', pricingRule: 'exact' }, env.ctx)
  const contour = material('CONTOUR', 'Contour 18')
  const mdf = material('MDF', 'MDF 16')
  const hdf = material('HDF', 'HDF')
  const red = createColor({ code: '405', name: 'RED', relatedMaterialId: contour }, env.ctx)
  const walnut = createColor({ code: '410', name: 'Walnut', relatedMaterialId: contour }, env.ctx)
  const grey = createColor({ code: 'DEMO-G', name: 'رمادي تجريبي', relatedMaterialId: mdf }, env.ctx)
  const accessory = material('HANDLE', 'مقبض', accessoryRoot)
  const materials = [contour, mdf, hdf]
  const groups = [{ materialId: contour, colorIds: [red, walnut] }, { materialId: mdf, colorIds: [grey] }, { materialId: hdf, colorIds: [] }]
  return { customerId: createCustomer({ name: 'عميل' }, env.ctx), contour, mdf, hdf, red, walnut, grey, accessory, materials, groups }
}
function integrity() {
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
}

describe.each(['preliminary', 'approved'] as const)('%s Material → Colors', kind => {
  const create = kind === 'preliminary' ? createQuotation : createFinalInvoice
  const get = kind === 'preliminary' ? getQuotation : getFinalInvoice
  const update = kind === 'preliminary' ? updateQuotation : updateFinalInvoice
  const dto = (id: number) => kind === 'preliminary' ? buildPreliminaryInvoice(id) : buildFinalInvoice(id)
  const render = (id: number) => kind === 'preliminary' ? renderPreliminaryInvoice(dto(id), { name: 'AURA' }) : renderFinalInvoice(dto(id), { name: 'AURA' })

  it('persists multiple colors per material, a material with no colors, independent items, and grouped PDF wording', () => {
    const s = seed()
    const id = create({ customerId: s.customerId, printVisibility: { accessories: true }, lines: [
      { ...LINE, materialIds: s.materials, materialColors: s.groups, accessoryIds: [s.accessory] },
      { ...LINE, description: 'صنف ثان', materialIds: [s.mdf], materialColors: [{ materialId: s.mdf, colorIds: [s.grey] }], accessoryIds: [] }
    ] }, env.ctx).id
    closeDatabase()
    const lines = get(id).lines
    expect(lines[0]!.selectedMaterials.map(m => [m.materialId, (m.colors ?? []).map(c => c.colorId)])).toEqual([[s.contour, [s.red, s.walnut]], [s.mdf, [s.grey]], [s.hdf, []]])
    expect(lines[1]!.selectedMaterials.map(m => [m.materialId, (m.colors ?? []).map(c => c.colorId)])).toEqual([[s.mdf, [s.grey]]])
    expect(lines[0]!.selectedAccessories).toEqual([{ materialId: s.accessory, name: 'مقبض' }])
    expect(dto(id).lines[0]!.materialGroups).toEqual([{ material: 'Contour 18', colors: '405 — RED، 410 — Walnut' }, { material: 'MDF 16', colors: 'DEMO-G — رمادي تجريبي' }, { material: 'HDF', colors: undefined }])
    const html = render(id)
    expect(html).toContain('المادة: Contour 18</div><div class="spec">اللون/التشطيب: 405 — RED، 410 — Walnut')
    expect(html).toContain('المادة: MDF 16</div><div class="spec">اللون/التشطيب: DEMO-G — رمادي تجريبي')
    expect(html).toContain('المادة: HDF</div></div>')
    expect(html).not.toContain('نوع المادة: Contour 18، MDF 16')
    expect(lines[0]!.lineTotalMinor).toBe(moneyFromMajor(2000))
    integrity()
  })

  it('removes a material and only its colors atomically; old 0030 request shapes cannot transfer colors', () => {
    const s = seed()
    const id = create({ customerId: s.customerId, lines: [{ ...LINE, materialIds: s.materials, materialColors: s.groups, accessoryIds: [s.accessory] }] }, env.ctx).id
    const before = get(id).lines[0]!
    // Omitted new grouped payload exercises 0030 compatibility during material removal.
    update(id, { lines: [{ ...LINE, sourceLineId: before.id, materialIds: [s.mdf], colorIds: [s.red, s.walnut, s.grey], accessoryIds: [s.accessory] }] }, env.ctx)
    closeDatabase()
    const after = get(id).lines[0]!
    expect(after.selectedMaterials).toEqual([{ materialId: s.mdf, name: 'MDF 16', colors: [{ colorId: s.grey, code: 'DEMO-G', name: 'رمادي تجريبي' }] }])
    expect(after.selectedColors).toHaveLength(1)
    expect(after.selectedAccessories).toEqual(before.selectedAccessories)
    expect(after.lineTotalMinor).toBe(before.lineTotalMinor)
    const table = kind === 'preliminary' ? 'quotation_line_colors' : 'final_invoice_line_colors'
    expect(getRawConnection().prepare(`SELECT code_snapshot FROM ${table} WHERE line_id = ?`).all(after.id)).toEqual([{ code_snapshot: 'DEMO-G' }])
    // Explicit removal uses the same persisted update path.
    update(id, { lines: [{ ...LINE, sourceLineId: after.id, materialIds: [], materialColors: [], accessoryIds: [s.accessory] }] }, env.ctx)
    expect(get(id).lines[0]!.selectedColors).toEqual([])
    integrity()
  })

  it('rejects wrong pairs, duplicates and a group not selected on the item, rolling back complete updates', () => {
    const s = seed()
    const id = create({ customerId: s.customerId, lines: [{ ...LINE, materialIds: s.materials, materialColors: s.groups }] }, env.ctx).id
    const before = get(id)
    for (const groups of [
      [{ materialId: s.contour, colorIds: [s.grey] }],
      [{ materialId: s.mdf, colorIds: [s.red] }],
      [{ materialId: s.contour, colorIds: [s.red, s.red] }],
      [{ materialId: s.contour, colorIds: [] }, { materialId: s.contour, colorIds: [] }],
      [{ materialId: 999999, colorIds: [] }],
      [{ materialId: s.contour, colorIds: [999999] }]
    ]) {
      expect(() => update(id, { lines: [{ ...LINE, sourceLineId: before.lines[0]!.id, materialIds: s.materials, materialColors: groups }] }, env.ctx)).toThrow()
      expect(get(id)).toEqual(before)
    }
    expect(() => create({ customerId: s.customerId, lines: [{ ...LINE, materialIds: [s.mdf], materialColors: [{ materialId: s.contour, colorIds: [s.red] }] }] }, env.ctx)).toThrow(/غير مختارة/)
    integrity()
  })

  it('rolls back every item and association after an insertion failure midway', () => {
    const s = seed()
    const id = create({ customerId: s.customerId, lines: [{ ...LINE, materialIds: [s.contour], materialColors: [{ materialId: s.contour, colorIds: [s.red] }] }] }, env.ctx).id
    const before = get(id)
    const table = kind === 'preliminary' ? 'quotation_line_colors' : 'final_invoice_line_colors'
    getRawConnection().exec(`CREATE TRIGGER fail_group_insert BEFORE INSERT ON ${table} WHEN NEW.code_snapshot = '410' BEGIN SELECT RAISE(ABORT, 'forced group failure'); END`)
    expect(() => update(id, { lines: [{ ...LINE, sourceLineId: before.lines[0]!.id, materialIds: s.materials, materialColors: s.groups }] }, env.ctx)).toThrow(/forced group failure/)
    expect(get(id)).toEqual(before)
    integrity()
  })

  it('freezes material names, color codes/names and pair ownership through catalog edits and restart', () => {
    const s = seed()
    const id = create({ customerId: s.customerId, lines: [{ ...LINE, materialIds: s.materials, materialColors: s.groups }] }, env.ctx).id
    if (kind === 'approved') approveFinalInvoice(id, env.ctx)
    const before = dto(id).lines[0]!.materialGroups
    updateColor(s.red, { code: '405-NEW', name: 'RED NEW', relatedMaterialId: s.mdf }, env.ctx)
    updateMaterial(s.contour, { name: 'Contour renamed' }, env.ctx)
    closeDatabase()
    expect(dto(id).lines[0]!.materialGroups).toEqual(before)
    expect(render(id)).toContain('405 — RED')
    expect(render(id)).not.toContain('RED NEW')
    if (kind === 'preliminary') {
      const saved = get(id).lines[0]!
      update(id, { lines: [{ ...LINE, sourceLineId: saved.id, materialIds: s.materials, materialColors: s.groups }] }, env.ctx)
      expect(dto(id).lines[0]!.materialGroups).toEqual(before)
    }
    integrity()
  })

  it('preserves both visibility keys without exposing hidden material names or hidden colors', () => {
    const s = seed()
    for (const [materialType, colorCode] of [[false, true], [true, false], [false, false]]) {
      const id = create({ customerId: s.customerId, printVisibility: { materialType, colorCode }, lines: [{ ...LINE, materialIds: s.materials, materialColors: s.groups }] }, env.ctx).id
      if (kind === 'approved') approveFinalInvoice(id, env.ctx)
      const html = render(id)
      expect(html.includes('Contour 18')).toBe(materialType)
      expect(html.includes('MDF 16')).toBe(materialType)
      expect(html.includes('405 — RED')).toBe(colorCode)
      expect(html.includes('DEMO-G — رمادي تجريبي')).toBe(colorCode)
      if (!materialType) expect(dto(id).lines[0]!.materialGroups?.every(g => g.material === undefined)).toBe(true)
    }
    integrity()
  })

  it('rejects a manipulated pair through authenticated direct IPC, preserving the entire invoice', async () => {
    const s = seed()
    const id = create({ customerId: s.customerId, lines: [{ ...LINE, materialIds: s.materials, materialColors: s.groups }] }, env.ctx).id
    const before = get(id)
    const handlers = new Map<string, (e: IpcMainInvokeEvent, p: unknown) => Promise<IpcResult<unknown>>>()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => handlers.set(channel, handler)) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter(); spy.mockRestore()
    const channel = kind === 'preliminary' ? IPC_CHANNELS.quotations.update : IPC_CHANNELS.finalInvoices.update
    const result = await handlers.get(channel)!({ sender: { id: 1 } } as IpcMainInvokeEvent, { id, lines: [{ ...LINE, sourceLineId: before.lines[0]!.id, materialIds: [s.contour], materialColors: [{ materialId: s.contour, colorIds: [s.grey] }] }] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toMatch(/لا يرتبط/)
    expect(get(id)).toEqual(before)
    integrity()
  })

  it('wraps long grouped names and multiple materials without dropping PDF content', () => {
    const s = seed()
    const longName = Array.from({ length: 720 }, (_, i) => `اسم لون محفوظ ${i + 1}`).join(' ')
    updateColor(s.walnut, { name: longName }, env.ctx)
    const id = create({ customerId: s.customerId, printVisibility: { accessories: true }, lines: [{ ...LINE, materialIds: s.materials, materialColors: s.groups, accessoryIds: [s.accessory] }] }, env.ctx).id
    if (kind === 'approved') approveFinalInvoice(id, env.ctx)
    const html = render(id)
    expect(html).toContain(`410 — ${longName}`)
    expect(html).toContain('المادة: MDF 16')
    mkdirSync(resolve('tmp/pdfs'), { recursive: true })
    writeFileSync(resolve(`tmp/pdfs/${kind}-material-groups.html`), html.replaceAll('app://assets/', `file://${resolve('resources/assets')}/`))
  })
})

it('approval preserves every nested group in both order child records and the frozen snapshot', () => {
  const s = seed()
  const id = createFinalInvoice({ customerId: s.customerId, lines: [{ ...LINE, materialIds: s.materials, materialColors: s.groups }] }, env.ctx).id
  const approved = approveFinalInvoice(id, env.ctx)
  const line = getFinalInvoice(id).lines[0]!
  expect(getOrder(approved.orderId).lines[0]!.selectedMaterials).toEqual(line.selectedMaterials)
  expect(getFinalInvoice(id).snapshot.lines[0]!.selectedMaterials).toEqual(line.selectedMaterials)
  expect(approveFinalInvoice(id, env.ctx).orderId).toBe(approved.orderId)
  closeDatabase(); integrity()
})

it('restores an old flat 0030 frozen snapshot only from exact matching migrated snapshots', () => {
  const s = seed()
  const id = createFinalInvoice({ customerId: s.customerId, lines: [{ ...LINE, materialIds: s.materials, materialColors: s.groups }] }, env.ctx).id
  approveFinalInvoice(id, env.ctx)
  const snapshot = getFinalInvoice(id).snapshot
  snapshot.lines[0]!.selectedMaterials = snapshot.lines[0]!.selectedMaterials!.map(({ materialId, name }) => ({ materialId, name }))
  getRawConnection().prepare('UPDATE final_invoices SET snapshot = ? WHERE id = ?').run(JSON.stringify(snapshot), id)
  expect(getFinalInvoice(id).snapshot.lines[0]!.selectedMaterials![0]!.colors).toHaveLength(2)
  updateColor(s.red, { name: 'New name' }, env.ctx)
  expect(buildFinalInvoice(id).lines[0]!.materialGroups![0]!.colors).toBe('405 — RED، 410 — Walnut')
  snapshot.lines[0]!.selectedMaterials![0]!.name = 'Different historical material snapshot'
  getRawConnection().prepare('UPDATE final_invoices SET snapshot = ? WHERE id = ?').run(JSON.stringify(snapshot), id)
  const document = buildFinalInvoice(id)
  expect(document.lines[0]!.materialGroups![0]!.colors).toBeUndefined()
  expect(document.lines[0]!.unmappedColors).toBe('405 — RED، 410 — Walnut')
  integrity()
})

it('keeps unresolved legacy colors readable and permits explicit safe association without duplicated history', () => {
  const s = seed()
  const id = createQuotation({ customerId: s.customerId, lines: [{ ...LINE, materialIds: [s.contour], materialColors: [{ materialId: s.contour, colorIds: [s.red] }] }] }, env.ctx).id
  getRawConnection().prepare('UPDATE quotation_line_colors SET material_selection_id = NULL WHERE line_id = ?').run(getQuotation(id).lines[0]!.id)
  const old = getQuotation(id).lines[0]!
  expect(unmappedItemColors(old)).toHaveLength(1)
  expect(renderPreliminaryInvoice(buildPreliminaryInvoice(id), { name: 'AURA' })).toContain('ألوان/تشطيبات محفوظة دون ارتباط مؤكد بمادة: 405 — RED')
  updateQuotation(id, { lines: [{ ...LINE, sourceLineId: old.id, materialIds: [s.contour], materialColors: [{ materialId: s.contour, colorIds: [s.red] }], retainedUnmappedColorIds: [s.red] }] }, env.ctx)
  const resolved = getQuotation(id).lines[0]!
  expect(resolved.selectedColors).toHaveLength(1)
  expect(unmappedItemColors(resolved)).toEqual([])
  const revision = createRevision(id, env.ctx)
  expect(getQuotation(revision.id).lines[0]!.selectedMaterials).toEqual(resolved.selectedMaterials)
  integrity()
})
