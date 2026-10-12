/** Catalog references and the wording frozen on a saved commercial item. */
export interface MaterialSelection {
  materialId: number | null
  name: string
}
export interface ColorSelection {
  colorId: number | null
  code: string
  name: string | null
}
export interface ItemMaterialSelection extends MaterialSelection {
  /** Frozen colors belonging to this specific material selection. */
  colors?: ColorSelection[]
}
export interface MaterialColorInput {
  materialId: number
  colorIds: number[]
  discardLegacyColors?: boolean
}
export interface ItemSelections {
  selectedMaterials: ItemMaterialSelection[]
  selectedColors: ColorSelection[]
  selectedAccessories: MaterialSelection[]
}
export interface ItemSelectionInput {
  discardLegacyMaterials?: boolean
  discardLegacyColors?: boolean
  discardLegacyAccessories?: boolean
  materialColors?: MaterialColorInput[]
  retainedUnmappedColorIds?: number[]
  sourceLineId?: number
  materialIds?: number[]
  colorIds?: number[]
  accessoryIds?: number[]
}
export const colorSelectionLabel = (color: ColorSelection): string =>
  color.name ? `${color.code} — ${color.name}` : color.code

const colorKey = (color: ColorSelection): string => JSON.stringify([color.colorId, color.code, color.name])

/** Flat color summary is retained for 0030 readers; unassigned history is never guessed. */
export function unmappedItemColors(selections: Pick<ItemSelections, 'selectedMaterials' | 'selectedColors'>): ColorSelection[] {
  const assigned = new Set(selections.selectedMaterials.flatMap(m => (m.colors ?? []).map(colorKey)))
  return selections.selectedColors.filter(c => !assigned.has(colorKey(c)))
}

/** Upgrade an old frozen 0030 snapshot using only matching migrated, persisted snapshots. */
export function restoreSnapshotMaterialGroups(materials: ItemMaterialSelection[], colors: ColorSelection[], persisted?: ItemSelections): ItemMaterialSelection[] {
  return materials.map(material => {
    if (material.colors !== undefined) return material
    const matches = persisted?.selectedMaterials.filter(m => m.materialId === material.materialId && m.name === material.name) ?? []
    const recorded = matches.length === 1 ? new Set((matches[0]!.colors ?? []).map(colorKey)) : new Set<string>()
    return { ...material, colors: colors.filter(c => recorded.has(colorKey(c))) }
  })
}
