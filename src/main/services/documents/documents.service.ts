import { colorSelectionLabel, restoreSnapshotMaterialGroups, unmappedItemColors, type ItemSelections } from '@shared/documents/item-selections'
import { eq } from 'drizzle-orm'
import { getDatabase } from '../../db/connection'
import { customers } from '../../db/schema/parties.schema'
import { workSheets, releases } from '../../db/schema/production.schema'
import { notFound } from '../../utils/errors'
import { formatMoney, money } from '@shared/money/money'
import { formatQuantity, quantity } from '@shared/quantity/quantity'
import type { CustomerDocumentDTO } from '../../reports/dto/customer-document.dto'
import type { InternalWorkSheetDTO } from '../../reports/dto/internal-worksheet.dto'
import type { InternalReleaseDTO } from '../../reports/dto/internal-release.dto'
import { getQuotation } from '../sales/quotations.service'
import { getOrder } from '../sales/orders.service'
import { getFinalInvoice } from '../sales/final-invoices.service'
import { workSheetWorkersFor, releaseWorkersFor, fulfillmentStatus } from '../production/production.service'
import { listPlannedMaterials, listPlannedMachines } from '../planning/planning.service'
import { products } from '../../db/schema/products.schema'
import { getTerms, getSetting, SETTING_KEYS } from '../settings.service'
import type { ServiceContext } from '../base/service.types'
import {
  parsePrintVisibility,
  type PrintVisibility,
  type PrintVisibilityKey
} from '@shared/documents/print-visibility'
import { isManufacturableOrderLine } from '../sales/order-line-manufacturing'

const fmtMoney = (minor: number): string => formatMoney(money(minor))
const fmtQty = (micro: number, unit?: string): string => formatQuantity(quantity(micro), unit)

/**
 * The one place per-field PDF visibility is applied.
 *
 * Both customer documents resolve their stored configuration once and
 * then build their DTO through these two helpers, so a hidden field is
 * simply ABSENT from the DTO the template receives — the template never
 * asks "may I print this?", exactly as it never asks "may I print a
 * cost?". The DTO stays the single enforcement boundary.
 *
 * Hiding is purely presentational: every figure below has already been
 * used by the service layer to compute the document's totals, and those
 * stored totals are what the PDF's final amount shows.
 */
function visible<T>(
  visibility: PrintVisibility,
  key: PrintVisibilityKey,
  value: T | null | undefined
): T | undefined {
  if (!visibility[key]) return undefined
  return value ?? undefined
}

/** Same rule for money rows, which additionally omit a zero charge. */
function visibleMoney(
  visibility: PrintVisibility,
  key: PrintVisibilityKey,
  minor: number
): string | undefined {
  if (!visibility[key] || minor <= 0) return undefined
  return fmtMoney(minor)
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Intl.DateTimeFormat('ar-LY-u-nu-latn', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC'
  }).format(new Date(iso))
}

export function companyBlock() {
  return {
    name: getSetting<string>(SETTING_KEYS.companyName),
    phone: getSetting<string>(SETTING_KEYS.companyPhone),
    address: getSetting<string>(SETTING_KEYS.companyAddress)
  }
}

function groupedMaterialColors(
  line: Partial<ItemSelections> & { materialType?: string | null; colorCode?: string | null },
  visibility: PrintVisibility,
  persisted?: ItemSelections
): { materialGroups: Array<{ material?: string; colors?: string }>; unmappedColors?: string } {
  const materials = line.selectedMaterials ?? (line.materialType ? [{ materialId: null, name: line.materialType }] : persisted?.selectedMaterials ?? [])
  const colors = line.selectedColors ?? (line.colorCode ? [{ colorId: null, code: line.colorCode, name: null }] : [])
  const groups = restoreSnapshotMaterialGroups(materials, colors, persisted)
  return {
    materialGroups: groups.map(m => ({
      material: visibility.materialType ? m.name : undefined,
      colors: visibility.colorCode ? (m.colors ?? []).map(colorSelectionLabel).join('، ') || undefined : undefined
    })).filter(g => g.material || g.colors),
    unmappedColors: visibility.colorCode ? unmappedItemColors({ selectedMaterials: groups, selectedColors: colors }).map(colorSelectionLabel).join('، ') || undefined : undefined
  }
}

