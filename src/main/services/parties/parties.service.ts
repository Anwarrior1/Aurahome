import { getTableColumns, and, asc, eq, isNull, like, or, sql, type SQL } from 'drizzle-orm'
import { PAGE_SIZE, type CursorPage } from '@shared/pagination/cursor-page'
import {
  idList,
  keysetBoundary,
  keysetOrder,
  keysetPage,
  normalizedSearch,
  seekOrder,
  seekPredicate,
  type KeysetWindow,
  type PageRequest,
  type SeekColumn
} from '../base/pagination'
import { getDatabase, getRawConnection } from '../../db/connection'
import { withTransaction } from '../../db/transactions'
import { customers, suppliers, purchases, supplierPayments } from '../../db/schema/parties.schema'
import { orders } from '../../db/schema/sales.schema'
import {paymentHistoryRows, paymentHistoryColumns, type PaymentHistoryEntry} from '../sales/payment-history'
import { AppError, notFound } from '../../utils/errors'
import { recordAuditEvent } from '../../audit/audit-log.service'
import { hasPermission, requirePermission } from '../../permissions/permission-guard'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { nowIso, type ServiceContext } from '../base/service.types'
import { removeCashMovementForRef } from '../finance/cash.service'
import { purchaseFullDeletePreview, performFullDeletePurchase } from '../purchasing/purchasing.service'

export interface PartyInput {
  name: string
  phone?: string | null
  address?: string | null
  notes?: string | null
  active?: boolean
}

/** Balance figures for a bounded set of customers (same rule as customerBalances). */
function balancesForCustomers(ids: number[]) {
  if (!ids.length) return new Map<number, { orderCount: number; totalMinor: number; paidMinor: number; remainingMinor: number }>()
  return new Map(
    getDatabase().all<{ customerId: number; orderCount: number; totalMinor: number; paidMinor: number; remainingMinor: number }>(sql`
      SELECT c.id AS customerId,
             COUNT(o.id) AS orderCount,
             COALESCE(SUM(o.total_minor), 0) AS totalMinor,
             COALESCE(SUM(o.paid_minor), 0) AS paidMinor,
             COALESCE(SUM(o.total_minor - o.paid_minor), 0) AS remainingMinor
      FROM customers c
      LEFT JOIN orders o ON o.customer_id = c.id AND o.status IN ('confirmed', 'completed')
      WHERE c.id IN (${idList(ids)})
      GROUP BY c.id
    `).map((row) => [row.customerId, row])
  )
}

/**
 * Customers grow with sales, so the master list is a bounded, search-driven
 * page ordered by name (id breaks ties). Each row carries its authoritative
 * order balance so the screen never joins against a second unbounded list.
 */
export function listCustomers(
  filter: { search?: string; activeOnly?: boolean; state?: 'active' | 'archived' } = {},
  request: PageRequest = {}
) {
  const normalized = {
    active: filter.state !== 'archived' || filter.activeOnly === true,
    search: normalizedSearch(filter.search)
  }
  const clauses: SQL[] = [eq(customers.active, normalized.active)]
  if (normalized.search) {
    const p = `%${normalized.search}%`
    clauses.push(or(like(customers.name, p), like(customers.phone, p))!)
  }
  return keysetPage({
    scope: 'customers.list',
    filters: normalized,
    request,
    keyTypes: ['text', 'int'],
    order: 'asc',
    keyOf: (row) => [row.name, row.id],
    fetch: (window: KeysetWindow) => {
      const rows = getDatabase()
        .select({ ...getTableColumns(customers), hasHistory: sql<boolean>`EXISTS(SELECT 1 FROM quotations q WHERE q.customer_id = ${customers.id}) OR EXISTS(SELECT 1 FROM orders o WHERE o.customer_id = ${customers.id}) OR EXISTS(SELECT 1 FROM final_invoices f WHERE f.customer_id = ${customers.id})`.mapWith(Boolean) })
        .from(customers)
        .where(and(...clauses, keysetBoundary([sql`${customers.name}`, sql`${customers.id}`], window)))
        .orderBy(keysetOrder([sql`${customers.name}`, sql`${customers.id}`], window))
        .limit(window.take)
        .all()
      const balances = balancesForCustomers(rows.map((row) => row.id))
      return rows.map((row) => {
        const balance = balances.get(row.id)
        return {
          ...row,
          orderCount: balance?.orderCount ?? 0,
          totalMinor: balance?.totalMinor ?? 0,
          paidMinor: balance?.paidMinor ?? 0,
          remainingMinor: balance?.remainingMinor ?? 0
        }
      })
    },
    summary: () => ({
      totalCount: getDatabase()
        .select({ totalCount: sql<number>`COUNT(*)` })
        .from(customers)
        .where(and(...clauses))
        .get()?.totalCount ?? 0
    })
  })
}

