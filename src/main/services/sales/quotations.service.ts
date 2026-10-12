import { requireActiveCustomer } from '../parties/parties.service'
import { and, eq, like, or, sql, type SQL } from 'drizzle-orm'
import { keysetBoundary, keysetOrder, keysetPage, normalizedSearch, type KeysetWindow, type PageRequest } from '../base/pagination'
import { loadItemSelections, prepareItemSelections, insertItemSelections } from './item-selections.service'
import type { ItemSelections, ItemSelectionInput } from '@shared/documents/item-selections'
import { getDatabase, getRawConnection } from '../../db/connection'
import { withTransaction } from '../../db/transactions'
import { quotations, quotationLines } from '../../db/schema/sales.schema'
import { customers } from '../../db/schema/parties.schema'
import { products } from '../../db/schema/products.schema'
import { AppError, notFound } from '../../utils/errors'
import { computeDocumentTotals as computeTotals } from './document-totals'
import {
  parsePrintVisibility,
  serializePrintVisibility,
  type PrintVisibilityInput
} from '@shared/documents/print-visibility'
import { nextDocumentNumber } from '../numbering.service'
import { recordAuditEvent } from '../../audit/audit-log.service'
import { nowIso, type ServiceContext } from '../base/service.types'
import { getTerms, getDefaultDepositPercentBp, getSetting, SETTING_KEYS } from '../settings.service'
import { buildBomSnapshot } from '../products/products.service'
import { PERMISSION_KEYS } from '@shared/permissions/permission-keys'
import { requirePermission } from '../../permissions/permission-guard'
// A preliminary invoice created under the OLD workflow may still be
// linked to the order it was converted into. Deleting one reuses the
// order service's single full-delete implementation rather than
// repeating it; both sides are hoisted function declarations, so the
// module cycle resolves at call time, never at module-evaluation time.
import { fullDeletePreview, performFullDeleteOrder } from './orders.service'

export interface QuotationLineInput extends ItemSelectionInput {
  lineKind: 'standard' | 'custom' | 'material' | 'delivery' | 'installation'
  productId?: number | null
  materialId?: number | null
  description: string
  specifications?: string | null
  dimensions?: string | null
  materialType?: string | null
  colorCode?: string | null
  accessories?: string | null
  /** The Raw Material accessory picked from the catalog, if any. The
   *  stored `accessories` text is then its frozen snapshot. */
  accessoryMaterialId?: number | null
  /** The Raw Material picked for "نوع المادة", if any — same
   *  reference+snapshot shape as accessoryMaterialId. */
  materialTypeMaterialId?: number | null
  quantityMicro: number
  unitPriceMinor: number
  notes?: string | null
}


export function listQuotations(
  filter: { search?: string; customerId?: number; status?: string; from?: string; to?: string } = {},
  request: PageRequest = {}
) {
  const normalized = { customerId: filter.customerId, status: filter.status, from: filter.from, to: filter.to, search: normalizedSearch(filter.search) }
  const clauses: SQL[] = []
  if (normalized.customerId) clauses.push(eq(quotations.customerId, normalized.customerId))
  if (normalized.status) clauses.push(eq(quotations.status, normalized.status))
  if (normalized.from) clauses.push(sql`${quotations.createdAt} >= ${normalized.from}`)
  if (normalized.to) clauses.push(sql`${quotations.createdAt} <= ${normalized.to}`)
  if (normalized.search) {
    const p = `%${normalized.search}%`
    clauses.push(or(like(quotations.documentNumber, p), like(customers.name, p))!)
  }
  return keysetPage({
    scope: 'quotations.list',
    filters: normalized,
    request,
    keyTypes: ['int'],
    order: 'desc',
    keyOf: (row) => [row.id],
    fetch: (window: KeysetWindow) => getDatabase()
      .select({
        id: quotations.id,
        documentNumber: quotations.documentNumber,
        customerId: quotations.customerId,
        customerName: customers.name,
        status: quotations.status,
        issuedAt: quotations.issuedAt,
        validUntil: quotations.validUntil,
        totalMinor: quotations.totalMinor,
        depositRequiredMinor: quotations.depositRequiredMinor,
        remainingMinor: quotations.remainingMinor,
        createdAt: quotations.createdAt
      })
      .from(quotations)
      .innerJoin(customers, eq(quotations.customerId, customers.id))
      .where(and(...clauses, keysetBoundary([sql`${quotations.id}`], window)))
      .orderBy(keysetOrder([sql`${quotations.id}`], window))
      .limit(window.take)
      .all()
      .map((row) => ({ ...row, status: effectiveStatus(row.status, row.validUntil) })),
    summary: () => undefined
  })
}