/**
 * BR-71/BR-72/BR-73: the customer-facing Preliminary Invoice /
 * Quotation. Built into a CustomerDocumentDTO whose type has no cost,
 * machine, labour, supplier or profit fields at all — so no template
 * change can ever leak internal figures onto a customer document.
 */
export function buildPreliminaryInvoice(quotationId: number): CustomerDocumentDTO {
  const { quotation, lines } = getQuotation(quotationId)
  const currentCustomer = getDatabase()
    .select()
    .from(customers)
    .where(eq(customers.id, quotation.customerId))
    .get()
  if (!currentCustomer) throw notFound('العميل غير موجود')
  const customer = quotation.customerSnapshot ? JSON.parse(quotation.customerSnapshot) as { name: string; phone: string | null; address: string | null } : currentCustomer

  const terms: string[] = quotation.termsSnapshot
    ? (JSON.parse(quotation.termsSnapshot) as string[])
    : getTerms()

  // Resolved once; a legacy document (no stored configuration) resolves
  // to the defaults, which reproduce its original printed appearance.
  const pv = parsePrintVisibility(quotation.printVisibility)

  return {
    documentNumber: quotation.documentNumber,
    issuedAt: fmtDate(quotation.issuedAt ?? quotation.createdAt),
    customer: {
      name: customer.name,
      phone: visible(pv, 'customerPhone', customer.phone),
      address: visible(pv, 'customerAddress', customer.address)
    },
    lines: lines.map((line) => ({
      description: pv.description ? line.description : '',
      ...groupedMaterialColors(line, pv),
      specifications: visible(pv, 'specifications', line.specifications),
      dimensions: visible(pv, 'dimensions', line.dimensions),
      materialType: visible(pv, 'materialType', line.selectedMaterials?.map(m => m.name).join('، ') ?? line.materialType),
      colorCode: visible(pv, 'colorCode', line.selectedColors?.map(colorSelectionLabel).join('\n') ?? line.colorCode),
      accessories: visible(pv, 'accessories', line.selectedAccessories?.map(a => a.name).join('، ') ?? line.accessories),
      quantity: pv.quantity ? fmtQty(line.quantityMicro) : '',
      unitPrice: pv.unitPrice ? fmtMoney(line.unitPriceMinor) : '',
      lineTotal: pv.lineTotal ? fmtMoney(line.lineTotalMinor) : ''
    })),
    // Read straight from `pv` — not inferred from a line's formatted
    // text being empty — so the template can build the items table's
    // actual <thead>/<td> structure from this, instead of always
    // rendering all four columns with a blank value hidden inside one.
    itemColumns: {
      description: pv.description,
      quantity: pv.quantity,
      unitPrice: pv.unitPrice,
      lineTotal: pv.lineTotal
    },
    subtotal: pv.subtotal ? fmtMoney(quotation.subtotalMinor) : '',
    discount:
      pv.discount && quotation.discountMinor > 0 ? fmtMoney(quotation.discountMinor) : undefined,
    meterPrice: visibleMoney(pv, 'meterPrice', quotation.meterPriceMinor),
    installationPrice: visibleMoney(pv, 'installationPrice', quotation.installationPriceMinor),
    deliveryPrice: visibleMoney(pv, 'deliveryPrice', quotation.deliveryPriceMinor),
    // Always the document's real, stored total: hiding a charge row
    // above never reduces what the customer is asked to pay.
    totalAfterDiscount: fmtMoney(quotation.totalMinor),
    depositRequired: visible(pv, 'depositRequired', fmtMoney(quotation.depositRequiredMinor)),
    remainingBalance: visible(pv, 'remainingBalance', fmtMoney(quotation.remainingMinor)),
    validUntil:
      pv.validUntil && quotation.validUntil ? fmtDate(quotation.validUntil) : undefined,
    notes: visible(pv, 'notes', quotation.notes),
    // The business booleans decide truth; visibility may only suppress.
    includesInstallation: quotation.requiresInstallation && pv.includesInstallation,
    includesDelivery: quotation.requiresDelivery && pv.includesDelivery,
    termsAndConditions: pv.termsAndConditions ? terms : undefined
  }
}

