import { unmappedItemColors } from '@shared/documents/item-selections'
import { getRawConnection } from '../../db/connection'
import { AppError } from '../../utils/errors'
import type {
  ItemSelections,
  ItemSelectionInput,
  MaterialSelection,
  ColorSelection,
  ItemMaterialSelection
} from '@shared/documents/item-selections'

export type ItemOwner = 'quotation' | 'finalInvoice' | 'order'
const prefixes: Record<ItemOwner, string> = {
  quotation: 'quotation_line',
  finalInvoice: 'final_invoice_line',
  order: 'order_line'
}
interface LegacyItem {
  id: number
  materialTypeMaterialId: number | null
  materialType: string | null
  accessoryMaterialId: number | null
  accessories: string | null
  colorCode: string | null
}
type SelectionLineInput = ItemSelectionInput & Partial<Omit<LegacyItem, 'id'>>
const empty = (): ItemSelections => ({
  selectedMaterials: [],
  selectedColors: [],
  selectedAccessories: []
})
function invalid(message: string): never {
  throw new AppError('VALIDATION_ERROR', message)
}

/** Three indexed, batched reads for an entire document, never per item. */
export function loadItemSelections<T extends LegacyItem>(
  owner: ItemOwner,
  lines: T[]
): Array<T & ItemSelections> {
  if (!lines.length) return []
  const db = getRawConnection()
  const placeholders = lines.map(() => '?').join(',')
  const ids = lines.map((l) => l.id)
  const selections = new Map(ids.map((id) => [id, empty()]))
  const materialSelections = new Map<number, ItemMaterialSelection>()
  for (const kind of ['materials', 'accessories'] as const) {
    const rows = db
      .prepare(
        `SELECT id, line_id, material_id, name_snapshot FROM ${prefixes[owner]}_${kind} WHERE line_id IN (${placeholders}) ORDER BY line_id, position`
      )
      .all(...ids) as Array<{ id: number; line_id: number; material_id: number | null; name_snapshot: string }>
    for (const r of rows) {
      const values = selections.get(r.line_id)!
      const selection: ItemMaterialSelection = { materialId: r.material_id, name: r.name_snapshot }
      if (kind === 'materials') { selection.colors = []; materialSelections.set(r.id, selection) }
      values[kind === 'materials' ? 'selectedMaterials' : 'selectedAccessories'].push(selection)
    }
  }
  const colors = db
    .prepare(
      `SELECT line_id, material_selection_id, color_id, code_snapshot, name_snapshot FROM ${prefixes[owner]}_colors WHERE line_id IN (${placeholders}) ORDER BY line_id, position`
    )
    .all(...ids) as Array<{
    line_id: number
    material_selection_id: number | null
    color_id: number | null
    code_snapshot: string
    name_snapshot: string | null
  }>
  for (const r of colors) {
    const color = { colorId: r.color_id, code: r.code_snapshot, name: r.name_snapshot }
    selections.get(r.line_id)!.selectedColors.push(color)
    if (r.material_selection_id !== null) materialSelections.get(r.material_selection_id)!.colors!.push(color)
  }
  return lines.map((line) => ({ ...line, ...selections.get(line.id)! }))
}

function checkedIds(ids: number[]): number[] {
  if (ids.length > 500 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0))
    invalid('معرّف اختيار غير صالح')
  if (new Set(ids).size !== ids.length) invalid('لا يمكن تكرار الاختيار في الصنف نفسه')
  return ids
}

