import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const mapping = readFileSync('src/shared/production/exit-permit.ts', 'utf8')
const orderPage = readFileSync('src/renderer/pages/orders/OrderDetailPage.tsx', 'utf8')
const deliveriesPage = readFileSync('src/renderer/pages/deliveries/DeliveriesPage.tsx', 'utf8')
const releasesPage = readFileSync('src/renderer/pages/releases/ReleasesPage.tsx', 'utf8')

describe('Exit Permit driven completion UI', () => {
  it('defines all four exact permit and action labels in one shared resolver', () => {
    for (const label of ['إذن تسليم', 'إذن تركيب', 'إذن توصيل', 'إذن توصيل وتركيب']) {
      expect(mapping).toContain(`'${label}'`)
    }
    for (const label of ['تسجيل تسليم', 'تسجيل تركيب', 'تسجيل توصيل', 'تسجيل توصيل وتركيب']) {
      expect(mapping).toContain(`'${label}'`)
    }
    expect(mapping).toContain('const COMPLETION_FOR_PERMIT')
    expect(mapping).toContain("delivery: 'handover'")
    expect(mapping).toContain("transport: 'delivery'")
    expect(mapping).toContain("delivery_installation: 'delivery_installation'")
    expect(mapping).toContain("installation: 'installation'")
  })

  it('renders exactly the backend-resolved pending action on Customer Order Details', () => {
    expect(orderPage).toContain('workflow.requiredCompletion')
    expect(orderPage).toContain('COMPLETION_ACTION_LABEL[requiredCompletion.completionKind]')
    expect(orderPage).toContain('releaseId: Number(form.releaseId)')
    expect(orderPage).not.toContain('!deliveryDone')
    expect(orderPage).not.toContain('!installationDone')
  })

  it('offers all four permit types in both permit views', () => {
    expect(orderPage).toContain('EXIT_PERMIT_KINDS.map')
    expect(releasesPage).toContain('EXIT_PERMIT_KINDS.map')
    expect(orderPage).toContain('EXIT_PERMIT_LABEL[value]')
    expect(releasesPage).toContain('EXIT_PERMIT_LABEL[value]')
  })

  it('makes the Delivery & Installation form permit-driven and preserves team/cost/linkage', () => {
    expect(deliveriesPage).toContain('completionKindForPermit(permit.kind)')
    expect(deliveriesPage).toContain('releaseId: permit.id')
    expect(deliveriesPage).toContain('workerIds: actualWorkerIds')
    expect(deliveriesPage).toContain('COMPLETION_COST_LABEL')
    expect(deliveriesPage).toContain('KIND[row.kind]')
    expect(deliveriesPage).not.toContain('<Field label="النوع" required>')
  })

  it('uses an icon-only Trash confirmation and refreshes permit eligibility after reversal', () => {
    expect(deliveriesPage).toContain("import { Trash2 } from 'lucide-react'")
    expect(deliveriesPage).toContain('window.confirm(`هل تريد حذف عملية ${COMPLETION_LABEL[row.kind]}؟`)')
    expect(deliveriesPage).toContain('title="حذف العملية"')
    expect(deliveriesPage).toContain('aria-label="حذف العملية"')
    expect(deliveriesPage).toContain('<Trash2 size={15}')
    expect(deliveriesPage).toContain('Promise.all([list.reload(), releases.reload()])')
    expect(deliveriesPage).not.toContain("import { Ban } from 'lucide-react'")
  })
})