const PAYMENT_STATUS_LABEL: Record<string, string> = {
  unpaid: 'غير مدفوع',
  partial: 'دفعة جزئية',
  deposit_met: 'المقدمة مكتملة',
  paid: 'مدفوع بالكامل'
}

const FULFILLMENT_LABEL: Record<string, string> = {
  not_delivered: 'لم يُسلَّم بعد',
  delivered: 'تم التوصيل',
  installed: 'تم التركيب',
  delivered_installed: 'تم التوصيل والتركيب',
  handed_over: 'تم التسليم'
}

/**
 * BR-63 + item 30/32/34: the Final Invoice.
 *
 * Takes a FINAL INVOICE id, not an order id — the document only exists
 * once it has been explicitly issued. Its commercial content comes from
 * the immutable snapshot frozen at issuance, so reprinting it years
 * later reproduces exactly what the customer was given. Paid/remaining
 * are the one deliberate exception: they are read live from the payment
 * ledger (item 33/35), so a reprint after a later collection shows the
 * true balance without the agreed terms ever changing.
 *
 * The return type is CustomerDocumentDTO, which structurally has no
 * cost, machine, labour or profit field — the customer-safety guarantee
 * is the type itself, not template discipline.
 */
export function buildFinalInvoice(finalInvoiceId: number): CustomerDocumentDTO {
  const { invoice, snapshot, payment, terms, lines: storedLines } = getFinalInvoice(finalInvoiceId)

  const pv = parsePrintVisibility(invoice.printVisibility)
  // Commercial values come from the frozen snapshot once the invoice is
  // approved, exactly like its lines and totals; a draft (and any
  // snapshot written before these fields existed) falls back to the
  // live invoice row, which defaults them to 0.
  const meterPriceMinor = snapshot.meterPriceMinor ?? invoice.meterPriceMinor
  const installationPriceMinor = snapshot.installationPriceMinor ?? invoice.installationPriceMinor
  const deliveryPriceMinor = snapshot.deliveryPriceMinor ?? invoice.deliveryPriceMinor
  const requiresInstallation = snapshot.requiresInstallation ?? invoice.requiresInstallation
  const requiresDelivery = snapshot.requiresDelivery ?? invoice.requiresDelivery

  return {
    documentNumber: invoice.documentNumber,
    // A draft approved invoice prints before it has an order: it shows
    // today's date and no order/fulfilment reference yet.
    issuedAt: fmtDate(invoice.issuedAt ?? invoice.createdAt),
    orderReference: snapshot.orderNumber || undefined,
    fulfillmentReference: invoice.orderId
      ? FULFILLMENT_LABEL[fulfillmentStatus(invoice.orderId)]
      : undefined,
    customer: {
      name: snapshot.customer.name,
      phone: visible(pv, 'customerPhone', snapshot.customer.phone),
      address: visible(pv, 'customerAddress', snapshot.customer.address)
    },
    lines: snapshot.lines.map((line, index) => ({
      description: pv.description ? line.description : '',
      ...groupedMaterialColors(line, pv, storedLines[index]),
      specifications: visible(pv, 'specifications', line.specifications),
      dimensions: visible(pv, 'dimensions', line.dimensions),
      materialType: visible(pv, 'materialType', line.selectedMaterials?.map(m => m.name).join('، ') ?? line.materialType ?? storedLines[index]?.selectedMaterials.map(m => m.name).join('، ')),
      colorCode: visible(pv, 'colorCode', line.selectedColors?.map(colorSelectionLabel).join('\n') ?? line.colorCode),
      accessories: visible(pv, 'accessories', line.selectedAccessories?.map(a => a.name).join('، ') ?? line.accessories),
      quantity: pv.quantity ? fmtQty(line.quantityMicro) : '',
      unitPrice: pv.unitPrice ? fmtMoney(line.unitPriceMinor) : '',
      lineTotal: pv.lineTotal ? fmtMoney(line.lineTotalMinor) : ''
    })),
    // See buildPreliminaryInvoice above — read straight from `pv`, not
    // inferred from a line's formatted text being empty.
    itemColumns: {
      description: pv.description,
      quantity: pv.quantity,
      unitPrice: pv.unitPrice,
      lineTotal: pv.lineTotal
    },
    subtotal: pv.subtotal ? fmtMoney(snapshot.subtotalMinor) : '',
    discount:
      pv.discount && snapshot.discountMinor > 0 ? fmtMoney(snapshot.discountMinor) : undefined,
    meterPrice: visibleMoney(pv, 'meterPrice', meterPriceMinor),
    installationPrice: visibleMoney(pv, 'installationPrice', installationPriceMinor),
    deliveryPrice: visibleMoney(pv, 'deliveryPrice', deliveryPriceMinor),
    // Always the agreed total — a hidden charge row never reduces it.
    totalAfterDiscount: fmtMoney(snapshot.totalMinor),
    paidAmount: fmtMoney(payment.paidMinor),
    remainingBalance: visible(pv, 'remainingBalance', fmtMoney(payment.remainingMinor)),
    paymentStatus: PAYMENT_STATUS_LABEL[payment.paymentStatus] ?? payment.paymentStatus,
    notes: visible(pv, 'notes', invoice.notes),
    // The business booleans decide truth; visibility may only suppress.
    includesInstallation: requiresInstallation && pv.includesInstallation,
    includesDelivery: requiresDelivery && pv.includesDelivery,
    // Item 11: ONLY the terms selected for this specific invoice — never
    // the whole global catalog (that automatic-inclusion behavior stays
    // exclusive to the Preliminary Invoice, above, untouched).
    termsAndConditions:
      pv.termsAndConditions && terms.length ? terms.map((term) => term.termText) : undefined
  }
}