/** Validate all ids before replacing any item rows; retain only server-read snapshots. */
export function prepareItemSelections(
  inputs: SelectionLineInput[],
  originals: Array<LegacyItem & ItemSelections> = []
): ItemSelections[] {
  const originalMap = new Map(originals.map((l) => [l.id, l]))
  const sourceIds = inputs.flatMap((l) => (l.sourceLineId === undefined ? [] : [l.sourceLineId]))
  checkedIds(sourceIds)
  const originalFor = (
    input: SelectionLineInput,
    index: number
  ): (LegacyItem & ItemSelections) | undefined => {
    if (input.sourceLineId !== undefined) {
      const original = originalMap.get(input.sourceLineId)
      if (!original) invalid('الصنف الأصلي لا ينتمي لهذه الفاتورة أو لم يعد موجوداً')
      return original
    }
    // Compatibility for existing clients that submit the original ordered rows.
    return originals[index]
  }
  const materialIds = new Set<number>()
  const colorIds = new Set<number>()
  for (const input of inputs) {
    for (const id of checkedIds(
      input.materialIds ??
        (input.materialTypeMaterialId != null ? [input.materialTypeMaterialId] : [])
    ))
      materialIds.add(id)
    for (const id of checkedIds(
      input.accessoryIds ?? (input.accessoryMaterialId != null ? [input.accessoryMaterialId] : [])
    ))
      materialIds.add(id)
    const groups = input.materialColors ?? []
    checkedIds(groups.map(g => g.materialId))
    for (const id of checkedIds(groups.flatMap(g => g.colorIds))) colorIds.add(id)
    for (const group of groups) materialIds.add(group.materialId)
    for (const id of checkedIds(input.colorIds ?? [])) colorIds.add(id)
  }
  const db = getRawConnection()
  const materials = new Map<
    number,
    { id: number; name: string; active: number; accessory: number }
  >()
  if (materialIds.size) {
    const ids = [...materialIds]
    const rows = db
      .prepare(
        `WITH RECURSIVE ancestors(material_id, category_id) AS (
      SELECT id, category_id FROM materials WHERE id IN (${ids.map(() => '?').join(',')})
      UNION SELECT a.material_id, c.parent_id FROM ancestors a JOIN material_categories c ON c.id = a.category_id WHERE c.parent_id IS NOT NULL
    ) SELECT m.id, m.name, m.active, EXISTS(SELECT 1 FROM ancestors a JOIN material_categories c ON c.id = a.category_id WHERE a.material_id = m.id AND c.is_accessory = 1 AND c.active = 1) AS accessory FROM materials m WHERE m.id IN (${ids.map(() => '?').join(',')})`
      )
      .all(...ids, ...ids) as Array<{ id: number; name: string; active: number; accessory: number }>
    for (const row of rows) materials.set(row.id, row)
  }
  const colors = new Map<number, { id: number; code: string; name: string; active: number; related_material_id: number | null }>()
  if (colorIds.size) {
    const ids = [...colorIds]
    const rows = db
      .prepare(
        `SELECT id, code, name, active, related_material_id FROM color_finish_catalog WHERE id IN (${ids.map(() => '?').join(',')})`
      )
      .all(...ids) as Array<{ id: number; code: string; name: string; active: number; related_material_id: number | null }>
    for (const row of rows) colors.set(row.id, row)
  }
  return inputs.map((input, index) => {
    const original = originalFor(input, index)
    function materialSet(
      ids: number[] | undefined,
      singleId: number | null | undefined,
      text: string | null | undefined,
      saved: MaterialSelection[],
      discard: boolean | undefined,
      accessory: boolean
    ): MaterialSelection[] {
      if (ids === undefined && singleId === undefined && text === undefined) return saved
      if (ids === undefined && saved.length && singleId === saved[0]?.materialId) return saved
      const selected = ids ?? (singleId != null ? [singleId] : [])
      const result = selected.map((id) => {
        const previous = saved.find((s) => s.materialId === id)
        const material = materials.get(id)
        if (!material)
          invalid(accessory ? 'الإكسسوار المحدد غير موجود' : 'المادة المحددة غير موجودة')
        if (
          ids !== undefined &&
          !previous &&
          (!material.active || (accessory && !material.accessory))
        )
          invalid('المادة المحددة ليست مادة خام قابلة للاختيار من هذا المصدر')
        return previous ?? { materialId: id, name: material.name }
      })
      if (ids === undefined && !singleId && text)
        result.push(
          saved.find((s) => s.materialId === null && s.name === text) ?? {
            materialId: null,
            name: text
          }
        )
      if (ids !== undefined && !discard) result.push(...saved.filter((s) => s.materialId === null))
      return result
    }
    const selectedMaterials: ItemMaterialSelection[] = materialSet(
      input.materialIds, input.materialTypeMaterialId, input.materialType,
      original?.selectedMaterials ?? [], input.discardLegacyMaterials, false
    ).map(m => ({ ...m, colors: [] }))
    const savedColors = original?.selectedColors ?? []
    const savedUnmapped = original ? unmappedItemColors(original) : []
    const retainedUnmapped = input.retainedUnmappedColorIds
    if (retainedUnmapped !== undefined) {
      checkedIds(retainedUnmapped)
      if (retainedUnmapped.some(id => !savedUnmapped.some(c => c.colorId === id))) invalid('لا يمكن إضافة لون دون ارتباط مؤكد بمادة')
    }
    function keepUnmapped(color: ColorSelection): boolean {
      return color.colorId === null ? !input.discardLegacyColors : retainedUnmapped === undefined || retainedUnmapped.includes(color.colorId)
    }
    let unassigned: ColorSelection[] = []
    if (input.materialColors !== undefined) {
      for (const group of input.materialColors) {
        const material = selectedMaterials.find(m => m.materialId === group.materialId)
        if (!material) invalid('اللون مرتبط بمادة غير مختارة في هذا الصنف')
        const previousMaterial = original?.selectedMaterials.find(m => m.materialId === group.materialId)
        material.colors = group.colorIds.map(id => {
          const color = colors.get(id)
          if (!color) invalid('اللون المحدد غير موجود في كتالوج الألوان')
          const previousPair = previousMaterial?.colors?.find(c => c.colorId === id)
          // An unchanged historical pair remains frozen even if the catalog is later reassigned.
          if (!previousPair && color.related_material_id !== group.materialId) invalid('اللون المحدد لا يرتبط بهذه المادة في كتالوج الألوان')
          if (!previousPair && !color.active) invalid('اللون المحدد غير قابل للاختيار')
          return previousPair ?? savedColors.find(c => c.colorId === id) ?? { colorId: id, code: color.code, name: color.name }
        })
        if (!group.discardLegacyColors) material.colors.push(...(previousMaterial?.colors ?? []).filter(c => c.colorId === null))
      }
      // Historical material references that were cleared by catalog deletion keep their exact groups.
      for (const material of selectedMaterials.filter(m => m.materialId === null)) {
        const matches = original?.selectedMaterials.filter(m => m.materialId === null && m.name === material.name) ?? []
        if (matches.length === 1) material.colors = matches[0]!.colors ?? []
      }
      unassigned = savedUnmapped.filter(keepUnmapped)
    } else {
      // 0030 request compatibility: map new flat picks only through catalog ids;
      // preserve existing groups and unassigned history rather than guessing.
      const requested: ColorSelection[] = input.colorIds !== undefined
        ? input.colorIds.map(id => {
          const color = colors.get(id)
          if (!color) invalid('اللون المحدد غير موجود في كتالوج الألوان')
          const saved = savedColors.find(c => c.colorId === id)
          if (!saved && !color.active) invalid('اللون المحدد غير قابل للاختيار')
          return saved ?? { colorId: id, code: color.code, name: color.name }
        })
        : input.colorCode === undefined || savedColors.some(c => c.code === input.colorCode)
          ? savedColors
          : input.colorCode ? [{ colorId: null, code: input.colorCode, name: null }] : []
      for (const color of requested) {
        const recordedOwners = original?.selectedMaterials.filter(m => (m.colors ?? []).some(c => c.colorId === color.colorId && c.code === color.code && c.name === color.name)) ?? []
        if (recordedOwners.length === 1) {
          const owner = recordedOwners[0]!
          const material = selectedMaterials.find(m => m.materialId === owner.materialId && m.name === owner.name)
          if (material) material.colors!.push(color)
          // Removing a material also removes its colors, never transfers them.
          continue
        }
        const catalog = color.colorId !== null ? colors.get(color.colorId) : undefined
        const material = catalog?.related_material_id != null ? selectedMaterials.find(m => m.materialId === catalog.related_material_id) : undefined
        if (material) material.colors!.push(color)
        else if (savedUnmapped.some(c => c.colorId === color.colorId && c.code === color.code && c.name === color.name) || color.colorId === null) {
          if (keepUnmapped(color)) unassigned.push(color)
        } else invalid('اللون المحدد لا يرتبط بمادة مختارة في هذا الصنف')
      }
      if (input.colorIds !== undefined && !input.discardLegacyColors) unassigned.push(...savedUnmapped.filter(c => c.colorId === null && !unassigned.includes(c)))
    }
    return {
      selectedMaterials,
      selectedColors: [...selectedMaterials.flatMap(m => m.colors ?? []), ...unassigned.filter(c => c.colorId === null || !selectedMaterials.some(m => (m.colors ?? []).some(assigned => assigned.colorId === c.colorId)))],
      selectedAccessories: materialSet(input.accessoryIds, input.accessoryMaterialId, input.accessories,
        original?.selectedAccessories ?? [], input.discardLegacyAccessories, true)
    }
  })
}

