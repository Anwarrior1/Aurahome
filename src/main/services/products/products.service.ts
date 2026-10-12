import { and, asc, eq, like, sql } from 'drizzle-orm'
import { getDatabase, getRawConnection } from '../../db/connection'
import { withTransaction } from '../../db/transactions'
import { products, productBomLines } from '../../db/schema/products.schema'
import { materials } from '../../db/schema/catalog.schema'
import { machines, workers, productMachineLines, productCommissionLines } from '../../db/schema/production.schema'
import { AppError, notFound } from '../../utils/errors'
import { recordAuditEvent } from '../../audit/audit-log.service'
import { requirePermission } from '../../permissions/permission-guard'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { nowIso, type ServiceContext } from '../base/service.types'
import { costOf, unitCostMicro } from '@shared/money/cost'
import { commercialQuantityFor } from '../inventory/inventory.service'
import {
  requireSafeInteger,
  requireSafeNonNegativeInteger,
  requireSafePositiveInteger
} from '../../utils/numeric'

export interface BomLineInput {
  materialId: number
  qtyMicro: number
  unit: string
  dimensions?: string | null
  componentName?: string | null
  /** Overrides the material's current market price for THIS product's
   *  cost estimate; null/omitted falls back to that live price. */
  unitPriceMicro?: number | null
  notes?: string | null
}

/** Product Components — "الآلات" tab: standard usage for ONE unit. */
export interface ProductMachineLineInput {
  machineId: number
  usageQtyMicro: number
  /** Overrides the machine's own default rate for this product. */
  rateMicro?: number | null
  notes?: string | null
}

/** Product Components — "عمولة العامل" tab: standard commission for ONE unit. */
export interface ProductCommissionLineInput {
  workerId?: number | null
  amountMinor: number
  notes?: string | null
}

export function listProducts(filter: { search?: string; activeOnly?: boolean } = {}) {
  const clauses = []
  if (filter.search?.trim()) {
    const p = `%${filter.search.trim()}%`
    clauses.push(like(products.name, p))
  }
  if (filter.activeOnly) clauses.push(eq(products.active, true))
  return getDatabase()
    .select()
    .from(products)
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(asc(products.name))
    .all()
}

export function getProduct(id: number) {
  const product = getDatabase().select().from(products).where(eq(products.id, id)).get()
  if (!product) throw notFound('المنتج غير موجود')
  return {
    product,
    bom: getBom(id),
    machines: getProductMachines(id),
    commission: getProductCommission(id),
    cost: productManufacturingCost(id)
  }
}

/** BR-2: the BOM is fully user-editable at any time. */
export function getBom(productId: number) {
  return getDatabase()
    .select({
      id: productBomLines.id,
      materialId: productBomLines.materialId,
      materialName: materials.name,
      materialSku: materials.sku,
      qtyMicro: productBomLines.qtyMicro,
      unit: productBomLines.unit,
      dimensions: productBomLines.dimensions,
      componentName: productBomLines.componentName,
      unitPriceMicro: productBomLines.unitPriceMicro,
      /** The material's own live price — the fallback when
       *  `unitPriceMicro` is unset, shown alongside it the same way the
       *  machines tab shows a machine's `defaultRateMicro`. */
      materialPriceMicro: materials.currentMarketPriceMicro,
      notes: productBomLines.notes
    })
    .from(productBomLines)
    .innerJoin(materials, eq(productBomLines.materialId, materials.id))
    .where(eq(productBomLines.productId, productId))
    .all()
}

/** Product Components — "الآلات" tab: the product's standard machine list. */
export function getProductMachines(productId: number) {
  return getDatabase()
    .select({
      id: productMachineLines.id,
      machineId: productMachineLines.machineId,
      machineName: machines.name,
      costingUnit: machines.costingUnit,
      usageQtyMicro: productMachineLines.usageQtyMicro,
      rateMicro: productMachineLines.rateMicro,
      defaultRateMicro: machines.defaultRateMicro,
      notes: productMachineLines.notes
    })
    .from(productMachineLines)
    .innerJoin(machines, eq(productMachineLines.machineId, machines.id))
    .where(eq(productMachineLines.productId, productId))
    .all()
}

/** Product Components — "عمولة العامل" tab: the product's standard commission list. */
export function getProductCommission(productId: number) {
  return getDatabase()
    .select({
      id: productCommissionLines.id,
      workerId: productCommissionLines.workerId,
      workerName: workers.name,
      amountMinor: productCommissionLines.amountMinor,
      notes: productCommissionLines.notes
    })
    .from(productCommissionLines)
    .leftJoin(workers, eq(productCommissionLines.workerId, workers.id))
    .where(eq(productCommissionLines.productId, productId))
    .all()
}