/**
 * BR-64/BR-88: the internal Manufacturing Work Sheet. The cost block
 * is attached ONLY when the requesting session holds the costing
 * permission (BR-104) — the check happens here, before the template
 * ever sees a number.
 */
export function buildWorkSheet(workSheetId: number, ctx: ServiceContext): InternalWorkSheetDTO {
  const sheet = getDatabase().select().from(workSheets).where(eq(workSheets.id, workSheetId)).get()
  if (!sheet) throw notFound('أمر التصنيع غير موجود')
  if (sheet.status === 'reversed' && sheet.documentSnapshot) return { ...JSON.parse(sheet.documentSnapshot) as InternalWorkSheetDTO, status: 'reversed' }

  // Customer production reads its items from the order it is building.
  // Stock production has no customer order — its single item is the
  // standard product and the quantity being manufactured.
  const context = sheet.orderId ? getOrder(sheet.orderId) : undefined
  const product = sheet.productId
    ? getDatabase().select().from(products).where(eq(products.id, sheet.productId)).get()
    : undefined

  const items: InternalWorkSheetDTO['items'] = context
    ? context.lines.filter(isManufacturableOrderLine).map((line) => ({
        product: line.description,
        materialCategory: line.materialType ?? '',
        materialType: line.materialType ?? undefined,
        colorCode: line.colorCode ?? undefined,
        quantity: fmtQty(line.quantityMicro),
        dimensions: line.dimensions ?? undefined,
        specifications: line.specifications ?? undefined,
        accessories: line.accessories ? [line.accessories] : undefined
      }))
    : [
        {
          product: product?.name ?? '',
          materialCategory: '',
          quantity: fmtQty(sheet.quantityMicro)
        }
      ]

  const order = context?.order
  const fulfillment = order
    ? [order.requiresInstallation ? 'يشمل تركيباً' : null, order.requiresDelivery ? 'يشمل توصيلاً' : null]
        .filter(Boolean)
        .join(' — ')
    : undefined

  // ctx is kept in the signature because every document builder takes
  // it, but this document is deliberately permission-independent: it
  // has no cost block for a permission to gate.
  void ctx

  return {
    documentNumber: sheet.documentNumber,
    sourceLines: context?.lines.filter(isManufacturableOrderLine).map((line) => ({ id: line.id, description: line.description, quantityMicro: line.quantityMicro, dimensions: line.dimensions, colorCode: line.colorCode, accessories: line.accessories, specifications: line.specifications })),
    orderNumber: order?.documentNumber ?? 'إنتاج مخزون',
    customerReference: context?.customer?.name ?? 'مخزون المصنع',
    issuedAt: fmtDate(sheet.issuedAt),
    status: sheet.status,
    items,
    requiredMaterials: listPlannedMaterials({ workSheetId }).map((line) => ({
      material: line.materialName,
      quantity: fmtQty(line.qtyMicro),
      unit: line.unit ?? undefined,
      dimensions: line.dimensions ?? undefined,
      thickness: line.thickness ?? undefined,
      colorCode: line.colorCode ?? undefined,
      notes: line.notes ?? undefined
    })),
    // The machine half of the same manufacturing snapshot. Names and
    // planned usage only — actual machine usage and its cost are a
    // separate internal record and never reach this document.
    requiredMachines: listPlannedMachines({ workSheetId }).map((line) => ({
      machine: line.machineName,
      usage: line.usageQtyMicro > 0
        ? `${fmtQty(line.usageQtyMicro)}${line.usageUnit ? ` ${line.usageUnit}` : ''}`
        : undefined,
      notes: line.notes ?? undefined
    })),
    assignedWorkers: workSheetWorkersFor(workSheetId).map((worker) => worker.name),
    manufacturingNotes: sheet.notes ?? order?.notes ?? undefined,
    fulfillmentRequirement: fulfillment || undefined
  }
}