export function createCustomer(input: PartyInput, ctx: ServiceContext): number {
  requirePermission(ctx.session, P.customers.manage)
  return withTransaction(() => {
    const id = Number(
      getDatabase().insert(customers).values({ ...input, createdAt: nowIso() }).run().lastInsertRowid
    )
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'customers.create',
      entity: 'customers',
      entityId: String(id),
      details: { name: input.name }
    })
    return id
  })
}

/** Only starting new business requires an active master; historical reads/payments do not. */
export function requireActiveCustomer(id: number) {
  const customer = getDatabase().select().from(customers).where(eq(customers.id, id)).get()
  if (!customer) throw notFound('العميل غير موجود')
  if (!customer.active) throw new AppError('CONFLICT', 'العميل مؤرشف ولا يمكن بدء معاملة جديدة معه. استعد العميل أولاً')
  return customer
}

function setCustomerLifecycle(id: number, active: boolean, ctx: ServiceContext): void {
  withTransaction(() => {
    const customer = getDatabase().select().from(customers).where(eq(customers.id, id)).get()
    if (!customer) throw notFound('العميل غير موجود')
    if (customer.active === active) return
    getDatabase().update(customers).set({ active }).where(eq(customers.id, id)).run()
    recordAuditEvent({ userId: ctx.session.user.id, action: active ? 'customers.restore' : 'customers.archive', entity: 'customers', entityId: String(id), details: { name: customer.name, before: customer.active ? 'active' : 'archived', after: active ? 'active' : 'archived' } })
  })
}
export function archiveCustomer(id: number, ctx: ServiceContext): void {
  requirePermission(ctx.session, P.customers.archive)
  setCustomerLifecycle(id, false, ctx)
}
export function restoreCustomer(id: number, ctx: ServiceContext): void {
  requirePermission(ctx.session, P.customers.archive)
  setCustomerLifecycle(id, true, ctx)
}

export function updateCustomer(id: number, input: Partial<PartyInput>, ctx: ServiceContext): void {
  const existing = getDatabase().select().from(customers).where(eq(customers.id, id)).get()
  if (!existing) throw notFound('العميل غير موجود')
  requirePermission(ctx.session, P.customers.manage)
  const { active, ...details } = input
  withTransaction(() => {
    if (Object.values(details).some(value => value !== undefined)) getDatabase().update(customers).set(details).where(eq(customers.id, id)).run()
    if (active !== undefined) setCustomerLifecycle(id, active, ctx)

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'customers.update',
      entity: 'customers',
      entityId: String(id),
      details: input
    })
  })
}

/**
 * Item 8 (Step-4 follow-up): a customer is ordinary user-entered
 * master data and may be deleted, but never if that would orphan a
 * quotation, order, or payment record — those stay protected exactly
 * as listed in the safety rules.
 */