export interface ProductManufacturingCost {
  materialCostMinor: number
  machineCostMinor: number
  commissionCostMinor: number
  manufacturingCostMinor: number
}

/**
 * BR-11/BR-32: a material line's estimated cost respects the SAME
 * consumption/pricing policy `commercialQuantityFor` already applies
 * when charging a customer — a material configured `full_unit` or
 * `round_up` charges/consumes a whole unit even for a partial
 * requirement, and the estimate must reflect that, never a blind
 * qty × price. `manual` has no product-template equivalent (it needs a
 * per-order manual quantity), so it falls back to the physical
 * quantity, same as an `exact` material.
 */
function estimatedMaterialLineCostMinor(
  material: { pricingRule: string; commercialUnitSizeMicro: number | null; unit: string },
  line: { qtyMicro: number; unitPriceMicro: number | null; materialPriceMicro: number }
): number {
  const price = line.unitPriceMicro ?? line.materialPriceMicro
  const chargeableQtyMicro =
    material.pricingRule === 'manual' ? line.qtyMicro : commercialQuantityFor(material, line.qtyMicro).qtyMicro
  return costOf(chargeableQtyMicro, unitCostMicro(price))
}

/**
 * Item 7: the STANDARD manufacturing cost for one unit of a product,
 * kept structurally separate by component — material (BOM valued at
 * each line's own price, or the material's current market price when
 * unset, under the material's existing consumption policy), machine
 * (standard usage × rate), and worker commission. This is an ESTIMATE
 * for display only; it never posts anything and actual cost always
 * comes from the real production postings (FIFO consumption, machine
 * usage, worker assignments) — a later edit here never rewrites an
 * already-issued Manufacturing Order's own historical cost (BR-46 —
 * that snapshot lives entirely outside this function).
 */
export function productManufacturingCost(productId: number): ProductManufacturingCost {
  const db = getDatabase()

  const materialCostMinor = getBom(productId).reduce((sum, line) => {
    const material = db.select().from(materials).where(eq(materials.id, line.materialId)).get()
    if (!material) return sum
    return sum + estimatedMaterialLineCostMinor(material, line)
  }, 0)

  const machineCostMinor = getProductMachines(productId).reduce((sum, line) => {
    const rate = line.rateMicro ?? line.defaultRateMicro
    return sum + costOf(line.usageQtyMicro, unitCostMicro(rate))
  }, 0)

  const commissionCostMinor = getProductCommission(productId).reduce(
    (sum, line) => sum + line.amountMinor,
    0
  )

  return {
    materialCostMinor,
    machineCostMinor,
    commissionCostMinor,
    manufacturingCostMinor: materialCostMinor + machineCostMinor + commissionCostMinor
  }
}

export function createProduct(
  input: {
    code: string
    name: string
    description?: string
    defaultPriceMinor?: number
    bom?: BomLineInput[]
    machines?: ProductMachineLineInput[]
    commission?: ProductCommissionLineInput[]
  },
  ctx: ServiceContext
): number {
  requirePermission(ctx.session, P.products.manage)
  requireSafeInteger(input.defaultPriceMinor ?? 0, 'السعر الافتراضي')
  return withTransaction(() => {
    const id = Number(
      getDatabase()
        .insert(products)
        .values({
          code: input.code,
          name: input.name,
          description: input.description ?? null,
          defaultPriceMinor: input.defaultPriceMinor ?? 0,
          createdAt: nowIso()
        })
        .run().lastInsertRowid
    )
    if (input.bom?.length) replaceBomInternal(id, input.bom)
    if (input.machines?.length) replaceProductMachinesInternal(id, input.machines)
    if (input.commission?.length) replaceProductCommissionInternal(id, input.commission)
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'products.create',
      entity: 'products',
      entityId: String(id),
      details: { code: input.code, name: input.name }
    })
    return id
  })
}

export function updateProduct(
  id: number,
  input: { code?: string; name?: string; description?: string; defaultPriceMinor?: number; active?: boolean },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.products.manage)
  return withTransaction(() => {
    if (input.defaultPriceMinor !== undefined) requireSafeInteger(input.defaultPriceMinor, 'السعر الافتراضي')
    if (!getDatabase().select().from(products).where(eq(products.id, id)).get()) {
      throw notFound('المنتج غير موجود')
    }
    getDatabase().update(products).set({ ...input }).where(eq(products.id, id)).run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'products.update',
      entity: 'products',
      entityId: String(id),
      details: input
    })
  })
}