/**
 * BR-83/BR-112: Installation Authorization and Delivery/Handover
 * Release. New permits render exclusively from their immutable issuance
 * snapshot. Legacy rows retain the previous live-balance fallback and
 * are never reclassified as management overrides.
 */
export function buildRelease(releaseId: number): InternalReleaseDTO {
  const release = getDatabase().select().from(releases).where(eq(releases.id, releaseId)).get()
  if (!release) throw notFound('إذن الخروج غير موجود')
  if (release.status === 'reversed' && release.documentSnapshot) return { ...JSON.parse(release.documentSnapshot) as InternalReleaseDTO, reversed: true }
  const { order, customer, lines } = getOrder(release.orderId)
  const authorizationType = release.authorizationType === 'fully_paid'
    || release.authorizationType === 'unpaid_override'
    || release.authorizationType === 'unpaid'
    ? release.authorizationType
    : 'legacy'
  const balanceConfirmedPaid = authorizationType === 'fully_paid'
    ? true
    : authorizationType === 'unpaid_override' || authorizationType === 'unpaid'
      ? false
      : order.paidMinor >= order.totalMinor

  return {
    kind: release.kind as InternalReleaseDTO['kind'],
    documentNumber: release.documentNumber,
    orderNumber: order.documentNumber,
    customerName: customer?.name ?? '',
    items: lines.map(
      (line) =>
        `${line.description}${line.dimensions ? ` — ${line.dimensions}` : ''}${line.colorCode ? ` — كود اللون: ${line.colorCode}` : ''}`
    ),
    dimensions: lines.map((line) => line.dimensions).filter(Boolean).join(' / ') || undefined,
    materialType: lines.map((line) => line.materialType).filter(Boolean).join(' / ') || undefined,
    colorCode: lines.map((line) => line.colorCode).filter(Boolean).join(' / ') || undefined,
    address: release.address ?? order.address ?? undefined,
    assignedWorkers: releaseWorkersFor(releaseId).map((worker) => worker.name),
    notes: release.notes ?? undefined,
    authorizationType,
    balanceConfirmedPaid,
    // Null/missing legacy values preserve the historical visible default.
    showPaidExitSentence: release.showPaidExitSentence ?? true,
    orderTotalAtIssue: release.orderTotalMinorAtIssue === null
      ? undefined
      : fmtMoney(release.orderTotalMinorAtIssue),
    paidAtIssue: release.paidMinorAtIssue === null
      ? undefined
      : fmtMoney(release.paidMinorAtIssue),
    remainingAtIssue: release.remainingMinorAtIssue === null
      ? undefined
      : fmtMoney(release.remainingMinorAtIssue),
    authorizedAt: fmtDate(release.authorizedAt)
  }
}