export function deleteCustomer(id: number, ctx: ServiceContext, confirmation?: string): void {
  requirePermission(ctx.session, P.customers.manage)
  withTransaction(() => {
  const customer = getDatabase().select().from(customers).where(eq(customers.id, id)).get()

  if (!customer) throw notFound('العميل غير موجود')
  const quotationCount = getDatabase()
    .get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM quotations WHERE customer_id = ${id}`)?.c ?? 0
  const orderCount = getDatabase()
    .get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM orders WHERE customer_id = ${id}`)?.c ?? 0
  // The approved invoice owns its customer directly since the workflow
  // pass, so it protects the customer in its own right — a draft
  // invoice exists before any order does.
  const invoiceCount = getDatabase()
    .get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM final_invoices WHERE customer_id = ${id}`)?.c ?? 0
  const paymentCount = getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM customer_payments WHERE customer_id = ${id}`)?.c ?? 0
  if (quotationCount > 0 || orderCount > 0 || invoiceCount > 0 || paymentCount > 0) {
    throw new AppError(
      'CONFLICT',
      'لا يمكن حذف هذا العميل لوجود فواتير أو طلبات مرتبطة به. استخدم أرشفة العميل مع حفظ جميع معاملاته السابقة'
    )
  }
  if (customer && confirmation?.trim() !== customer.name.trim()) throw new AppError('VALIDATION_ERROR', 'اكتب اسم العميل لتأكيد الحذف النهائي')
  getDatabase().delete(customers).where(eq(customers.id, id)).run()
  recordAuditEvent({
    userId: ctx.session.user.id,
    action: 'customers.delete',
    entity: 'customers',
    entityId: String(id),
    details: { name: customer?.name }
  })
  })
}

/** BR-23: outstanding balance per customer, from confirmed orders. */
export function customerBalances(search?: string, customerId?: number) {
  return getDatabase().all<{
    customerId: number
    name: string
    phone: string | null
    orderCount: number
    totalMinor: number
    paidMinor: number
    remainingMinor: number
  }>(sql`
    SELECT c.id AS customerId, c.name, c.phone,
           COUNT(o.id) AS orderCount,
           COALESCE(SUM(o.total_minor), 0) AS totalMinor,
           COALESCE(SUM(o.paid_minor), 0) AS paidMinor,
           COALESCE(SUM(o.total_minor - o.paid_minor), 0) AS remainingMinor
    FROM customers c
    LEFT JOIN orders o ON o.customer_id = c.id AND o.status IN ('confirmed', 'completed')
    ${customerId !== undefined ? sql`WHERE c.id = ${customerId}` : search?.trim() ? sql`WHERE c.name LIKE ${'%' + search.trim() + '%'} OR c.phone LIKE ${'%' + search.trim() + '%'}` : sql``}
    GROUP BY c.id
    ORDER BY remainingMinor DESC, c.name ASC
  `)
}

/** Bounded receivables ranking for interactive use; reports keep customerBalances(). */
export function customerBalancesPage(filter: { search?: string } = {}, request: PageRequest = {}) {
  const normalized = { search: normalizedSearch(filter.search) }
  const columns: SeekColumn[] = [[sql`b.remainingMinor`, 'desc'], [sql`b.name`, 'asc'], [sql`b.customerId`, 'asc']]
  return keysetPage({
    scope: 'customers.balances',
    filters: normalized,
    request,
    keyTypes: ['int', 'text', 'int'],
    order: 'desc',
    keyOf: (row) => [row.remainingMinor, row.name, row.customerId],
    fetch: (window: KeysetWindow) => getDatabase().all<{
      customerId: number; name: string; phone: string | null; orderCount: number
      totalMinor: number; paidMinor: number; remainingMinor: number
    }>(sql`
      SELECT * FROM (
        SELECT c.id AS customerId, c.name, c.phone,
               COUNT(o.id) AS orderCount,
               COALESCE(SUM(o.total_minor), 0) AS totalMinor,
               COALESCE(SUM(o.paid_minor), 0) AS paidMinor,
               COALESCE(SUM(o.total_minor - o.paid_minor), 0) AS remainingMinor
        FROM customers c
        LEFT JOIN orders o ON o.customer_id = c.id AND o.status IN ('confirmed', 'completed')
        ${normalized.search ? sql`WHERE c.name LIKE ${'%' + normalized.search + '%'} OR c.phone LIKE ${'%' + normalized.search + '%'}` : sql``}
        GROUP BY c.id
      ) b
      ${window.after ? sql`WHERE ${seekPredicate(columns, window)}` : sql``}
      ORDER BY ${seekOrder(columns, window)}
      LIMIT ${window.take}
    `),
    summary: () => undefined
  })
}

export type CustomerStatementSection = 'orders' | 'payments' | 'preliminaryInvoices' | 'approvedInvoices'

export interface CustomerStatementRequest {
  sections?: CustomerStatementSection[]
  orders?: PageRequest
  payments?: PageRequest
  preliminaryInvoices?: PageRequest
  approvedInvoices?: PageRequest
}