/**
 * BR-46: editing a master BOM is always safe — quotations and orders
 * hold their own snapshot copy, so historical documents never change.
 */
export function replaceBom(productId: number, lines: BomLineInput[], ctx: ServiceContext): void {
  requirePermission(ctx.session, P.products.manage)
  if (!getDatabase().select().from(products).where(eq(products.id, productId)).get()) {
    throw notFound('المنتج غير موجود')
  }
  withTransaction(() => {
    replaceBomInternal(productId, lines)
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'products.bom.replace',
      entity: 'product_bom_lines',
      entityId: String(productId),
      details: { lineCount: lines.length }
    })
  })
}

function replaceBomInternal(productId: number, lines: BomLineInput[]): void {
  const db = getDatabase()
  db.delete(productBomLines).where(eq(productBomLines.productId, productId)).run()
  for (const line of lines) {
    requireSafePositiveInteger(line.qtyMicro, 'كمية المادة')
    if (line.unitPriceMicro !== null && line.unitPriceMicro !== undefined)
      requireSafeNonNegativeInteger(line.unitPriceMicro, 'سعر المادة')
    if (!db.select().from(materials).where(eq(materials.id, line.materialId)).get()) {
      throw notFound('إحدى المواد في قائمة المكونات غير موجودة')
    }
    db.insert(productBomLines)
      .values({
        productId,
        materialId: line.materialId,
        qtyMicro: line.qtyMicro,
        unit: line.unit,
        dimensions: line.dimensions ?? null,
        componentName: line.componentName ?? null,
        unitPriceMicro: line.unitPriceMicro ?? null,
        notes: line.notes ?? null
      })
      .run()
  }
}

/**
 * Product Components — "الآلات" tab. Same safety property as the BOM:
 * a full atomic replace (never an incremental append), so there is no
 * way for a resubmit/double-click to create a duplicate row, and
 * historical work sheets already snapshotted are never touched.
 */
export function replaceProductMachines(
  productId: number,
  lines: ProductMachineLineInput[],
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.products.manage)
  if (!getDatabase().select().from(products).where(eq(products.id, productId)).get()) {
    throw notFound('المنتج غير موجود')
  }
  withTransaction(() => {
    replaceProductMachinesInternal(productId, lines)
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'products.machines.replace',
      entity: 'product_machine_lines',
      entityId: String(productId),
      details: { lineCount: lines.length }
    })
  })
}

function replaceProductMachinesInternal(productId: number, lines: ProductMachineLineInput[]): void {
  const db = getDatabase()
  db.delete(productMachineLines).where(eq(productMachineLines.productId, productId)).run()
  for (const line of lines) {
    requireSafePositiveInteger(line.usageQtyMicro, 'كمية استخدام الآلة')
    if (line.rateMicro !== null && line.rateMicro !== undefined)
      requireSafeNonNegativeInteger(line.rateMicro, 'سعر الآلة')
    if (!db.select().from(machines).where(eq(machines.id, line.machineId)).get()) {
      throw notFound('إحدى الآلات في قائمة الآلات غير موجودة')
    }
    db.insert(productMachineLines)
      .values({
        productId,
        machineId: line.machineId,
        usageQtyMicro: line.usageQtyMicro,
        rateMicro: line.rateMicro ?? null,
        notes: line.notes ?? null,
        createdAt: nowIso()
      })
      .run()
  }
}

/**
 * Product Components — "عمولة العامل" tab. Saving this NEVER pays
 * anyone: it is the standard rule/value only. The full-replace pattern
 * again rules out a duplicate row from a resubmit.
 */
export function replaceProductCommission(
  productId: number,
  lines: ProductCommissionLineInput[],
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.products.manage)
  if (!getDatabase().select().from(products).where(eq(products.id, productId)).get()) {
    throw notFound('المنتج غير موجود')
  }
  withTransaction(() => {
    replaceProductCommissionInternal(productId, lines)
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'products.commission.replace',
      entity: 'product_commission_lines',
      entityId: String(productId),
      details: { lineCount: lines.length }
    })
  })
}

