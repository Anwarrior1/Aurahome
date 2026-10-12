import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { closeDatabase, getRawConnection } from '@main/db/connection'
import {
  createCategory,
  createMaterial,
  createColor,
  updateColor,
  updateMaterial
} from '@main/services/catalog/catalog.service'
import { createCustomer } from '@main/services/parties/parties.service'
import {
  createQuotation,
  getQuotation,
  updateQuotation,
  createRevision
} from '@main/services/sales/quotations.service'
import {
  createFinalInvoice,
  getFinalInvoice,
  updateFinalInvoice,
  approveFinalInvoice
} from '@main/services/sales/final-invoices.service'
import { getOrder } from '@main/services/sales/orders.service'
import {
  buildPreliminaryInvoice,
  buildFinalInvoice
} from '@main/services/documents/documents.service'
import {
  renderPreliminaryInvoice,
  renderFinalInvoice
} from '@main/reports/templates/documents.template'
import { moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
beforeEach(() => {
  env = setupTestDatabase()
})
afterEach(() => env.cleanup())
const LINE = {
  lineKind: 'custom' as const,
  description: 'مطبخ مخصص',
  specifications: 'المواصفات وملاحظات التصنيع',
  quantityMicro: quantityFromDisplay(2),
  unitPriceMinor: moneyFromMajor(1000)
}
function seed() {
  const category = createCategory({ name: 'مواد' }, env.ctx)
  const accessoryCategory = createCategory({ name: 'إكسسوارات', isAccessory: true }, env.ctx)
  const child = createCategory({ name: 'مفصلات', parentId: accessoryCategory }, env.ctx)
  const material = (sku: string, name: string, categoryId: number) =>
    createMaterial({ sku, name, categoryId, unit: 'قطعة', pricingRule: 'exact' }, env.ctx)
  const materialIds = [material('MDF', 'MDF 18', category), material('CONTOUR', 'Contour 18', category)]
  return {
    customerId: createCustomer({ name: 'عميل' }, env.ctx),
    materials: materialIds,
    accessories: [
      material('HINGE', 'مفصلة مخفية', child),
      material('HANDLE', 'مقبض ألمنيوم', accessoryCategory),
      material('SLIDE', 'سحاب', accessoryCategory)
    ],
    colors: [
      createColor({ code: '405', name: 'رمادي', relatedMaterialId: materialIds[0] }, env.ctx),
      createColor({ code: 'DEMO-G', name: 'رمادي تجريبي', relatedMaterialId: materialIds[1] }, env.ctx)
    ]
  }
}
function integrity() {
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
}

describe.each(['preliminary', 'approved'] as const)('%s multi-value selections', (kind) => {
  const create = kind === 'preliminary' ? createQuotation : createFinalInvoice
  const get = kind === 'preliminary' ? getQuotation : getFinalInvoice
  const update = kind === 'preliminary' ? updateQuotation : updateFinalInvoice
  const render = (id: number) =>
    kind === 'preliminary'
      ? renderPreliminaryInvoice(buildPreliminaryInvoice(id), { name: 'AURA' })
      : renderFinalInvoice(buildFinalInvoice(id), { name: 'AURA' })

  it('saves one or multiple selections independently per item, persists on restart and prints every snapshot', () => {
    const s = seed()
    const id = create(
      {
        customerId: s.customerId,
        printVisibility: { accessories: true },
        lines: [
          { ...LINE, materialIds: s.materials, colorIds: s.colors, accessoryIds: s.accessories },
          {
            ...LINE,
            materialIds: [s.materials[0]!],
            colorIds: [s.colors[0]!],
            accessoryIds: [s.accessories[0]!]
          }
        ]
      },
      env.ctx
    ).id
    closeDatabase()
    const lines = get(id).lines
    expect(lines[0]!.selectedMaterials.map((m) => m.materialId)).toEqual(s.materials)
    expect(lines[0]!.selectedColors).toEqual([
      { colorId: s.colors[0], code: '405', name: 'رمادي' },
      { colorId: s.colors[1], code: 'DEMO-G', name: 'رمادي تجريبي' }
    ])
    expect(lines[0]!.selectedAccessories.map((a) => a.materialId)).toEqual(s.accessories)
    expect(lines[1]!.selectedMaterials).toHaveLength(1)
    expect(lines[1]!.selectedColors).toHaveLength(1)
    expect(lines[1]!.selectedAccessories).toHaveLength(1)
    const html = render(id)
    for (const text of [
      'المادة: MDF 18',
      'المادة: Contour 18',
      '405 — رمادي',
      'DEMO-G — رمادي تجريبي',
      'مفصلة مخفية، مقبض ألمنيوم، سحاب'
    ])
      expect(html).toContain(text)
    integrity()
  })

  it('retains frozen catalog wording after rename, adds/removes selections and follows row identity when reordered', () => {
    const s = seed()
    const id = create(
      {
        customerId: s.customerId,
        lines: [
          {
            ...LINE,
            materialIds: s.materials,
            colorIds: [s.colors[0]!],
            accessoryIds: s.accessories
          },
          {
            ...LINE,
            description: 'صنف ثان',
            materialIds: [s.materials[1]!],
            colorIds: [s.colors[1]!],
            accessoryIds: []
          }
        ]
      },
      env.ctx
    ).id
    updateColor(s.colors[0]!, { code: '405-NEW', name: 'رمادي فاتح' }, env.ctx)
    updateMaterial(s.materials[0]!, { name: 'MDF جديد' }, env.ctx)
    expect(render(id)).toContain('405 — رمادي')
    expect(render(id)).not.toContain('رمادي فاتح')
    const saved = get(id).lines
    update(
      id,
      {
        lines: [
          {
            ...LINE,
            description: 'صنف ثان',
            sourceLineId: saved[1]!.id,
            materialIds: [s.materials[1]!],
            colorIds: [s.colors[1]!],
            accessoryIds: []
          },
          {
            ...LINE,
            sourceLineId: saved[0]!.id,
            materialIds: [s.materials[0]!],
            colorIds: [s.colors[0]!],
            accessoryIds: [s.accessories[0]!]
          }
        ]
      },
      env.ctx
    )
    closeDatabase()
    const changed = get(id).lines
    expect(changed[1]!.selectedMaterials).toMatchObject([{ materialId: s.materials[0], name: 'MDF 18', colors: [{ colorId: s.colors[0] }] }])
    expect(changed[1]!.selectedColors).toEqual([
      { colorId: s.colors[0], code: '405', name: 'رمادي' }
    ])
    expect(changed[0]!.selectedColors).toEqual([
      { colorId: s.colors[1], code: 'DEMO-G', name: 'رمادي تجريبي' }
    ])
    expect(changed[1]!.lineTotalMinor).toBe(moneyFromMajor(2000))
    // A stale dialog cannot transfer or refresh another row's snapshots.
    expect(() =>
      update(
        id,
        { lines: [{ ...LINE, sourceLineId: saved[0]!.id, materialIds: s.materials }] },
        env.ctx
      )
    ).toThrow(/الصنف الأصلي/)
    integrity()
  })

  it('rejects invalid, duplicate, inactive and wrong-source ids atomically, with database uniqueness too', () => {
    const s = seed()
    const id = create(
      {
        customerId: s.customerId,
        lines: [
          { ...LINE, materialIds: s.materials, colorIds: s.colors, accessoryIds: s.accessories }
        ]
      },
      env.ctx
    ).id
    const before = get(id)
    const wrongRoot = 900000
    getRawConnection()
      .prepare('INSERT INTO material_categories (id, name) VALUES (?, ?)')
      .run(wrongRoot, 'جذر تنظيمي')
    const bad = [
      { materialIds: [999999] },
      { colorIds: [999999] },
      { accessoryIds: [999999] },
      { materialIds: [s.materials[0]!, s.materials[0]!] },
      { colorIds: [s.colors[0]!, s.colors[0]!] },
      { accessoryIds: [s.accessories[0]!, s.accessories[0]!] },
      { accessoryIds: [s.materials[0]!] },
      { materialIds: [wrongRoot] },
      { colorIds: [1.5] },
      { materialTypeMaterialId: 0 },
      { accessoryMaterialId: -1 }
    ]
    for (const patch of bad) {
      expect(() =>
        update(id, { lines: [{ ...LINE, sourceLineId: before.lines[0]!.id, ...patch }] }, env.ctx)
      ).toThrow()
      expect(get(id)).toEqual(before)
    }
    updateMaterial(s.materials[0]!, { active: false }, env.ctx)
    updateColor(s.colors[0]!, { active: false }, env.ctx)
    expect(() =>
      create(
        { customerId: s.customerId, lines: [{ ...LINE, materialIds: [s.materials[0]!] }] },
        env.ctx
      )
    ).toThrow()
    expect(() =>
      create({ customerId: s.customerId, lines: [{ ...LINE, colorIds: [s.colors[0]!] }] }, env.ctx)
    ).toThrow()
    // Keeping archived selections is allowed; changing an unrelated field does not erase history.
    update(
      id,
      {
        lines: [
          {
            ...LINE,
            sourceLineId: before.lines[0]!.id,
            materialIds: s.materials,
            colorIds: s.colors,
            accessoryIds: s.accessories
          }
        ]
      },
      env.ctx
    )
    const owner = kind === 'preliminary' ? 'quotation_line' : 'final_invoice_line'
    const lineId = get(id).lines[0]!.id
    expect(() =>
      getRawConnection()
        .prepare(
          `INSERT INTO ${owner}_materials (line_id, material_id, position, name_snapshot) VALUES (?, ?, 9, 'duplicate')`
        )
        .run(lineId, s.materials[0]!)
    ).toThrow(/UNIQUE/)
    integrity()
  })

  it('hides complete sets using the visibility keys and preserves the stored selections', () => {
    const s = seed()
    const id = create(
      {
        customerId: s.customerId,
        printVisibility: { materialType: false, colorCode: false, accessories: false },
        lines: [
          { ...LINE, materialIds: s.materials, colorIds: s.colors, accessoryIds: s.accessories }
        ]
      },
      env.ctx
    ).id
    if (kind === 'approved') approveFinalInvoice(id, env.ctx)
    const html = render(id)
    for (const text of [
      'نوع المادة:',
      'كود اللون/التشطيب:',
      'الإكسسوارات:',
      '405 — رمادي',
      'MDF 18'
    ])
      expect(html).not.toContain(text)
    expect(get(id).lines[0]!.selectedColors).toHaveLength(2)
    integrity()
  })

  it('rolls back parent rows and every relation if a linked insert fails midway', () => {
    const s = seed()
    const id = create(
      {
        customerId: s.customerId,
        lines: [
          { ...LINE, materialIds: [s.materials[0]!], colorIds: [s.colors[0]!], accessoryIds: [] }
        ]
      },
      env.ctx
    ).id
    const before = get(id)
    const table = kind === 'preliminary' ? 'quotation_line_colors' : 'final_invoice_line_colors'
    getRawConnection().exec(
      `CREATE TRIGGER fail_color_insert BEFORE INSERT ON ${table} WHEN NEW.code_snapshot = 'DEMO-G' BEGIN SELECT RAISE(ABORT, 'forced linked insert failure'); END`
    )
    expect(() =>
      update(
        id,
        {
          lines: [
            {
              ...LINE,
              sourceLineId: before.lines[0]!.id,
              materialIds: s.materials,
              colorIds: s.colors,
              accessoryIds: s.accessories
            }
          ]
        },
        env.ctx
      )
    ).toThrow(/forced linked insert failure/)
    expect(get(id)).toEqual(before)
    integrity()
  })

  it('loads selection sets for many items with three batched link queries', () => {
    const s = seed()
    const id = create(
      {
        customerId: s.customerId,
        lines: Array.from({ length: 25 }, () => ({
          ...LINE,
          materialIds: s.materials,
          colorIds: s.colors,
          accessoryIds: s.accessories
        }))
      },
      env.ctx
    ).id
    const prepare = vi.spyOn(getRawConnection(), 'prepare')
    try {
      expect(get(id).lines).toHaveLength(25)
      const childQueries = prepare.mock.calls.filter(([sql]) =>
        /FROM (quotation_line|final_invoice_line)_(materials|colors|accessories) WHERE/.test(sql)
      )
      expect(childQueries).toHaveLength(3)
    } finally {
      prepare.mockRestore()
    }
  })

  it('prints long multi-value Arabic with wrapping and page expansion', () => {
    const s = seed()
    const longName = Array.from({ length: 100 }, (_, i) => `تشطيب عربي محفوظ ${i + 1}`).join(' ')
    const color = createColor({ code: 'LONG', name: longName, relatedMaterialId: s.materials[0] }, env.ctx)
    const id = create(
      {
        customerId: s.customerId,
        printVisibility: { accessories: true },
        lines: [
          {
            ...LINE,
            materialIds: s.materials,
            colorIds: [...s.colors, color],
            accessoryIds: s.accessories
          }
        ]
      },
      env.ctx
    ).id
    if (kind === 'approved') approveFinalInvoice(id, env.ctx)
    const html = render(id)
    expect(html).toContain(`LONG — ${longName}`)
    mkdirSync(resolve('tmp/pdfs'), { recursive: true })
    writeFileSync(
      resolve(`tmp/pdfs/${kind}-multi-selections.html`),
      html.replaceAll('app://assets/', `file://${resolve('resources/assets')}/`)
    )
  })
})

it('approval copies every selected reference and snapshot to the order and freezes the invoice', () => {
  const s = seed()
  const id = createFinalInvoice(
    {
      customerId: s.customerId,
      printVisibility: { accessories: true },
      lines: [
        { ...LINE, materialIds: s.materials, colorIds: s.colors, accessoryIds: s.accessories }
      ]
    },
    env.ctx
  ).id
  const result = approveFinalInvoice(id, env.ctx)
  const orderLine = getOrder(result.orderId).lines[0]!
  expect(orderLine.selectedMaterials.map((m) => m.materialId)).toEqual(s.materials)
  expect(orderLine.selectedColors.map((c) => c.colorId)).toEqual(s.colors)
  expect(orderLine.selectedAccessories.map((a) => a.materialId)).toEqual(s.accessories)
  updateColor(s.colors[0]!, { code: 'NEW', name: 'اسم جديد' }, env.ctx)
  closeDatabase()
  expect(getFinalInvoice(id).snapshot.lines[0]!.selectedColors).toEqual(orderLine.selectedColors)
  expect(renderFinalInvoice(buildFinalInvoice(id), { name: 'AURA' })).toContain('405 — رمادي')
  expect(approveFinalInvoice(id, env.ctx).orderId).toBe(result.orderId)
  integrity()
})

it('quotation revisions copy complete historical selections without resnapshotting live catalog values', () => {
  const s = seed()
  const id = createQuotation(
    {
      customerId: s.customerId,
      lines: [
        { ...LINE, materialIds: s.materials, colorIds: s.colors, accessoryIds: s.accessories }
      ]
    },
    env.ctx
  ).id
  updateColor(s.colors[0]!, { code: 'NEW', name: 'اسم جديد' }, env.ctx)
  const revision = createRevision(id, env.ctx)
  const old = getQuotation(id).lines[0]!
  const copied = getQuotation(revision.id).lines[0]!
  expect(copied.selectedMaterials).toEqual(old.selectedMaterials)
  expect(copied.selectedColors).toEqual(old.selectedColors)
  expect(copied.selectedAccessories).toEqual(old.selectedAccessories)
  integrity()
})