function emptyPage<T>(): CursorPage<T, undefined> {
  return { items: [], nextCursor: null, prevCursor: null, hasMore: false, summary: undefined }
}

/**
 * Interactive customer history: identity and authoritative balance plus
 * independently paged sections. Each section is a bounded page with its own
 * cursor; sections the session may not view stay empty.
 */
export function customerStatement(customerId: number, ctx?: ServiceContext, request: CustomerStatementRequest = {}) {
  const customer = getDatabase().select().from(customers).where(eq(customers.id, customerId)).get()
  if (!customer) throw notFound('العميل غير موجود')
  const wanted = new Set<CustomerStatementSection>(request.sections ?? ['orders', 'payments', 'preliminaryInvoices', 'approvedInvoices'])
  const filters = { customerId }
  const documentPage = (table: 'quotations' | 'final_invoices', scope: string, page: PageRequest | undefined) =>
    keysetPage({
      scope,
      filters,
      request: page ?? {},
      defaultLimit: PAGE_SIZE.statement,
      keyTypes: ['int'],
      order: 'desc',
      keyOf: (row) => [row.id],
      fetch: (window: KeysetWindow) => getDatabase().all<{ id: number; documentNumber: string; status: string; totalMinor: number }>(sql`
        SELECT id, document_number AS documentNumber, status, total_minor AS totalMinor
        FROM ${sql.raw(table)} WHERE customer_id = ${customerId}
        ${window.after ? sql`AND ${keysetBoundary([sql`id`], window)}` : sql``}
        ORDER BY ${keysetOrder([sql`id`], window)} LIMIT ${window.take}
      `),
      summary: () => undefined
    })

  return {
    customer,
    balance: customerBalances(undefined, customerId)[0],
    orders: wanted.has('orders')
      ? keysetPage({
          scope: 'customers.statement.orders',
          filters,
          request: request.orders ?? {},
          defaultLimit: PAGE_SIZE.statement,
          keyTypes: ['int'],
          order: 'desc',
          keyOf: (row) => [row.id],
          fetch: (window: KeysetWindow) => getDatabase()
            .select()
            .from(orders)
            .where(and(eq(orders.customerId, customerId), keysetBoundary([sql`${orders.id}`], window)))
            .orderBy(keysetOrder([sql`${orders.id}`], window))
            .limit(window.take)
            .all(),
          summary: () => undefined
        })
      : emptyPage<typeof orders.$inferSelect>(),
    payments: wanted.has('payments')
      ? keysetPage({
          scope: 'customers.statement.payments.composite-v1',
          filters: {...filters, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone},
          request: request.payments ?? {},
          defaultLimit: PAGE_SIZE.statement,
          keyTypes: ['text', 'text', 'int', 'text'],
          order: 'desc',
          keyOf: (row) => [row.effectiveBusinessDay, row.executionAt, row.id, row.entryType],
          fetch: (window: KeysetWindow) => getDatabase().all<PaymentHistoryEntry>(sql`
            SELECT * FROM (${paymentHistoryRows('customer', customerId)}) entries
            ${window.after ? sql`WHERE ${keysetBoundary(paymentHistoryColumns, window)}` : sql``}
            ORDER BY ${keysetOrder(paymentHistoryColumns, window)}
            LIMIT ${window.take}
          `),
          summary: () => undefined
        })
      : emptyPage(),
    preliminaryInvoices: wanted.has('preliminaryInvoices') && ctx && hasPermission(ctx.session, P.quotations.view)
      ? documentPage('quotations', 'customers.statement.preliminaryInvoices', request.preliminaryInvoices)
      : emptyPage<{ id: number; documentNumber: string; status: string; totalMinor: number }>(),
    approvedInvoices: wanted.has('approvedInvoices') && ctx && hasPermission(ctx.session, P.orders.view)
      ? documentPage('final_invoices', 'customers.statement.approvedInvoices', request.approvedInvoices)
      : emptyPage<{ id: number; documentNumber: string; status: string; totalMinor: number }>()
  }
}

