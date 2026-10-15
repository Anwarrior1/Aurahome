import type { ReactElement, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, calls: vi.fn(), colors: [] as unknown[]
}))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = runtime.cursor++
    if (!(index in runtime.slots)) runtime.slots[index] = initial
    return [runtime.slots[index], (next: unknown) => {
      runtime.slots[index] = typeof next === 'function'
        ? (next as (value: unknown) => unknown)(runtime.slots[index]) : next
    }]
  }
}))
vi.mock('@renderer/lib/useQuery', () => ({ useQuery: () => ({
  data: runtime.colors, loading: false, reload: vi.fn().mockResolvedValue(undefined)
}) }))
vi.mock('@renderer/lib/api', () => ({ call: (...args: unknown[]) => runtime.calls(...args), ApiError: class extends Error {} }))
vi.mock('@renderer/lib/toast', () => ({ useToast: () => ({ show: vi.fn() }) }))
vi.mock('@renderer/state/session.store', () => ({ useSession: () => ({ can: () => true }) }))

import { ColorsPage } from '@renderer/pages/colors/ColorsPage'
import { SearchableMaterialSelect } from '@renderer/components/materials/SearchableMaterialSelect'
import { Button, DataTable, Modal } from '@renderer/components/ui'

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!node || typeof node !== 'object' || !('props' in node)) return []
  const element = node as ReactElement<Record<string, unknown>>
  return [element, ...elements(element.props.children as ReactNode),
    ...elements(element.props.actions as ReactNode), ...elements(element.props.footer as ReactNode)]
}
function render() {
  runtime.cursor = 0
  return elements(ColorsPage())
}

beforeEach(() => {
  vi.unstubAllGlobals()
  runtime.slots = []; runtime.cursor = 0; runtime.calls.mockReset()
  runtime.calls.mockResolvedValue({ id: 10 })
  runtime.colors = []
})

describe('Color Catalog association view', () => {
  it('creates a reusable color without asking for a material', async () => {
    let page = render()
    ;(page.find((item) => item.type === Button && item.props.children === '+ لون جديد')!.props.onClick as () => void)()
    page = render()
    expect(page.find((item) => item.type === Modal)?.props.title).toBe('لون جديد')
    expect(page.some((item) => item.type === SearchableMaterialSelect)).toBe(false)
  })

  it('shows current materials and a legacy conflict without sending association writes', async () => {
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', { dispatchEvent })
    const existing = { id: 4, code: 'WHITE', name: 'أبيض', relatedMaterialId: 9,
      relatedMaterialType: 'Legacy', associatedMaterials: [{ id: 1, sku: 'PVC', name: 'PVC' }],
      baseMaterialNames: ['PVC'], unresolvedMaterialIds: [],
      legacyAssociationConflict: true, notes: null, active: true }
    runtime.colors = [existing]
    let page = render()
    const table = page.find((item) => item.type === DataTable)!
    const columns = table.props.columns as Array<{ key: string; render: (row: typeof existing) => ReactNode }>
    expect(columns.find((column) => column.key === 'type')!.render(existing)).toContain('PVC ⚠ ارتباط قديم متعارض')
    const actions = elements(columns.find((column) => column.key === 'actions')!.render(existing))
    ;(actions.find((item) => item.props['aria-label'] === 'تعديل')!.props.onClick as () => void)()
    page = render()
    expect(page.some((item) => item.type === SearchableMaterialSelect)).toBe(false)
    expect(page.some((item) => item.props.children === 'PVC')).toBe(true)
    ;(page.find((item) => item.type === Button && item.props.children === 'حفظ')!.props.onClick as () => void)()
    await Promise.resolve()
    expect(runtime.calls).toHaveBeenCalledWith('colors', 'update', expect.not.objectContaining({ relatedMaterialId: expect.anything() }))
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'catalog-changed' }))
  })
})