function replaceProductCommissionInternal(productId: number, lines: ProductCommissionLineInput[]): void {
  const db = getDatabase()
  db.delete(productCommissionLines).where(eq(productCommissionLines.productId, productId)).run()
  for (const line of lines) {
    requireSafePositiveInteger(line.amountMinor, 'قيمة عمولة العامل')
    if (line.workerId === null || line.workerId === undefined)
      throw new AppError('VALIDATION_ERROR', 'اختر عاملاً لعمولة تصنيع المنتج القياسي')
    if (!db.select().from(workers).where(eq(workers.id, line.workerId)).get())
      throw notFound('العامل المحدد للعمولة غير موجود')
    db.insert(productCommissionLines)
      .values({
        productId,
        workerId: line.workerId,
        amountMinor: line.amountMinor,
        notes: line.notes ?? null,
        createdAt: nowIso()
      })
      .run()
  }
}

/** The immutable JSON copy stored on a quotation/order line (BR-46). */
export function buildBomSnapshot(productId: number): string {
  return JSON.stringify({
    capturedAt: nowIso(),
    productId,
    lines: getBom(productId).map((line) => ({
      materialId: line.materialId,
      materialName: line.materialName,
      materialSku: line.materialSku,
      qtyMicro: line.qtyMicro,
      unit: line.unit,
      dimensions: line.dimensions,
      componentName: line.componentName,
      notes: line.notes
    }))
  })
}

export interface ProductFullDeletePreview {
  productId: number
  code: string
  name: string
  dependencies: Array<{ key: string; label: string; count: number }>
  blockers: string[]
}

function scalarCount(query: ReturnType<typeof sql>): number {
  return getDatabase().get<{ c: number }>(query)?.c ?? 0
}

/**
 * The two references a Standard Product cannot lose and still leave a
 * truthful record behind — unlike the quotation/order/approved-invoice
 * lines below, neither has a frozen snapshot to fall back on:
 *
 *  • `finished_goods_movements` is the append-only finished-goods
 *    ledger (item 18/19) — its `product_id` is NOT NULL with no
 *    cascade, exactly like `inventory_movements` for a raw material,
 *    and for the same reason: it is real, already-posted inventory
 *    history, never rewritten or orphaned.
 *  • `work_sheets` rows with their OWN `product_id` set are STOCK
 *    production orders (issueWorkSheet's "no customer order" shape) —
 *    the only place they record which product they are for. They
 *    carry no frozen product name/code of their own the way an order
 *    line does, so nulling the link would silently blank out an
 *    existing or completed production order's own identity. An open
 *    one is also the literal "active/in-progress production" case:
 *    completing it still reads `sheet.productId` to know what to post
 *    to finished goods (production.service.ts), so it must keep it.
 */
function productProductionBlockers(productId: number): string[] {
  const blockers: string[] = []
  if (scalarCount(sql`SELECT COUNT(*) AS c FROM finished_goods_movements WHERE product_id = ${productId}`) > 0) {
    blockers.push('توجد حركات مخزون بضاعة تامة مسجلة فعلياً لهذا المنتج — لا يمكن حذفه نهائياً، يمكن تعطيله بدلاً من ذلك')
  }
  if (scalarCount(sql`SELECT COUNT(*) AS c FROM work_sheets WHERE product_id = ${productId}`) > 0) {
    blockers.push('توجد أوامر تصنيع لإنتاج مخزون مرتبطة مباشرة بهذا المنتج — لا يمكن حذفه نهائياً، يمكن تعطيله بدلاً من ذلك')
  }
  return blockers
}

/**
 * Discovers everything caused BY this product master — its own owned
 * configuration (BOM/machines/commission, all `onDelete: 'cascade'` in
 * the schema) and every historical document line that once named it —
 * without mutating anything. Quotation/order/approved-invoice lines
 * each carry their OWN frozen description/specifications/dimensions/
 * price/BOM-snapshot (BR-46) — deleting the product only releases
 * their soft, nullable `product_id` back-reference (item 8's pattern,
 * exactly as `fullDeleteMaterial` already does for those same three
 * tables), never their own historical content.
 */