export function listSuppliers(filter: { search?: string; activeOnly?: boolean } = {}) {
  const clauses = []
  if (filter.search?.trim()) {
    const p = `%${filter.search.trim()}%`
    clauses.push(or(like(suppliers.name, p), like(suppliers.phone, p)))
  }
  if (filter.activeOnly) clauses.push(eq(suppliers.active, true))
  return getDatabase()
    .select()
    .from(suppliers)
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(asc(suppliers.name))
    .all()
}

export function createSupplier(input: PartyInput, ctx: ServiceContext): number {
  requirePermission(ctx.session, P.suppliers.manage)
  return withTransaction(() => {
    const id = Number(
      getDatabase().insert(suppliers).values({ ...input, createdAt: nowIso() }).run().lastInsertRowid
    )
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'suppliers.create',
      entity: 'suppliers',
      entityId: String(id),
      details: { name: input.name }
    })
    return id
  })
}

export function updateSupplier(id: number, input: Partial<PartyInput>, ctx: ServiceContext): void {
  requirePermission(ctx.session, P.suppliers.manage)
  return withTransaction(() => {
    const existing = getDatabase().select().from(suppliers).where(eq(suppliers.id, id)).get()
    if (!existing) throw notFound('المورد غير موجود')
    getDatabase().update(suppliers).set({ ...input }).where(eq(suppliers.id, id)).run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'suppliers.update',
      entity: 'suppliers',
      entityId: String(id),
      details: input
    })
  })
}

/** Item 8: same rule as deleteCustomer — blocked while purchase history exists. */
export function deleteSupplier(id: number, ctx: ServiceContext): void {
  requirePermission(ctx.session, P.suppliers.manage)
  return withTransaction(() => {
    if (!getDatabase().select().from(suppliers).where(eq(suppliers.id, id)).get()) {
      throw notFound('المورد غير موجود')
    }
    const purchaseCount = getDatabase()
      .get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM purchases WHERE supplier_id = ${id}`)?.c ?? 0
    const paymentCount = getDatabase()
      .get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM supplier_payments WHERE supplier_id = ${id}`)?.c ?? 0
    if (purchaseCount > 0 || paymentCount > 0) {
      throw new AppError(
        'CONFLICT',
        'لا يمكن حذف هذا المورد لوجود فواتير شراء أو دفعات تاريخية مرتبطة به. يمكنك تعطيله بدلاً من ذلك'
      )
    }
    getDatabase().delete(suppliers).where(eq(suppliers.id, id)).run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'suppliers.delete',
      entity: 'suppliers',
      entityId: String(id)
    })
  })
}

export interface SupplierFullDeletePreview {
  supplierId: number
  name: string
  dependencies: Array<{ key: string; label: string; count: number }>
  blockers: string[]
}

function supplierPurchaseIds(id: number): number[] {
  return (getRawConnection().prepare('SELECT id FROM purchases WHERE supplier_id = ?').all(id) as Array<{ id: number }>)
    .map((row) => row.id)
}

/**
 * Aggregates the SAME per-invoice preview `purchaseFullDeletePreview`
 * already computes — never a second, parallel counting of payments or
 * inventory movements — across every purchase this supplier owns, plus
 * the supplier's own standalone (not tied to any one invoice) payments.
 * Never counts a material or product merely because it was purchased
 * from this supplier — nothing outside purchases/payments/cash/
 * inventory rows this supplier's own invoices created is touched.
 */