/** Called inside the invoice/order's existing authoritative transaction. */
export function insertItemSelections(
  owner: ItemOwner,
  lineId: number,
  selections: ItemSelections
): void {
  const db = getRawConnection()
  const insertMaterial = db.prepare(`INSERT INTO ${prefixes[owner]}_materials (line_id, material_id, position, name_snapshot) VALUES (?, ?, ?, ?)`)
  const materialSelectionIds = selections.selectedMaterials.map((m, i) => Number(insertMaterial.run(lineId, m.materialId, i, m.name).lastInsertRowid))
  const insertAccessory = db.prepare(`INSERT INTO ${prefixes[owner]}_accessories (line_id, material_id, position, name_snapshot) VALUES (?, ?, ?, ?)`)
  selections.selectedAccessories.forEach((s, i) => insertAccessory.run(lineId, s.materialId, i, s.name))
  const insert = db.prepare(`INSERT INTO ${prefixes[owner]}_colors (line_id, material_selection_id, color_id, position, code_snapshot, name_snapshot) VALUES (?, ?, ?, ?, ?, ?)`)
  selections.selectedColors.forEach((s, i) => {
    const groupIndex = selections.selectedMaterials.findIndex(m => (m.colors ?? []).some(c => c.colorId === s.colorId && c.code === s.code && c.name === s.name))
    insert.run(lineId, groupIndex < 0 ? null : materialSelectionIds[groupIndex], s.colorId, i, s.code, s.name)
  })
}