/**
 * BR-44/BR-75: an issued preliminary invoice carries a validity window.
 * Expiry is derived, not a background job — a document past its
 * validUntil always reads as expired.
 */
export function effectiveStatus(status: string, validUntil: string | null): string {
  // `approved` is the legacy value for what is now `issued`; both expire
  // the same way, and expiry stays purely informational — nothing
  // downstream depends on a preliminary invoice any more.
  const issued = status === 'issued' || status === 'approved'
  if (issued && validUntil && new Date(validUntil).getTime() < Date.now()) {
    return 'expired'
  }
  return status
}

export function getQuotation(id: number) {
  const quotation = getDatabase().select().from(quotations).where(eq(quotations.id, id)).get()
  if (!quotation) throw notFound('عرض السعر غير موجود')
  const lines = getDatabase()
    .select()
    .from(quotationLines)
    .where(eq(quotationLines.quotationId, id))
    .all()
  return {
    quotation: { ...quotation, status: effectiveStatus(quotation.status, quotation.validUntil) },
    lines: loadItemSelections('quotation', lines)
  }
}

export function createQuotation(
  input: {
    customerId: number
    lines: QuotationLineInput[]
    discountKind?: 'none' | 'amount' | 'percent'
    discountValue?: number
    depositPercentBp?: number
    requiresInstallation?: boolean
    requiresDelivery?: boolean
    /** Commercial rate per metre — informational, never part of a total. */
    meterPriceMinor?: number
    /** Additional charges; each is added to the total exactly once. */
    installationPriceMinor?: number
    deliveryPriceMinor?: number
    /** Which fields this document may show on its PDF. */
    printVisibility?: PrintVisibilityInput
    notes?: string
    revisionOf?: number
  },
  ctx: ServiceContext
): { id: number; documentNumber: string } {
  requirePermission(ctx.session, PERMISSION_KEYS.quotations.manage)
  if (!input.lines.length) throw new AppError('VALIDATION_ERROR', 'يجب إضافة صنف واحد على الأقل')
  requireActiveCustomer(input.customerId)

  return withTransaction(() => {
    const depositPercentBp = input.depositPercentBp ?? getDefaultDepositPercentBp()
    const totals = computeTotals(
      input.lines,
      input.discountKind ?? 'none',
      input.discountValue ?? 0,
      depositPercentBp,
      {
        installationPriceMinor: input.installationPriceMinor,
        deliveryPriceMinor: input.deliveryPriceMinor
      }
    )
    const documentNumber = nextDocumentNumber('QT')

    const id = Number(
      getDatabase()
        .insert(quotations)
        .values({
          documentNumber,
          customerId: input.customerId,
          status: 'draft',
          subtotalMinor: totals.subtotalMinor,
          discountKind: input.discountKind ?? 'none',
          discountValue: input.discountValue ?? 0,
          discountMinor: totals.discountMinor,
          totalMinor: totals.totalMinor,
          depositPercentBp,
          depositRequiredMinor: totals.depositRequiredMinor,
          remainingMinor: totals.remainingMinor,
          requiresInstallation: input.requiresInstallation ?? false,
          requiresDelivery: input.requiresDelivery ?? false,
          meterPriceMinor: input.meterPriceMinor ?? 0,
          installationPriceMinor: totals.installationPriceMinor,
          deliveryPriceMinor: totals.deliveryPriceMinor,
          printVisibility: input.printVisibility
            ? serializePrintVisibility(input.printVisibility)
            : null,
          revisionOf: input.revisionOf ?? null,
          notes: input.notes ?? null,
          createdBy: ctx.session.user.id,
          createdAt: nowIso()
        })
        .run().lastInsertRowid
    )

    insertLines(id, input.lines, totals.lineTotals)

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'quotations.create',
      entity: 'quotations',
      entityId: String(id),
      details: { documentNumber, totalMinor: totals.totalMinor }
    })
    return { id, documentNumber }
  })
}