export function supplierFullDeletePreview(id: number): SupplierFullDeletePreview {
  const supplier = getDatabase().select().from(suppliers).where(eq(suppliers.id, id)).get()
  if (!supplier) throw notFound('المورد غير موجود')

  const purchaseIds = supplierPurchaseIds(id)
  const totals: Record<string, number> = {}
  const blockers: string[] = []
  for (const purchaseId of purchaseIds) {
    const preview = purchaseFullDeletePreview(purchaseId)
    for (const dep of preview.dependencies) totals[dep.key] = (totals[dep.key] ?? 0) + dep.count
    for (const blocker of preview.blockers) blockers.push(`فاتورة ${preview.documentNumber}: ${blocker}`)
  }

  const standalonePayments = Number(
    getDatabase().get<{ c: number }>(sql`
      SELECT COUNT(*) AS c FROM supplier_payments WHERE supplier_id = ${id} AND purchase_id IS NULL
    `)?.c ?? 0
  )
  const standaloneCash = Number(
    getDatabase().get<{ c: number }>(sql`
      SELECT COUNT(*) AS c FROM cash_transactions
      WHERE ref_table = 'supplier_payments'
        AND ref_id IN (SELECT id FROM supplier_payments WHERE supplier_id = ${id} AND purchase_id IS NULL)
    `)?.c ?? 0
  )

  if (purchaseIds.length > 0) {
    blockers.push(
      'المورد مرتبط بفواتير شراء مُرحّلة؛ يجب إبقاء المورد والفواتير ودفعاتها وسجل المخزون التاريخي'
    )
  }
  if (standalonePayments > 0) {
    blockers.push('المورد مرتبط بدفعات مالية مُرحّلة لا يجوز حذفها بحذف بطاقة المورد')
  }

  const dependencies: Array<{ key: string; label: string; count: number }> = []
  if (purchaseIds.length > 0) dependencies.push({ key: 'purchases', label: 'فواتير الشراء', count: purchaseIds.length })
  const paymentTotal = (totals.payments ?? 0) + standalonePayments
  if (paymentTotal > 0) dependencies.push({ key: 'payments', label: 'دفعات المورد', count: paymentTotal })
  const cashTotal = (totals.cashTransactions ?? 0) + standaloneCash
  if (cashTotal > 0) dependencies.push({ key: 'cashTransactions', label: 'الحركات المالية', count: cashTotal })
  if (totals.inventoryMovements) dependencies.push({ key: 'inventoryMovements', label: 'حركات المخزون', count: totals.inventoryMovements })

  return { supplierId: id, name: supplier.name, dependencies, blockers: [...new Set(blockers)] }
}

/**
 * Permanent deletion remains available only for an unused supplier master.
 * Purchase invoices and standalone payments are posted history and therefore
 * make this operation fail before its legacy cascade body can run.
 */
export function fullDeleteSupplier(
  input: { id: number; confirmation: string },
  ctx: ServiceContext
): { removed: true; summary: Record<string, number> } {
  requirePermission(ctx.session, P.suppliers.fullDelete)
  const supplier = getDatabase().select().from(suppliers).where(eq(suppliers.id, input.id)).get()
  if (!supplier) throw notFound('المورد غير موجود')
  if (input.confirmation.trim() !== supplier.name.trim()) {
    throw new AppError('VALIDATION_ERROR', `اكتب اسم المورد "${supplier.name}" لتأكيد الحذف النهائي`)
  }
  const preview = supplierFullDeletePreview(input.id)
  if (preview.blockers.length) {
    throw new AppError('CONFLICT', `تعذر حذف المورد بالكامل لحماية سجل التكلفة: ${preview.blockers.join('، ')}`)
  }

  return withTransaction(() => {
    for (const purchaseId of supplierPurchaseIds(input.id)) {
      performFullDeletePurchase(purchaseId, ctx, `Supplier full delete (${supplier.name} #${input.id})`)
    }
    // Standalone (not tied to any single invoice) supplier payments —
    // e.g. an advance on account — go last, exactly like the invoice
    // payments above: remove the source, then its cash projection.
    // removeCashMovementForRef matches one refId at a time, so every
    // remaining standalone payment id is walked individually — still
    // one transaction, still all-or-nothing.
    const standaloneIds = (getRawConnection()
      .prepare('SELECT id FROM supplier_payments WHERE supplier_id = ? AND purchase_id IS NULL')
      .all(input.id) as Array<{ id: number }>).map((row) => row.id)
    getDatabase().delete(supplierPayments).where(and(eq(supplierPayments.supplierId, input.id), isNull(supplierPayments.purchaseId))).run()
    for (const paymentId of standaloneIds) removeCashMovementForRef('supplier_payments', paymentId)

    getDatabase().delete(suppliers).where(eq(suppliers.id, input.id)).run()

    const summary = Object.fromEntries(preview.dependencies.map((item) => [item.key, item.count])) as Record<string, number>
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'suppliers.full_delete',
      entity: 'suppliers',
      entityId: String(input.id),
      details: {
        fullDelete: true,
        description: `Full Supplier deletion (${supplier.name} #${input.id})`,
        name: supplier.name,
        summary
      }
    })
    return { removed: true, summary }
  })
}

