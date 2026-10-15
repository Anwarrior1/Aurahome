import { describe, expect, it } from 'vitest'
import { colorsForInvoiceMaterial, retainMaterialColorInputs } from '@renderer/components/invoices/InvoiceItemMultiSelect'

const catalog = [
  { id: 1, code: '405', name: 'RED', relatedMaterialId: 20, associatedMaterials: [{ id: 10 }] },
  { id: 2, code: '410', name: 'Walnut', relatedMaterialId: 10, associatedMaterials: [] },
  { id: 3, code: 'DEMO-G', name: 'رمادي تجريبي', relatedMaterialId: null, associatedMaterials: [{ id: 20 }] },
  { id: 4, code: 'LEGACY', name: 'Contour', relatedMaterialId: null, associatedMaterials: [] }
]
describe('material-scoped invoice picker', () => {
  it('offers only colors linked by master material ID, never matching legacy names', () => {
    expect(colorsForInvoiceMaterial(catalog, 10).map(c => c.id)).toEqual([1])
    expect(colorsForInvoiceMaterial(catalog, 20).map(c => c.id)).toEqual([3])
    expect(colorsForInvoiceMaterial(catalog, 30)).toEqual([])
  })
  it('creates arbitrary additional independent groups, retains reorders, and removes owned colors with the material', () => {
    const groups = [{ materialId: 10, colorIds: [1, 2] }, { materialId: 20, colorIds: [3] }]
    expect(retainMaterialColorInputs([10, 20, 30, 40], groups)).toEqual([...groups, { materialId: 30, colorIds: [] }, { materialId: 40, colorIds: [] }])
    expect(retainMaterialColorInputs([20, 10], groups)).toEqual([groups[1], groups[0]])
    expect(retainMaterialColorInputs([20], groups)).toEqual([groups[1]])
    expect(groups[0]!.colorIds).toEqual([1, 2])
  })
})
