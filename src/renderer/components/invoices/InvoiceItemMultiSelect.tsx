import type { ReactElement } from 'react'
import { X } from 'lucide-react'
import {
  SearchableMaterialSelect,
  type MaterialTypeOption
} from '../materials/SearchableMaterialSelect'
import { SearchableColorSelect, type ColorOption } from '../materials/SearchableColorSelect'
import {
  colorSelectionLabel,
  unmappedItemColors,
  type MaterialColorInput,
  type ItemSelections,
  type ColorSelection,
  type MaterialSelection
} from '@shared/documents/item-selections'

interface SelectionProps {
  ids: number[]
  onChange: (ids: number[]) => void
  discardLegacy?: boolean
  onDiscardLegacy: () => void
}
function Chips({
  entries
}: {
  entries: Array<{ key: string; label: string; remove: () => void }>
}): ReactElement {
  return (
    <div className="invoice-item-selections">
      {entries.map((entry) => (
        <span key={entry.key} className="invoice-item-selection">
          <span>{entry.label}</span>
          <button
            type="button"
            title={`إزالة ${entry.label}`}
            aria-label={`إزالة ${entry.label}`}
            onClick={entry.remove}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </span>
      ))}
    </div>
  )
}

/** Adds/removes catalog ids while delegating all search, keyboard and portal behavior to the existing picker. */
export function InvoiceMaterialMultiSelect({
  materials,
  saved,
  searchPlaceholder,
  ...props
}: SelectionProps & {
  materials: MaterialTypeOption[]
  saved: MaterialSelection[]
  searchPlaceholder?: string
}): ReactElement {
  const entries = props.ids.map((id) => ({
    key: String(id),
    label:
      saved.find((s) => s.materialId === id)?.name ??
      materials.find((m) => m.id === id)?.name ??
      'مادة محفوظة',
    remove: () => props.onChange(props.ids.filter((value) => value !== id))
  }))
  if (!props.discardLegacy)
    saved
      .filter((s) => s.materialId === null)
      .forEach((s, index) =>
        entries.push({ key: `legacy-${index}`, label: s.name, remove: props.onDiscardLegacy })
      )
  return (
    <>
      <SearchableMaterialSelect
        materials={materials.filter((m) => !props.ids.includes(m.id))}
        value=""
        searchPlaceholder={searchPlaceholder}
        onChange={(value) => {
          const id = Number(value)
          if (value && !props.ids.includes(id)) props.onChange([...props.ids, id])
        }}
      />
      <Chips entries={entries} />
    </>
  )
}

export function InvoiceColorMultiSelect({
  colors,
  saved,
  ...props
}: SelectionProps & {
  colors: ColorOption[]
  saved: ColorSelection[]
}): ReactElement {
  const entries = props.ids.map((id) => {
    const snapshot = saved.find((c) => c.colorId === id)
    const catalog = colors.find((c) => c.id === id)
    return {
      key: String(id),
      label: snapshot
        ? colorSelectionLabel(snapshot)
        : catalog
          ? `${catalog.code} — ${catalog.name}`
          : 'لون محفوظ',
      remove: () => props.onChange(props.ids.filter((value) => value !== id))
    }
  })
  if (!props.discardLegacy)
    saved
      .filter((c) => c.colorId === null)
      .forEach((c, index) =>
        entries.push({
          key: `legacy-${index}`,
          label: colorSelectionLabel(c),
          remove: props.onDiscardLegacy
        })
      )
  return (
    <>
      <SearchableColorSelect
        colors={colors.filter((c) => !props.ids.includes(c.id))}
        value=""
        noneLabel="—"
        onChange={(code) => {
          const color = colors.find((c) => c.code === code)
          if (color && !props.ids.includes(color.id)) props.onChange([...props.ids, color.id])
        }}
      />
      <Chips entries={entries} />
    </>
  )
}

export interface MaterialLinkedColorOption extends ColorOption { associatedMaterials: Array<{ id: number }> }
export function colorsForInvoiceMaterial(colors: MaterialLinkedColorOption[], materialId: number): MaterialLinkedColorOption[] {
  return colors.filter(color => color.associatedMaterials.some(material => material.id === materialId))
}