/** BR-22: supplier outstanding balances from purchases vs payments. */
export function supplierBalances(search?: string) {
  return getDatabase().all<{
    supplierId: number
    name: string
    purchasedMinor: number
    paidMinor: number
    remainingMinor: number
  }>(sql`
    SELECT s.id AS supplierId, s.name,
           COALESCE((SELECT SUM(total_minor) FROM purchases p WHERE p.supplier_id = s.id), 0) AS purchasedMinor,
           COALESCE((SELECT SUM(amount_minor) FROM supplier_payments sp WHERE sp.supplier_id = s.id), 0) AS paidMinor,
           COALESCE((SELECT SUM(total_minor) FROM purchases p WHERE p.supplier_id = s.id), 0)
             - COALESCE((SELECT SUM(amount_minor) FROM supplier_payments sp WHERE sp.supplier_id = s.id), 0) AS remainingMinor
    FROM suppliers s
    ${search?.trim() ? sql`WHERE s.name LIKE ${'%' + search.trim() + '%'}` : sql``}
    ORDER BY remainingMinor DESC, s.name ASC
  `)
}

export type SupplierStatementSection = 'purchases' | 'payments'

export function supplierStatement(
  supplierId: number,
  request: { sections?: SupplierStatementSection[]; purchases?: PageRequest; payments?: PageRequest } = {}
) {
  const supplier = getDatabase().select().from(suppliers).where(eq(suppliers.id, supplierId)).get()
  if (!supplier) throw notFound('المورد غير موجود')
  const wanted = new Set<SupplierStatementSection>(request.sections ?? ['purchases', 'payments'])
  const filters = { supplierId }
  return {
    supplier,
    balance: getDatabase().get<{ purchasedMinor: number; paidMinor: number; remainingMinor: number }>(sql`
      SELECT
        COALESCE((SELECT SUM(total_minor) FROM purchases WHERE supplier_id = ${supplierId}), 0) AS purchasedMinor,
        COALESCE((SELECT SUM(amount_minor) FROM supplier_payments WHERE supplier_id = ${supplierId}), 0) AS paidMinor,
        COALESCE((SELECT SUM(total_minor) FROM purchases WHERE supplier_id = ${supplierId}), 0)
          - COALESCE((SELECT SUM(amount_minor) FROM supplier_payments WHERE supplier_id = ${supplierId}), 0) AS remainingMinor
    `)!,
    purchases: wanted.has('purchases')
      ? keysetPage({
          scope: 'suppliers.statement.purchases',
          filters,
          request: request.purchases ?? {},
          defaultLimit: PAGE_SIZE.statement,
          keyTypes: ['int'],
          order: 'desc',
          keyOf: (row) => [row.id],
          fetch: (window: KeysetWindow) => getDatabase()
            .select()
            .from(purchases)
            .where(and(eq(purchases.supplierId, supplierId), keysetBoundary([sql`${purchases.id}`], window)))
            .orderBy(keysetOrder([sql`${purchases.id}`], window))
            .limit(window.take)
            .all(),
          summary: () => undefined
        })
      : emptyPage<typeof purchases.$inferSelect>(),
    payments: wanted.has('payments')
      ? keysetPage({
          scope: 'suppliers.statement.payments',
          filters,
          request: request.payments ?? {},
          defaultLimit: PAGE_SIZE.statement,
          keyTypes: ['int'],
          order: 'desc',
          keyOf: (row) => [row.id],
          fetch: (window: KeysetWindow) => getDatabase()
            .select({ ...getTableColumns(supplierPayments), purchaseDocumentNumber: purchases.documentNumber })
            .from(supplierPayments)
            .leftJoin(purchases, eq(purchases.id, supplierPayments.purchaseId))
            .where(and(eq(supplierPayments.supplierId, supplierId), keysetBoundary([sql`${supplierPayments.id}`], window)))
            .orderBy(keysetOrder([sql`${supplierPayments.id}`], window))
            .limit(window.take)
            .all(),
          summary: () => undefined
        })
      : emptyPage<typeof supplierPayments.$inferSelect & { purchaseDocumentNumber: string | null }>()
  }
}