function insertLines(
  quotationId: number,
  lines: QuotationLineInput[],
  lineTotals: number[],
  selectionSets: ItemSelections[] = prepareItemSelections(lines)
): void {
  const db = getDatabase()
  lines.forEach((line, index) => {
    const selections = selectionSets[index]!
    const lineId = Number(db.insert(quotationLines)
      .values({
        quotationId,
        lineKind: line.lineKind,
        productId: line.productId ?? null,
        materialId: line.materialId ?? null,
        description: line.description,
        specifications: line.specifications ?? null,
        dimensions: line.dimensions ?? null,
        colorCode: selections.selectedColors[0]?.code ?? null,
        accessoryMaterialId: selections.selectedAccessories[0]?.materialId ?? null,
        accessories: selections.selectedAccessories[0]?.name ?? null,
        materialTypeMaterialId: selections.selectedMaterials[0]?.materialId ?? null,
        materialType: selections.selectedMaterials[0]?.name ?? null,
        quantityMicro: line.quantityMicro,
        unitPriceMinor: line.unitPriceMinor,
        lineTotalMinor: lineTotals[index] ?? 0,
        // BR-46: a standard product's BOM is copied here at quotation time.
        bomSnapshot: line.productId ? buildBomSnapshot(line.productId) : null,
        notes: line.notes ?? null
      })
      .run().lastInsertRowid)
    insertItemSelections('quotation', lineId, selections)
  })
}

function assertDraft(id: number) {
  const quotation = getDatabase().select().from(quotations).where(eq(quotations.id, id)).get()
  if (!quotation) throw notFound('عرض السعر غير موجود')
  if (quotation.status !== 'draft') {
    // BR-45: an issued document is never modified — a revision is created.
    throw new AppError(
      'CONFLICT',
      'لا يمكن تعديل فاتورة مبدئية صادرة. الرجاء إنشاء نسخة مُعدّلة جديدة'
    )
  }
  return quotation
}

export function updateQuotation(
  id: number,
  input: {
    lines?: QuotationLineInput[]
    discountKind?: 'none' | 'amount' | 'percent'
    discountValue?: number
    depositPercentBp?: number
    requiresInstallation?: boolean
    requiresDelivery?: boolean
    meterPriceMinor?: number
    installationPriceMinor?: number
    deliveryPriceMinor?: number
    printVisibility?: PrintVisibilityInput
    notes?: string
  },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, PERMISSION_KEYS.quotations.manage)
  const existing = assertDraft(id)

  withTransaction(() => {
    const db = getDatabase()
    const lines =
      input.lines ??
      db
        .select()
        .from(quotationLines)
        .where(eq(quotationLines.quotationId, id))
        .all()
        .map((line) => ({
          lineKind: line.lineKind as QuotationLineInput['lineKind'],
          productId: line.productId,
          materialId: line.materialId,
          description: line.description,
          specifications: line.specifications,
          dimensions: line.dimensions,
          materialType: line.materialType,
          materialTypeMaterialId: line.materialTypeMaterialId,
          colorCode: line.colorCode,
          accessories: line.accessories,
          accessoryMaterialId: line.accessoryMaterialId,
          quantityMicro: line.quantityMicro,
          unitPriceMinor: line.unitPriceMinor,
          notes: line.notes
        }))

    const depositPercentBp = input.depositPercentBp ?? existing.depositPercentBp
    const totals = computeTotals(
      lines,
      input.discountKind ?? (existing.discountKind as 'none' | 'amount' | 'percent'),
      input.discountValue ?? existing.discountValue,
      depositPercentBp,
      {
        installationPriceMinor: input.installationPriceMinor ?? existing.installationPriceMinor,
        deliveryPriceMinor: input.deliveryPriceMinor ?? existing.deliveryPriceMinor
      }
    )

    if (input.lines) {
      const selectionSets = prepareItemSelections(input.lines, getQuotation(id).lines)
      db.delete(quotationLines).where(eq(quotationLines.quotationId, id)).run()
      insertLines(id, input.lines, totals.lineTotals, selectionSets)
    }

    db.update(quotations)
      .set({
        subtotalMinor: totals.subtotalMinor,
        discountKind: input.discountKind ?? existing.discountKind,
        discountValue: input.discountValue ?? existing.discountValue,
        discountMinor: totals.discountMinor,
        totalMinor: totals.totalMinor,
        depositPercentBp,
        depositRequiredMinor: totals.depositRequiredMinor,
        remainingMinor: totals.remainingMinor,
        requiresInstallation: input.requiresInstallation ?? existing.requiresInstallation,
        requiresDelivery: input.requiresDelivery ?? existing.requiresDelivery,
        meterPriceMinor: input.meterPriceMinor ?? existing.meterPriceMinor,
        installationPriceMinor: totals.installationPriceMinor,
        deliveryPriceMinor: totals.deliveryPriceMinor,
        // Visibility is only rewritten when the caller sent a choice —
        // omitting it must never silently reset a document to defaults.
        printVisibility: input.printVisibility
          ? serializePrintVisibility(input.printVisibility)
          : existing.printVisibility,
        notes: input.notes ?? existing.notes
      })
      .where(eq(quotations.id, id))
      .run()

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'quotations.update',
      entity: 'quotations',
      entityId: String(id),
      details: input
    })
  })
}