/** Selection ids remain keyed by material, so removal/reordering cannot transfer colors. */
export function retainMaterialColorInputs(ids: number[], groups: MaterialColorInput[]): MaterialColorInput[] {
  return ids.map(materialId => groups.find(g => g.materialId === materialId) ?? { materialId, colorIds: [] })
}

export function InvoiceMaterialColorGroups({
  materials, colors, ids, groups, saved, onMaterialsChange, onColorsChange,
  discardLegacyMaterials, onDiscardLegacyMaterials,
  retainedUnmappedColorIds, onRetainedUnmappedColorsChange,
  discardLegacyColors, onDiscardLegacyColors
}: {
  materials: MaterialTypeOption[]
  colors: MaterialLinkedColorOption[]
  ids: number[]
  groups: MaterialColorInput[]
  saved: ItemSelections
  onMaterialsChange: (ids: number[], groups: MaterialColorInput[]) => void
  onColorsChange: (groups: MaterialColorInput[]) => void
  discardLegacyMaterials?: boolean
  onDiscardLegacyMaterials: () => void
  retainedUnmappedColorIds: number[]
  onRetainedUnmappedColorsChange: (ids: number[]) => void
  discardLegacyColors?: boolean
  onDiscardLegacyColors: () => void
}): ReactElement {
  const unmapped = unmappedItemColors(saved).filter(c => c.colorId === null ? !discardLegacyColors : retainedUnmappedColorIds.includes(c.colorId))
  return <>
    <InvoiceMaterialMultiSelect materials={materials} ids={ids} saved={saved.selectedMaterials}
      onChange={values => onMaterialsChange(values, retainMaterialColorInputs(values, groups))}
      discardLegacy={discardLegacyMaterials} onDiscardLegacy={onDiscardLegacyMaterials} />
    <div className="invoice-material-groups">
      {ids.map(materialId => {
        const material = saved.selectedMaterials.find(m => m.materialId === materialId)
        const name = material?.name ?? materials.find(m => m.id === materialId)?.name ?? 'مادة محفوظة'
        const group = groups.find(g => g.materialId === materialId) ?? { materialId, colorIds: [] }
        const patchGroup = (patch: Partial<MaterialColorInput>): void => onColorsChange(retainMaterialColorInputs(ids, groups).map(g => g.materialId === materialId ? { ...g, ...patch } : g))
        return <div key={materialId} className="invoice-material-group" role="group" aria-label={`ألوان ${name}`}>
          <div className="invoice-material-group__name">{name}</div>
          <div className="field__label">كود اللون/التشطيب</div>
          <InvoiceColorMultiSelect colors={colorsForInvoiceMaterial(colors, materialId)} ids={group.colorIds} saved={material?.colors ?? []}
            onChange={colorIds => patchGroup({ colorIds })} discardLegacy={group.discardLegacyColors}
            onDiscardLegacy={() => patchGroup({ discardLegacyColors: true })} />
        </div>
      })}
      {!discardLegacyMaterials && saved.selectedMaterials.filter(m => m.materialId === null).map((m, index) => <div key={`legacy-${index}`} className="invoice-material-group">
        <div className="invoice-material-group__name">{m.name}</div>
        {(m.colors ?? []).map((c, i) => <span key={i} className="invoice-item-selection">{colorSelectionLabel(c)}</span>)}
      </div>)}
    </div>
    {unmapped.length > 0 && <div className="invoice-unmapped-colors">
      <div className="field__hint">ألوان/تشطيبات محفوظة دون ارتباط مؤكد بمادة</div>
      <Chips entries={unmapped.map((c, index) => ({ key: String(c.colorId ?? `legacy-${index}`), label: colorSelectionLabel(c),
        remove: () => c.colorId === null ? onDiscardLegacyColors() : onRetainedUnmappedColorsChange(retainedUnmappedColorIds.filter(id => id !== c.colorId)) }))} />
    </div>}
  </>
}