export function productFullDeletePreview(id: number): ProductFullDeletePreview {
  const product = getDatabase().select().from(products).where(eq(products.id, id)).get()
  if (!product) throw notFound('المنتج غير موجود')

  const counts = {
    bomLines: scalarCount(sql`SELECT COUNT(*) AS c FROM product_bom_lines WHERE product_id = ${id}`),
    machineLines: scalarCount(sql`SELECT COUNT(*) AS c FROM product_machine_lines WHERE product_id = ${id}`),
    commissionLines: scalarCount(sql`SELECT COUNT(*) AS c FROM product_commission_lines WHERE product_id = ${id}`),
    quotationLines: scalarCount(sql`SELECT COUNT(*) AS c FROM quotation_lines WHERE product_id = ${id}`),
    orderLines: scalarCount(sql`SELECT COUNT(*) AS c FROM order_lines WHERE product_id = ${id}`),
    finalInvoiceLines: scalarCount(sql`SELECT COUNT(*) AS c FROM final_invoice_lines WHERE product_id = ${id}`),
    finishedGoodsMovements: scalarCount(sql`SELECT COUNT(*) AS c FROM finished_goods_movements WHERE product_id = ${id}`),
    stockWorkSheets: scalarCount(sql`SELECT COUNT(*) AS c FROM work_sheets WHERE product_id = ${id}`)
  }
  const labels: Record<keyof typeof counts, string> = {
    bomLines: 'مكونات المواد (قائمة المواد الحالية)',
    machineLines: 'إعدادات الآلات الحالية',
    commissionLines: 'إعدادات عمولة العامل الحالية',
    quotationLines: 'بنود فواتير مبدئية سابقة',
    orderLines: 'بنود طلبات عملاء سابقة',
    finalInvoiceLines: 'بنود فواتير معتمدة سابقة',
    finishedGoodsMovements: 'حركات مخزون بضاعة تامة',
    stockWorkSheets: 'أوامر تصنيع لإنتاج مخزون'
  }
  const dependencies = (Object.keys(counts) as Array<keyof typeof counts>)
    .filter((key) => counts[key] > 0)
    .map((key) => ({ key, label: labels[key], count: counts[key] }))

  return {
    productId: id,
    code: product.code,
    name: product.name,
    dependencies,
    blockers: [...new Set(productProductionBlockers(id))]
  }
}

/**
 * Permanent delete of a Standard Product master — never a disguised
 * disable. Its OWN current configuration (BOM/machine/commission
 * lines) cascades away with it at the schema level; every historical
 * quotation/order/approved-invoice line that once named it keeps its
 * own frozen content and just loses the live `product_id` link,
 * exactly like `fullDeleteMaterial` already does for a raw material.
 * Blocked outright — never silently corrupted — when real, already-
 * posted finished-goods inventory or a stock-production order still
 * needs the live link (see `productProductionBlockers`).
 */
export function fullDeleteProduct(
  input: { id: number; confirmation: string },
  ctx: ServiceContext
): { removed: true; summary: Record<string, number> } {
  requirePermission(ctx.session, P.products.fullDelete)
  const product = getDatabase().select().from(products).where(eq(products.id, input.id)).get()
  if (!product) throw notFound('المنتج غير موجود')
  if (input.confirmation.trim() !== product.code.trim()) {
    throw new AppError('VALIDATION_ERROR', `اكتب كود المنتج "${product.code}" لتأكيد الحذف النهائي`)
  }
  const preview = productFullDeletePreview(input.id)
  if (preview.blockers.length) {
    throw new AppError('CONFLICT', `تعذر حذف المنتج نهائياً لحماية السجل التاريخي: ${preview.blockers.join('، ')}`)
  }

  return withTransaction(() => {
    // Re-derived inside the open transaction rather than trusting the
    // preview above, matching every other full-delete in this ERP — a
    // change between preview and execution is caught, never acted on.
    const fresh = productFullDeletePreview(input.id)
    if (fresh.blockers.length) {
      throw new AppError('CONFLICT', `تعذر حذف المنتج نهائياً لحماية السجل التاريخي: ${fresh.blockers.join('، ')}`)
    }
    const raw = getRawConnection()

    // Historical document lines: release the live link only, every
    // frozen field on the row (description/specifications/dimensions/
    // price/bomSnapshot) is untouched.
    raw.prepare('UPDATE quotation_lines SET product_id = NULL WHERE product_id = ?').run(input.id)
    raw.prepare('UPDATE order_lines SET product_id = NULL WHERE product_id = ?').run(input.id)
    raw.prepare('UPDATE final_invoice_lines SET product_id = NULL WHERE product_id = ?').run(input.id)

    // The product's own current configuration — product_bom_lines,
    // product_machine_lines, product_commission_lines — all declare
    // `onDelete: 'cascade'` on product_id and are removed by SQLite
    // itself the moment the product row goes (foreign_keys = ON is
    // applied on every connection — see db/pragmas.ts).
    raw.prepare('DELETE FROM products WHERE id = ?').run(input.id)

    const summary = Object.fromEntries(fresh.dependencies.map((item) => [item.key, item.count])) as Record<string, number>
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'products.full_delete',
      entity: 'products',
      entityId: String(input.id),
      details: {
        fullDelete: true,
        description: `Full Standard Product deletion (${product.name} #${input.id})`,
        code: product.code,
        name: product.name,
        summary
      }
    })
    return { removed: true, summary }
  })
}