/**
 * Item 2: the STANDARD-product preliminary invoice.
 *
 * The second sales entry path, started from "المنتجات وقائمة المواد".
 * It is the same quotation model — no parallel sales backend — with the
 * line pre-built from the saved product: its name, its price and, via
 * the standard `productId` path in insertLines, its BOM snapshot
 * (BR-46). The user never re-enters the BOM, and production later reads
 * that snapshot exactly as it does for any other standard line.
 */
export function createStandardQuotation(
  input: {
    customerId: number
    productId: number
    quantityMicro: number
    unitPriceMinor?: number
    discountKind?: 'none' | 'amount' | 'percent'
    discountValue?: number
    depositPercentBp?: number
    requiresInstallation?: boolean
    requiresDelivery?: boolean
    dimensions?: string
    colorCode?: string
    accessories?: string
    specifications?: string
    notes?: string
  },
  ctx: ServiceContext
): { id: number; documentNumber: string } {
  requirePermission(ctx.session, PERMISSION_KEYS.quotations.manage)
  const product = getDatabase().select().from(products).where(eq(products.id, input.productId)).get()
  if (!product) throw notFound('المنتج غير موجود')
  if (input.quantityMicro <= 0) {
    throw new AppError('VALIDATION_ERROR', 'الكمية يجب أن تكون أكبر من صفر')
  }

  return createQuotation(
    {
      ...input,
      lines: [
        {
          lineKind: 'standard',
          productId: product.id,
          description: product.name,
          specifications: input.specifications ?? product.description ?? null,
          dimensions: input.dimensions ?? null,
          colorCode: input.colorCode ?? null,
          accessories: input.accessories ?? null,
          quantityMicro: input.quantityMicro,
          unitPriceMinor: input.unitPriceMinor ?? product.defaultPriceMinor
        }
      ]
    },
    ctx
  )
}

/**
 * Workflow pass: a preliminary invoice is ISSUED (prepared and sent to
 * the customer), never "approved into an order".
 *
 * Issuing locks the document, starts its validity window and freezes
 * the Terms text in force at that moment so a later Settings edit can
 * never rewrite a document already in the customer's hands. It creates
 * NOTHING else: no order, no approved invoice, no production, no
 * inventory movement and no financial posting.
 */
export function issueQuotation(id: number, ctx: ServiceContext): { validUntil: string } {
  requirePermission(ctx.session, PERMISSION_KEYS.quotations.issue)
  return withTransaction(() => {
    const quotation = assertDraft(id)
    requireActiveCustomer(quotation.customerId)
    const customer = getDatabase().select().from(customers).where(eq(customers.id, quotation.customerId)).get()
    if (!customer) throw notFound('العميل غير موجود')
    const validityHours = getSetting<number>(SETTING_KEYS.quotationValidityHours)
    const issuedAt = new Date()
    const validUntil = new Date(issuedAt.getTime() + validityHours * 60 * 60 * 1000)

    getDatabase()
      .update(quotations)
      .set({
        status: 'issued',
        issuedAt: issuedAt.toISOString(),
        validUntil: validUntil.toISOString(),
        termsSnapshot: JSON.stringify(getTerms()),
        customerSnapshot: JSON.stringify({ name: customer.name, phone: customer.phone, address: customer.address })
      })
      .where(eq(quotations.id, quotation.id))
      .run()

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'quotations.issue',
      entity: 'quotations',
      entityId: String(id),
      details: { validUntil: validUntil.toISOString() }
    })
    return { validUntil: validUntil.toISOString() }
  })
}

/** BR-45: changes after approval create a linked revision, never an edit. */
export function createRevision(id: number, ctx: ServiceContext): { id: number; documentNumber: string } {
  requirePermission(ctx.session, PERMISSION_KEYS.quotations.manage)
  const { quotation, lines } = getQuotation(id)
  return withTransaction(() => {
    const result = createQuotation(
    {
      customerId: quotation.customerId,
      discountKind: quotation.discountKind as 'none' | 'amount' | 'percent',
      discountValue: quotation.discountValue,
      depositPercentBp: quotation.depositPercentBp,
      requiresInstallation: quotation.requiresInstallation,
      requiresDelivery: quotation.requiresDelivery,
      // A revision restates the same commercial offer, so its charges,
      // metre rate and print choices carry over rather than resetting.
      meterPriceMinor: quotation.meterPriceMinor,
      installationPriceMinor: quotation.installationPriceMinor,
      deliveryPriceMinor: quotation.deliveryPriceMinor,
      printVisibility: quotation.printVisibility
        ? parsePrintVisibility(quotation.printVisibility)
        : undefined,
      notes: quotation.notes ?? undefined,
      revisionOf: quotation.id,
      lines: lines.map((line) => ({
        lineKind: line.lineKind as QuotationLineInput['lineKind'],
        productId: line.productId,
        materialId: line.materialId,
        description: line.description,
        specifications: line.specifications,
        dimensions: line.dimensions,
        materialType: line.materialType,
        materialTypeMaterialId: line.materialTypeMaterialId,
        colorCode: line.colorCode,
        accessories: line.accessories,
        accessoryMaterialId: line.accessoryMaterialId,
        quantityMicro: line.quantityMicro,
        unitPriceMinor: line.unitPriceMinor,
        notes: line.notes
      }))
    },
    ctx
  )
    const revisedLines = getQuotation(result.id).lines
    // Restate the complete recorded offer, including historical catalog wording.
    const raw = getRawConnection()
    for (const [index, line] of lines.entries()) {
      const target = revisedLines[index]!
      for (const kind of ['materials', 'colors', 'accessories']) raw.prepare(`DELETE FROM quotation_line_${kind} WHERE line_id = ?`).run(target.id)
      insertItemSelections('quotation', target.id, line)
    }
    return result
  })
}

export interface QuotationDeletePreview {
  quotationId: number
  documentNumber: string
  status: string
  /** The customer order this invoice was converted into, if any. */
  order: { id: number; documentNumber: string } | null
  dependencies: Array<{ key: string; label: string; count: number }>
  blockers: string[]
  /** True when the operator must type the invoice number to proceed. */
  requiresConfirmation: boolean
}

/**
 * Discovers, without mutating anything, everything that would go with
 * a preliminary invoice: its own lines and frozen planning snapshot,
 * any revision issued from it, and — the case that used to be refused
 * outright — the customer order it was converted into, together with
 * that order's complete dependency graph as the order service itself
 * reports it.
 */
export function quotationDeletePreview(id: number): QuotationDeletePreview {
  const quotation = getDatabase().select().from(quotations).where(eq(quotations.id, id)).get()
  if (!quotation) throw notFound('عرض السعر غير موجود')
  const count = (query: ReturnType<typeof sql>): number =>
    getDatabase().get<{ c: number }>(query)?.c ?? 0

  const order = getDatabase()
    .get<{ id: number; documentNumber: string }>(
      sql`SELECT id, document_number AS documentNumber FROM orders WHERE quotation_id = ${id} LIMIT 1`
    ) ?? null

  const dependencies: Array<{ key: string; label: string; count: number }> = []
  const push = (key: string, label: string, value: number): void => {
    if (value > 0) dependencies.push({ key, label, count: value })
  }
  push('lines', 'بنود الفاتورة المبدئية', count(sql`SELECT COUNT(*) AS c FROM quotation_lines WHERE quotation_id = ${id}`))
  push('plannedMaterials', 'لقطات المواد المخططة', count(sql`SELECT COUNT(*) AS c FROM planned_materials WHERE quotation_id = ${id}`))
  push('plannedMachines', 'لقطات الآلات المخططة', count(sql`SELECT COUNT(*) AS c FROM planned_machines WHERE quotation_id = ${id}`))
  push('plannedWorkers', 'لقطات العمال المخططة', count(sql`SELECT COUNT(*) AS c FROM planned_workers WHERE quotation_id = ${id}`))

  const blockers: string[] = []
  if (quotation.status !== 'draft') {
    blockers.push(
      'الفاتورة المبدئية صادرة أو ملغاة وأصبحت سجلاً تجارياً؛ الحذف النهائي متاح للمسودة فقط'
    )
  }
  const revisions = count(sql`SELECT COUNT(*) AS c FROM quotations WHERE revision_of = ${id}`)
  if (revisions > 0) {
    push('revisions', 'نسخ منقّحة صادرة عن هذه الفاتورة', revisions)
    blockers.push('صدرت عن هذه الفاتورة المبدئية نسخة منقّحة، وحذفها يقطع سلسلة المستند')
  }

  if (order) {
    push('order', `طلب العميل ${order.documentNumber}`, 1)
    // Reuse the order service's own graph and safety rules verbatim —
    // there is exactly one full-delete implementation in the ERP.
    const orderPreview = fullDeletePreview(order.id)
    for (const item of orderPreview.dependencies) {
      dependencies.push({ key: `order.${item.key}`, label: item.label, count: item.count })
    }
    // If the order's own effects cannot be restored exactly (shared FIFO
    // layers consumed by later unrelated work, offcuts, mismatched cash),
    // the whole deletion is refused — never a partial one (item 10).
    blockers.push(...orderPreview.blockers)
  }

  return {
    quotationId: id,
    documentNumber: quotation.documentNumber,
    status: quotation.status,
    order,
    dependencies,
    blockers: [...new Set(blockers)],
    requiresConfirmation: Boolean(order)
  }
}

/**
 * Delete a preliminary invoice (Part B of the deletion pass). The Trash
 * icon is always a real delete — the user is never told merely to "use
 * إلغاء" instead — and is never asked for a reason.
 *
 * Drafts may be hard-deleted. Issued/cancelled documents and converted
 * documents are posted commercial history and are refused in full, so the
 * converted-order branch below is not reachable through this service: an
 * order only ever carries a `quotation_id` once its quotation has been
 * issued/approved, which trips the `status !== 'draft'` blocker in
 * `quotationDeletePreview`. It is retained as-is rather than removed —
 * its reachability is a separate open question, not part of any cleanup.
 */
export function deleteQuotation(
  input: { id: number; confirmation?: string },
  ctx: ServiceContext
): { removed: true; orderRemoved: boolean } {
  requirePermission(ctx.session, PERMISSION_KEYS.quotations.remove)
  const preview = quotationDeletePreview(input.id)

  // Authorization is checked before exposing the linked order's business
  // state or accepting a destructive confirmation token.
  if (preview.order) requirePermission(ctx.session, PERMISSION_KEYS.orders.fullDelete)
  if (preview.requiresConfirmation && input.confirmation?.trim() !== preview.documentNumber) {
    throw new AppError(
      'VALIDATION_ERROR',
      `اكتب رقم الفاتورة المبدئية ${preview.documentNumber} لتأكيد حذفها مع طلب العميل الناتج عنها`
    )
  }
  if (preview.blockers.length) {
    throw new AppError(
      'CONFLICT',
      `تعذر حذف الفاتورة المبدئية لأن استعادة آثارها بالكامل غير مضمونة: ${preview.blockers.join('، ')}`
    )
  }

  withTransaction(() => {
    if (preview.order) {
      performFullDeleteOrder(preview.order.id, ctx, `الفاتورة المبدئية ${preview.documentNumber}`)
    }
    const db = getDatabase()
    db.run(sql`DELETE FROM planned_materials WHERE quotation_id = ${input.id}`)
    db.run(sql`DELETE FROM planned_machines WHERE quotation_id = ${input.id}`)
    db.run(sql`DELETE FROM planned_workers WHERE quotation_id = ${input.id}`)
    db.delete(quotationLines).where(eq(quotationLines.quotationId, input.id)).run()
    db.delete(quotations).where(eq(quotations.id, input.id)).run()

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'quotations.delete',
      entity: 'quotations',
      entityId: String(input.id),
      details: {
        description: `Preliminary Invoice deletion (${preview.documentNumber})`,
        documentNumber: preview.documentNumber,
        status: preview.status,
        orderRemoved: preview.order?.documentNumber ?? null,
        summary: Object.fromEntries(preview.dependencies.map((item) => [item.key, item.count]))
      }
    })
  })

  return { removed: true, orderRemoved: Boolean(preview.order) }
}

export function cancelQuotation(id: number, ctx: ServiceContext): void {
  requirePermission(ctx.session, PERMISSION_KEYS.quotations.manage)
  return withTransaction(() => {
    const quotation = getDatabase().select().from(quotations).where(eq(quotations.id, id)).get()
    if (!quotation) throw notFound('عرض السعر غير موجود')
    if (quotation.status === 'converted') {
      throw new AppError('CONFLICT', 'لا يمكن إلغاء عرض سعر تم تحويله إلى طلب')
    }
    getDatabase().update(quotations).set({ status: 'cancelled' }).where(eq(quotations.id, id)).run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'quotations.cancel',
      entity: 'quotations',
      entityId: String(id)
    })
  })
}
