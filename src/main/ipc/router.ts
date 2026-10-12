import { ipcMain, type IpcMain } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { PRINT_VISIBILITY_KEYS } from '@shared/documents/print-visibility'
import { createHandler, type HandlerContext } from './guard'

import * as auth from '../auth/auth.service'
import * as bootstrap from '../services/admin/bootstrap.service'
import * as usersAdmin from '../services/admin/users.service'
import * as catalog from '../services/catalog/catalog.service'
import * as inventory from '../services/inventory/inventory.service'
import * as valuation from '../services/inventory/valuation.service'
import * as parties from '../services/parties/parties.service'
import * as purchasing from '../services/purchasing/purchasing.service'
import * as products from '../services/products/products.service'
import * as quotations from '../services/sales/quotations.service'
import * as orders from '../services/sales/orders.service'
import * as production from '../services/production/production.service'
import * as materialReturns from '../services/production/material-returns.service'
import * as finishedGoods from '../services/production/finished-goods.service'
import * as planning from '../services/planning/planning.service'
import * as finalInvoices from '../services/sales/final-invoices.service'
import * as uncollected from '../services/sales/uncollected-products.service'
import * as machines from '../services/production/machines.service'
import * as workers from '../services/production/workers.service'
import * as employees from '../services/hr/employees.service'
import * as expenses from '../services/finance/expenses.service'
import * as cash from '../services/finance/cash.service'
import * as profit from '../services/finance/profit.service'
import * as costing from '../services/costing/costing.service'
import * as reports from '../services/reports/reports.service'
import * as printing from '../services/documents/print.service'
import * as settings from '../services/settings.service'
import * as backup from '../backup/backup.service'
import * as notifications from '../services/notifications/notifications.service'
import * as profile from '../services/profile/profile.service'
import * as dashboard from '../services/dashboard/dashboard.service'
import { pickProfileImage } from '../files/dialogs'
import { restoreFromBackup } from '../restore/restore.service'
import { pickBackupDestinationFile, pickBackupFileToRestore } from '../files/dialogs'
import { BrowserWindow } from 'electron'
import { setTheme } from '../services/admin/users.service'
import { AppError } from '../utils/errors'
import { logger } from '../utils/logger'
import { hasPermission, requirePermission } from '../permissions/permission-guard'
import { safeIntegerSchema } from '@shared/schemas/common.schema'
import { boundedSearchSchema, pageRequestShape } from '../services/base/pagination'

/** Shorthand: register one channel with its schema and permission. */
function on<TReq, TRes>(
  bus: IpcMain,
  channel: string,
  options: { schema?: z.ZodType<TReq>; permission?: string; requireAuth?: boolean; restoreExclusive?: boolean },
  handler: (request: TReq, ctx: HandlerContext) => TRes | Promise<TRes>
): void {
  bus.handle(channel, createHandler(options, handler))
}

const idSchema = z.object({ id: safeIntegerSchema.positive() })
function omitFields<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> {
  const copy = { ...value } as Record<PropertyKey, unknown>
  for (const key of keys) delete copy[key]
  return copy as Omit<T, K>
}
/** One planned material line — shared by quotation costing and the
 *  production order's material report (they are the same shape). */
const plannedMaterialSchema = z.object({
  id: safeIntegerSchema.int().positive().optional(),
  materialId: safeIntegerSchema.nullable().optional(),
  materialName: z.string().min(1),
  qtyMicro: safeIntegerSchema.positive(),
  unit: z.string().nullable().optional(),
  dimensions: z.string().nullable().optional(),
  thickness: z.string().nullable().optional(),
  colorCode: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  estimatedUnitCostMicro: safeIntegerSchema.nonnegative().optional()
})
const optionalFilters = z
  .object({
    search: z.string().optional(),
    activeOnly: z.boolean().optional(),
    categoryId: safeIntegerSchema.optional(),
    customerId: safeIntegerSchema.optional(),
    supplierId: safeIntegerSchema.optional(),
    customerOrderId: safeIntegerSchema.optional(),
    unassignedOnly: z.boolean().optional(),
    orderId: safeIntegerSchema.optional(),
    status: z.string().optional(),
    paymentStatus: z.string().optional(),
    kind: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    lowOnly: z.boolean().optional(),
    linkedOnly: z.boolean().optional(),
    materialId: safeIntegerSchema.optional(),
    limit: safeIntegerSchema.optional(),
    action: z.string().optional()
  })
  .partial()
/** Bounded-history requests: server-capped page size, validated cursor, bounded search. */
const pageSchema = z.object(pageRequestShape)
/** A top-level page request addresses the only requested statement section. */
function singleSectionPage<K extends string, T extends { sections?: K[] } & Partial<Record<K, { limit?: number; cursor?: string }>>>(
  request: T,
  page: { limit?: number; cursor?: string }
): T {
  if ((page.limit === undefined && page.cursor === undefined) || request.sections?.length !== 1) return request
  return { ...request, [request.sections[0]!]: page }
}
const boundedToken = z.string().max(64).optional()
const pagedFilters = optionalFilters.extend({
  search: boundedSearchSchema,
  status: boundedToken,
  paymentStatus: boundedToken,
  kind: boundedToken,
  from: z.string().max(32).optional(),
  to: z.string().max(32).optional(),
  ...pageRequestShape
})

/**
 * Every privileged operation in the ERP is registered here, each with
 * its Zod schema and the permission key it requires. Authorization is
 * enforced at this boundary AND again inside services for the few
 * actions needing a more specific check (BR-104).
 */
export function registerIpcRouter(): void {
  const bus = ipcMain

  // ---- Auth & setup (public channels) ----
  on(
    bus,
    IPC_CHANNELS.auth.login,
    {
      schema: z.object({
        username: z.string(),
        password: z.string(),
        rememberMe: z.boolean().optional()
      })
    },
    (req, ctx) => auth.login(req.username, req.password, ctx.webContentsId, req.rememberMe ?? false)
  )
  on(bus, IPC_CHANNELS.auth.logout, { requireAuth: true }, (_req, ctx) => {
    auth.logout(ctx.webContentsId)
    return { ok: true }
  })
  on(
    bus,
    IPC_CHANNELS.auth.tryResume,
    {},
    (_req, ctx) => auth.tryResumeSession(ctx.webContentsId) ?? null
  )
  on(bus, IPC_CHANNELS.auth.setupStatus, {}, () => ({ needsSetup: bootstrap.needsSetup() }))
  on(
    bus,
    IPC_CHANNELS.auth.performSetup,
    {
      schema: z.object({
        username: z.string().min(3),
        password: z.string().min(6),
        fullName: z.string().min(1)
      })
    },
    (req) => bootstrap.performInitialSetup(req)
  )
  on(
    bus,
    IPC_CHANNELS.auth.setTheme,
    { schema: z.object({ theme: z.enum(['light', 'dark']) }), requireAuth: true },
    (req, ctx) => {
      setTheme(ctx.session.user.id, req.theme)
      return { theme: req.theme }
    }
  )
  on(bus, IPC_CHANNELS.system.getAppInfo, {}, () => ({ name: 'AURA home' }))
  on(
    bus,
    IPC_CHANNELS.dashboard.summary,
    {
      schema: z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        year: safeIntegerSchema.int(),
        month: safeIntegerSchema.int().min(1).max(12),
        currentDay: z.boolean()
      }),
      permission: P.dashboard.view
    },
    (req, ctx) => dashboard.dashboardSummary(req, ctx.session)
  )

  // ---- Notifications (RBAC enforced per category inside the service,
  //      not by a single blanket permission — see notifications.service.ts) ----
  on(bus, IPC_CHANNELS.notifications.list, { requireAuth: true }, (_req, ctx) =>
    notifications.notificationFeed(ctx.session)
  )
  on(bus, IPC_CHANNELS.notifications.markAllRead, { requireAuth: true }, (_req, ctx) => {
    notifications.markAllNotificationsRead(ctx.session)
    return { ok: true }
  })
  on(
    bus,
    IPC_CHANNELS.notifications.dismiss,
    {
      schema: z.object({ notificationKey: z.string().min(1).max(200) }),
      requireAuth: true
    },
    (req, ctx) => ({
      dismissed: notifications.dismissNotification(ctx.session, req.notificationKey)
    })
  )
  on(bus, IPC_CHANNELS.notifications.clearAll, { requireAuth: true }, (_req, ctx) => ({
    dismissedCount: notifications.clearAllNotifications(ctx.session)
  }))

  // ---- Profile photo (strictly self-service — every handler acts
  //      only on ctx.session.user.id, never a client-supplied id) ----
  on(bus, IPC_CHANNELS.profile.getMyPhoto, { requireAuth: true }, (_req, ctx) =>
    profile.getMyPhoto(ctx)
  )
  on(bus, IPC_CHANNELS.profile.pickImage, { requireAuth: true }, async (_req, ctx) => {
    const win = BrowserWindow.fromId(ctx.webContentsId) ?? BrowserWindow.getAllWindows()[0]
    return { path: win ? await pickProfileImage(win) : undefined }
  })
  on(
    bus,
    IPC_CHANNELS.profile.readImageForCrop,
    { schema: z.object({ path: z.string().min(1) }), requireAuth: true },
    (req) => profile.readImageForCrop(req.path)
  )
  on(
    bus,
    IPC_CHANNELS.profile.setPhoto,
    { schema: z.object({ dataUrl: z.string().min(1) }), requireAuth: true },
    (req, ctx) => {
      profile.setMyPhoto(req.dataUrl, ctx)
      return { ok: true }
    }
  )
  on(bus, IPC_CHANNELS.profile.removePhoto, { requireAuth: true }, (_req, ctx) => {
    profile.removeMyPhoto(ctx)
    return { ok: true }
  })

  // ---- Catalog: categories, colours, materials ----
  on(bus, IPC_CHANNELS.categories.tree, { permission: P.materials.view }, () =>
    catalog.categoryTree()
  )
  on(bus, IPC_CHANNELS.categories.list, { permission: P.materials.view }, () =>
    catalog.listCategories()
  )
  on(
    bus,
    IPC_CHANNELS.categories.create,
    {
      schema: z.object({
        name: z.string().min(1),
        parentId: safeIntegerSchema.int().positive().nullable().optional(),
        sortOrder: safeIntegerSchema.optional(),
        isAccessory: z.boolean().optional()
      }),
      permission: P.materials.manage
    },
    (req, ctx) => ({ id: catalog.createCategory(req, ctx) })
  )
  on(
    bus,
    IPC_CHANNELS.categories.update,
    {
      schema: z.object({
        id: safeIntegerSchema,
        name: z.string().optional(),
        parentId: safeIntegerSchema.nullable().optional(),
        sortOrder: safeIntegerSchema.optional(),
        active: z.boolean().optional(),
        isAccessory: z.boolean().optional()
      }),
      permission: P.materials.manage
    },
    ({ id, ...rest }, ctx) => {
      catalog.updateCategory(id, rest, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.categories.remove,
    { schema: idSchema, permission: P.materials.manage },
    ({ id }, ctx) => {
      catalog.deleteCategory(id, ctx)
      return { ok: true }
    }
  )

  on(
    bus,
    IPC_CHANNELS.colors.materialOptions,
    {
      schema: z.object({ colorId: safeIntegerSchema.int().positive().optional() }),
      permission: P.colors.manage
    },
    (req) => catalog.colorMaterialOptions(req.colorId)
  )
  on(bus, IPC_CHANNELS.colors.list, { schema: optionalFilters, permission: P.colors.view }, (req) =>
    catalog.listColors(req.activeOnly ?? false)
  )
  on(
    bus,
    IPC_CHANNELS.colors.create,
    {
      schema: z.object({
        code: z.string().min(1),
        name: z.string().min(1),
        relatedMaterialType: z.string().nullable().optional(),
        relatedMaterialId: safeIntegerSchema.int().positive().nullable().optional(),
        notes: z.string().optional()
      }),
      permission: P.colors.manage
    },
    (req, ctx) => ({ id: catalog.createColor(req, ctx) })
  )
  on(
    bus,
    IPC_CHANNELS.colors.update,
    {
      schema: z.object({
        id: safeIntegerSchema,
        code: z.string().optional(),
        name: z.string().optional(),
        relatedMaterialType: z.string().nullable().optional(),
        relatedMaterialId: safeIntegerSchema.int().positive().nullable().optional(),
        notes: z.string().optional(),
        active: z.boolean().optional()
      }),
      permission: P.colors.manage
    },
    ({ id, ...rest }, ctx) => {
      catalog.updateColor(id, rest, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.colors.remove,
    { schema: idSchema, permission: P.colors.manage },
    ({ id }, ctx) => catalog.deleteColor(id, ctx)
  )

  const materialSchema = z.object({
    sku: z.string().min(1),
    name: z.string().min(1),
    categoryId: safeIntegerSchema,
    unit: z.string().min(1),
    purchaseUnit: z.string().nullable().optional(),
    purchaseUnitFactorMicro: safeIntegerSchema.nullable().optional(),
    tracksDimensions: z.boolean().optional(),
    dimensions: z.string().nullable().optional(),
    thickness: z.string().nullable().optional(),
    currentMarketPriceMicro: safeIntegerSchema.nonnegative(),
    pricingRule: z.enum(['exact', 'full_unit', 'round_up', 'manual']),
    commercialUnitSizeMicro: safeIntegerSchema.nullable().optional(),
    reorderLevelMicro: safeIntegerSchema.optional(),
    notes: z.string().nullable().optional(),
    active: z.boolean().optional(),
    colorId: safeIntegerSchema.int().positive().nullable().optional()
  })
  on(
    bus,
    IPC_CHANNELS.categories.createChildMaterial,
    {
      schema: materialSchema.omit({ categoryId: true }).extend({
        parentId: safeIntegerSchema.int().positive(),
        leafType: z.enum(['raw', 'colored']).default('raw'),
        clientRequestId: z.string().min(8).max(100)
      }),
      permission: P.materials.manage
    },
    (req, ctx) => catalog.createChildMaterial(req, ctx)
  )
  on(bus, IPC_CHANNELS.materials.colorOptions, { permission: P.materials.manage }, () =>
    catalog.listColors(true)
  )
  on(
    bus,
    IPC_CHANNELS.materials.list,
    { schema: optionalFilters, permission: P.materials.view },
    (req) => catalog.listMaterials(req)
  )
  /* Read-only accessory catalog for sales documents. Gated on
     quotations.view (the lightest sales-document read) so an invoice
     author can pick an accessory without holding Raw Materials
     permissions — and it can never create or edit material master
     data. */
  on(bus, IPC_CHANNELS.materials.accessories, { permission: P.quotations.view }, () =>
    catalog.listAccessoryMaterials()
  )
  /* Same lightweight gate as the accessories catalog: an invoice
     author can pick a material type without holding Raw Materials
     permissions, and this can never create/edit material master
     data. */
  on(bus, IPC_CHANNELS.materials.types, { permission: P.quotations.view }, () =>
    catalog.listMaterialTypeOptions()
  )
  on(
    bus,
    IPC_CHANNELS.materials.get,
    { schema: idSchema, permission: P.materials.view },
    ({ id }) => catalog.getMaterial(id)
  )
  on(
    bus,
    IPC_CHANNELS.materials.create,
    { schema: materialSchema, permission: P.materials.manage },
    () => {
      throw new AppError('VALIDATION_ERROR', 'تُضاف المواد الخام من شجرة تصنيفات المواد فقط')
    }
  )
  on(
    bus,
    IPC_CHANNELS.materials.update,
    { schema: materialSchema.partial().extend({ id: safeIntegerSchema }), permission: P.materials.manage },
    ({ id, ...rest }, ctx) => {
      catalog.updateMaterial(id, rest, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.materials.remove,
    { schema: idSchema, permission: P.materials.manage },
    ({ id }, ctx) => catalog.deleteMaterial(id, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.materials.fullDeletePreview,
    { schema: idSchema, permission: P.materials.fullDelete },
    ({ id }) => catalog.materialFullDeletePreview(id)
  )
  on(
    bus,
    IPC_CHANNELS.materials.fullDelete,
    {
      schema: z.object({ id: safeIntegerSchema, confirmation: z.string().min(1) }),
      permission: P.materials.fullDelete
    },
    (req, ctx) => catalog.fullDeleteMaterial(req, ctx)
  )

  // ---- Inventory ----
  on(
    bus,
    IPC_CHANNELS.inventory.stock,
    { schema: optionalFilters, permission: P.inventory.view },
    (req) => valuation.stockLevels(req)
  )
  on(
    bus,
    IPC_CHANNELS.inventory.valuation,
    { schema: optionalFilters, permission: P.inventory.valuation },
    (req) => valuation.materialValuation(req)
  )
  on(
    bus,
    IPC_CHANNELS.inventory.movements,
    { schema: pagedFilters, permission: P.inventory.view },
    ({ limit, cursor, ...filter }, ctx) => {
      const page = inventory.listMovements(filter, { limit, cursor })
      if (hasPermission(ctx.session, P.inventory.valuation)) return page
      return { ...page, items: page.items.map((row) => omitFields(row, ['actualCostMinor'] as const)) }
    }
  )
  on(
    bus,
    IPC_CHANNELS.inventory.waste,
    {
      schema: z.object({
        materialId: safeIntegerSchema,
        qtyMicro: safeIntegerSchema.positive(),
        reason: z.string().min(1)
      }),
      permission: P.inventory.waste
    },
    (req, ctx) => inventory.recordWaste({ ...req, ctx })
  )
  on(
    bus,
    IPC_CHANNELS.inventory.adjust,
    {
      schema: z.object({
        materialId: safeIntegerSchema,
        qtyMicro: safeIntegerSchema.positive(),
        direction: z.enum(['in', 'out']),
        reason: z.string().min(1),
        unitCostMicro: safeIntegerSchema.nonnegative().optional()
      }),
      permission: P.inventory.adjust
    },
    (req, ctx) => inventory.adjustStock({ ...req, unitCost: req.unitCostMicro as never, ctx })
  )
  on(
    bus,
    IPC_CHANNELS.inventory.remainders,
    { schema: z.object({ materialId: safeIntegerSchema.optional(), ...pageRequestShape }), permission: P.inventory.view },
    ({ materialId, limit, cursor }) => inventory.listRemainders(materialId, { limit, cursor })
  )
  on(
    bus,
    IPC_CHANNELS.inventory.addRemainder,
    {
      schema: z.object({
        materialId: safeIntegerSchema,
        sizeMicro: safeIntegerSchema.positive(),
        layerId: safeIntegerSchema.optional(),
        note: z.string().optional()
      }),
      permission: P.inventory.consume
    },
    (req, ctx) => {
      inventory.recordRemainder({ ...req, ctx })
      return { ok: true }
    }
  )

  // ---- Customers & suppliers ----
  const partySchema = z.object({
    name: z.string().min(1),
    phone: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    active: z.boolean().optional()
  })
  on(
    bus,
    IPC_CHANNELS.customers.list,
    {
      schema: z
        .object({
          search: boundedSearchSchema,
          activeOnly: z.boolean().optional(),
          state: z.enum(['active', 'archived']).optional(),
          ...pageRequestShape
        })
        .optional(),
      permission: P.customers.view
    },
    (req) => {
      const { limit, cursor, ...filter } = req ?? {}
      return parties.listCustomers(filter, { limit, cursor })
    }
  )
  on(
    bus,
    IPC_CHANNELS.customers.create,
    { schema: partySchema, permission: P.customers.manage },
    (req, ctx) => ({ id: parties.createCustomer(req, ctx) })
  )
  on(
    bus,
    IPC_CHANNELS.customers.update,
    { schema: partySchema.partial().extend({ id: safeIntegerSchema }), permission: P.customers.manage },
    ({ id, ...rest }, ctx) => {
      parties.updateCustomer(id, rest, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.customers.balances,
    { schema: z.object({ search: boundedSearchSchema, ...pageRequestShape }), permission: P.customers.view },
    ({ search, limit, cursor }) => parties.customerBalancesPage({ search }, { limit, cursor })
  )
  on(
    bus,
    IPC_CHANNELS.customers.statement,
    {
      schema: idSchema.extend({
        sections: z.array(z.enum(['orders', 'payments', 'preliminaryInvoices', 'approvedInvoices'])).max(4).optional(),
        orders: pageSchema.optional(),
        payments: pageSchema.optional(),
        preliminaryInvoices: pageSchema.optional(),
        approvedInvoices: pageSchema.optional(),
        ...pageRequestShape
      }),
      permission: P.customers.view
    },
    ({ id, limit, cursor, ...request }, ctx) =>
      parties.customerStatement(id, ctx, singleSectionPage(request, { limit, cursor }))
  )
  for (const [channel, action] of [
    [IPC_CHANNELS.customers.archive, parties.archiveCustomer],
    [IPC_CHANNELS.customers.restore, parties.restoreCustomer]
  ] as const) {
    on(bus, channel, { schema: idSchema, permission: P.customers.archive }, ({ id }, ctx) => {
      action(id, ctx)
      return { ok: true }
    })
  }
  on(
    bus,
    IPC_CHANNELS.customers.remove,
    {
      // Not a cascade "permanent delete" workflow: the service refuses
      // as soon as the customer has any history, so this is ordinary
      // record cleanup under `manage` (the same guard suppliers:remove
      // uses, and the same key parties.service re-checks internally).
      schema: idSchema.extend({ confirmation: z.string().min(1) }),
      permission: P.customers.manage
    },
    ({ id, confirmation }, ctx) => {
      parties.deleteCustomer(id, ctx, confirmation)
      return { ok: true }
    }
  )

  on(
    bus,
    IPC_CHANNELS.suppliers.list,
    { schema: optionalFilters, permission: P.suppliers.view },
    (req) => parties.listSuppliers(req)
  )
  on(
    bus,
    IPC_CHANNELS.suppliers.create,
    { schema: partySchema, permission: P.suppliers.manage },
    (req, ctx) => ({ id: parties.createSupplier(req, ctx) })
  )
  on(
    bus,
    IPC_CHANNELS.suppliers.update,
    { schema: partySchema.partial().extend({ id: safeIntegerSchema }), permission: P.suppliers.manage },
    ({ id, ...rest }, ctx) => {
      parties.updateSupplier(id, rest, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.suppliers.balances,
    { schema: optionalFilters, permission: P.suppliers.view },
    (req) => parties.supplierBalances(req.search)
  )
  on(
    bus,
    IPC_CHANNELS.suppliers.statement,
    {
      schema: idSchema.extend({
        sections: z.array(z.enum(['purchases', 'payments'])).max(2).optional(),
        purchases: pageSchema.optional(),
        payments: pageSchema.optional(),
        ...pageRequestShape
      }),
      permission: P.suppliers.view
    },
    ({ id, limit, cursor, ...request }) => parties.supplierStatement(id, singleSectionPage(request, { limit, cursor }))
  )
  on(
    bus,
    IPC_CHANNELS.suppliers.remove,
    { schema: idSchema, permission: P.suppliers.manage },
    ({ id }, ctx) => {
      parties.deleteSupplier(id, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.suppliers.fullDeletePreview,
    { schema: idSchema, permission: P.suppliers.fullDelete },
    ({ id }) => parties.supplierFullDeletePreview(id)
  )
  on(
    bus,
    IPC_CHANNELS.suppliers.fullDelete,
    {
      schema: z.object({ id: safeIntegerSchema, confirmation: z.string().min(1) }),
      permission: P.suppliers.fullDelete
    },
    (req, ctx) => parties.fullDeleteSupplier(req, ctx)
  )

  // ---- Purchases ----
  on(
    bus,
    IPC_CHANNELS.purchases.list,
    { schema: pagedFilters, permission: P.purchases.view },
    ({ limit, cursor, ...filter }) => purchasing.listPurchases(filter, { limit, cursor })
  )
  on(
    bus,
    IPC_CHANNELS.purchases.forOrder,
    { schema: z.object({ orderId: safeIntegerSchema.int().positive() }), permission: P.purchases.view },
    ({ orderId }) => purchasing.purchasesForOrder(orderId)
  )
  on(
    bus,
    IPC_CHANNELS.purchases.get,
    { schema: idSchema, permission: P.purchases.view },
    ({ id }, ctx) => {
      const detail = purchasing.getPurchase(id)
      if (hasPermission(ctx.session, P.purchases.prices)) return detail
      return {
        ...detail,
        lines: detail.lines.map((line) =>
          omitFields(line, ['unitCostMicro', 'lineTotalMinor'] as const)
        )
      }
    }
  )
  on(
    bus,
    IPC_CHANNELS.purchases.create,
    {
      schema: z.object({
        supplierId: safeIntegerSchema,
        customerOrderId: safeIntegerSchema.int().positive().nullable().optional(),
        purchaseDate: z.string().optional(),
        notes: z.string().optional(),
        paidNowMinor: safeIntegerSchema.optional(),
        cashAccountId: safeIntegerSchema.optional(),
        requestKey: z.string().trim().min(8).max(100),
        lines: z
          .array(
            z.object({
              materialId: safeIntegerSchema,
              qtyMicro: safeIntegerSchema.positive().optional(),
              purchaseQtyMicro: safeIntegerSchema.positive().optional(),
              unitCostMicro: safeIntegerSchema.nonnegative().optional(),
              purchaseUnitCostMicro: safeIntegerSchema.nonnegative().optional(),
              lineTotalMinor: safeIntegerSchema.nonnegative().optional(),
              batchCode: z.string().nullable().optional()
            })
          )
          .min(1)
      }),
      permission: P.purchases.manage
    },
    (req, ctx) => purchasing.createPurchase(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.purchases.update,
    {
      schema: z.object({
        id: safeIntegerSchema,
        supplierId: safeIntegerSchema.optional(),
        customerOrderId: safeIntegerSchema.int().positive().nullable().optional(),
        purchaseDate: z.string().optional(),
        notes: z.string().nullable().optional(),
        cashAccountId: safeIntegerSchema.nullable().optional(),
        lines: z
          .array(
            z.object({
              materialId: safeIntegerSchema,
              qtyMicro: safeIntegerSchema.positive().optional(),
              purchaseQtyMicro: safeIntegerSchema.positive().optional(),
              unitCostMicro: safeIntegerSchema.nonnegative().optional(),
              purchaseUnitCostMicro: safeIntegerSchema.nonnegative().optional(),
              lineTotalMinor: safeIntegerSchema.nonnegative().optional(),
              batchCode: z.string().nullable().optional()
            })
          )
          .min(1)
          .optional()
      }),
      permission: P.purchases.manage
    },
    ({ id, ...rest }, ctx) => {
      purchasing.updatePurchase(id, rest, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.purchases.remove,
    { schema: idSchema, permission: P.purchases.manage },
    ({ id }, ctx) => {
      purchasing.deletePurchase(id, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.purchases.pay,
    {
      schema: z.object({
        supplierId: safeIntegerSchema,
        purchaseId: safeIntegerSchema.optional(),
        amountMinor: safeIntegerSchema.positive(),
        cashAccountId: safeIntegerSchema.optional(),
        paidAt: z.string().optional(),
        notes: z.string().optional(),
        requestKey: z.string().trim().min(8).max(100)
      }),
      permission: P.purchases.paySupplier
    },
    (req, ctx) => ({ id: purchasing.paySupplier(req, ctx) })
  )
  on(
    bus,
    IPC_CHANNELS.purchases.updateSupplierPayment,
    {
      schema: z.object({
        id: safeIntegerSchema,
        amountMinor: safeIntegerSchema.positive(),
        cashAccountId: safeIntegerSchema.nullable().optional(),
        paidAt: z.string().min(1),
        notes: z.string().nullable().optional()
      }),
      permission: P.purchases.editSupplierPayment
    },
    ({ id, ...input }, ctx) => {
      purchasing.updateSupplierPayment(id, input, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.purchases.deleteSupplierPayment,
    { schema: idSchema, permission: P.purchases.deleteSupplierPayment },
    ({ id }, ctx) => {
      purchasing.reverseSupplierPayment(id, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.purchases.fullDeletePreview,
    { schema: idSchema, permission: P.purchases.fullDelete },
    ({ id }) => purchasing.purchaseFullDeletePreview(id)
  )
  on(
    bus,
    IPC_CHANNELS.purchases.fullDelete,
    {
      schema: z.object({ id: safeIntegerSchema, confirmation: z.string().min(1) }),
      permission: P.purchases.fullDelete
    },
    (req, ctx) => purchasing.fullDeletePurchase(req, ctx)
  )

  // ---- Products & Product Components (materials / machines / commission) ----
  const bomLineSchema = z.object({
    materialId: safeIntegerSchema,
    qtyMicro: safeIntegerSchema.positive(),
    unit: z.string(),
    dimensions: z.string().nullable().optional(),
    componentName: z.string().nullable().optional(),
    unitPriceMicro: safeIntegerSchema.nonnegative().nullable().optional(),
    notes: z.string().nullable().optional()
  })
  const productMachineLineSchema = z.object({
    machineId: safeIntegerSchema,
    usageQtyMicro: safeIntegerSchema.positive(),
    rateMicro: safeIntegerSchema.nonnegative().nullable().optional(),
    notes: z.string().nullable().optional()
  })
  const productCommissionLineSchema = z.object({
    workerId: safeIntegerSchema.nullable().optional(),
    amountMinor: safeIntegerSchema.positive(),
    notes: z.string().nullable().optional()
  })
  on(
    bus,
    IPC_CHANNELS.products.list,
    { schema: optionalFilters, permission: P.products.view },
    (req) => products.listProducts(req)
  )
  on(bus, IPC_CHANNELS.products.get, { schema: idSchema, permission: P.products.view }, ({ id }) =>
    products.getProduct(id)
  )
  on(
    bus,
    IPC_CHANNELS.products.create,
    {
      schema: z.object({
        code: z.string().min(1),
        name: z.string().min(1),
        description: z.string().optional(),
        defaultPriceMinor: safeIntegerSchema.optional(),
        bom: z.array(bomLineSchema).optional(),
        machines: z.array(productMachineLineSchema).optional(),
        commission: z.array(productCommissionLineSchema).optional()
      }),
      permission: P.products.manage
    },
    (req, ctx) => ({ id: products.createProduct(req, ctx) })
  )
  on(
    bus,
    IPC_CHANNELS.products.update,
    {
      schema: z.object({
        id: safeIntegerSchema,
        code: z.string().optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        defaultPriceMinor: safeIntegerSchema.optional(),
        active: z.boolean().optional()
      }),
      permission: P.products.manage
    },
    ({ id, ...rest }, ctx) => {
      products.updateProduct(id, rest, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.products.stockIssuePreview,
    { schema: z.object({ productId: safeIntegerSchema, quantityMicro: safeIntegerSchema }), permission: P.products.view },
    (req) => production.standardStockIssuePreview(req)
  )
  on(
    bus,
    IPC_CHANNELS.products.issueStockFromBom,
    {
      schema: z.object({
        productId: safeIntegerSchema,
        quantityMicro: safeIntegerSchema,
        requestKey: z.string().trim().min(8).max(100)
      }),
      permission: P.inventory.consume
    },
    (req, ctx) => production.issueStandardStockFromBom(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.products.setBom,
    {
      schema: z.object({ productId: safeIntegerSchema, lines: z.array(bomLineSchema) }),
      permission: P.products.manage
    },
    (req, ctx) => {
      products.replaceBom(req.productId, req.lines, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.products.setMachines,
    {
      schema: z.object({ productId: safeIntegerSchema, lines: z.array(productMachineLineSchema) }),
      permission: P.products.manage
    },
    (req, ctx) => {
      products.replaceProductMachines(req.productId, req.lines, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.products.setCommission,
    {
      schema: z.object({ productId: safeIntegerSchema, lines: z.array(productCommissionLineSchema) }),
      permission: P.products.manage
    },
    (req, ctx) => {
      products.replaceProductCommission(req.productId, req.lines, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.products.fullDeletePreview,
    { schema: idSchema, permission: P.products.fullDelete },
    ({ id }) => products.productFullDeletePreview(id)
  )
  on(
    bus,
    IPC_CHANNELS.products.fullDelete,
    {
      schema: z.object({ id: safeIntegerSchema, confirmation: z.string().min(1) }),
      permission: P.products.fullDelete
    },
    (req, ctx) => products.fullDeleteProduct(req, ctx)
  )

  // ---- Quotations (Preliminary Invoice) ----
  const quotationLineSchema = z.object({
    materialColors: z
      .array(
        z.object({
          materialId: safeIntegerSchema.int().positive(),
          colorIds: z.array(safeIntegerSchema.int().positive()).max(500),
          discardLegacyColors: z.boolean().optional()
        })
      )
      .max(500)
      .optional(),
    retainedUnmappedColorIds: z.array(safeIntegerSchema.int().positive()).max(500).optional(),
    sourceLineId: safeIntegerSchema.int().positive().optional(),
    materialIds: z.array(safeIntegerSchema.int().positive()).max(500).optional(),
    colorIds: z.array(safeIntegerSchema.int().positive()).max(500).optional(),
    accessoryIds: z.array(safeIntegerSchema.int().positive()).max(500).optional(),
    discardLegacyMaterials: z.boolean().optional(),
    discardLegacyColors: z.boolean().optional(),
    discardLegacyAccessories: z.boolean().optional(),
    lineKind: z.enum(['standard', 'custom', 'material', 'delivery', 'installation']),
    productId: safeIntegerSchema.nullable().optional(),
    materialId: safeIntegerSchema.nullable().optional(),
    description: z.string().min(1),
    specifications: z.string().nullable().optional(),
    dimensions: z.string().nullable().optional(),
    materialType: z.string().nullable().optional(),
    colorCode: z.string().nullable().optional(),
    accessories: z.string().nullable().optional(),
    accessoryMaterialId: safeIntegerSchema.nullable().optional(),
    materialTypeMaterialId: safeIntegerSchema.nullable().optional(),
    quantityMicro: safeIntegerSchema.positive(),
    unitPriceMinor: safeIntegerSchema.nonnegative(),
    notes: z.string().nullable().optional()
  })
  /**
   * Per-field PDF visibility. The keys are pinned to the shared engine's
   * own list, so an unknown field name from the renderer is rejected at
   * the boundary rather than being persisted as dead JSON.
   */
  const printVisibilitySchema = z
    .object(
      Object.fromEntries(
        PRINT_VISIBILITY_KEYS.map((key) => [key, z.boolean().optional()])
      ) as Record<(typeof PRINT_VISIBILITY_KEYS)[number], z.ZodOptional<z.ZodBoolean>>
    )
    .strict()
  /** Money is always a non-negative integer count of minor units (AD-1). */
  const chargeMoneySchema = safeIntegerSchema.int().nonnegative().optional()

  on(
    bus,
    IPC_CHANNELS.quotations.list,
    { schema: pagedFilters, permission: P.quotations.view },
    ({ limit, cursor, ...filter }) => quotations.listQuotations(filter, { limit, cursor })
  )
  on(
    bus,
    IPC_CHANNELS.quotations.get,
    { schema: idSchema, permission: P.quotations.view },
    ({ id }) => quotations.getQuotation(id)
  )
  on(
    bus,
    IPC_CHANNELS.quotations.create,
    {
      schema: z.object({
        customerId: safeIntegerSchema,
        lines: z.array(quotationLineSchema).min(1),
        discountKind: z.enum(['none', 'amount', 'percent']).optional(),
        discountValue: safeIntegerSchema.optional(),
        depositPercentBp: safeIntegerSchema.optional(),
        requiresInstallation: z.boolean().optional(),
        requiresDelivery: z.boolean().optional(),
        meterPriceMinor: chargeMoneySchema,
        installationPriceMinor: chargeMoneySchema,
        deliveryPriceMinor: chargeMoneySchema,
        printVisibility: printVisibilitySchema.optional(),
        notes: z.string().optional()
      }),
      permission: P.quotations.manage
    },
    (req, ctx) => quotations.createQuotation(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.quotations.createStandard,
    {
      schema: z.object({
        customerId: safeIntegerSchema,
        productId: safeIntegerSchema,
        quantityMicro: safeIntegerSchema.positive(),
        unitPriceMinor: safeIntegerSchema.optional(),
        discountKind: z.enum(['none', 'amount', 'percent']).optional(),
        discountValue: safeIntegerSchema.optional(),
        depositPercentBp: safeIntegerSchema.optional(),
        requiresInstallation: z.boolean().optional(),
        requiresDelivery: z.boolean().optional(),
        dimensions: z.string().optional(),
        colorCode: z.string().optional(),
        accessories: z.string().optional(),
        specifications: z.string().optional(),
        notes: z.string().optional()
      }),
      permission: P.quotations.manage
    },
    (req, ctx) => quotations.createStandardQuotation(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.quotations.update,
    {
      schema: z.object({
        id: safeIntegerSchema,
        lines: z.array(quotationLineSchema).optional(),
        discountKind: z.enum(['none', 'amount', 'percent']).optional(),
        discountValue: safeIntegerSchema.optional(),
        depositPercentBp: safeIntegerSchema.optional(),
        requiresInstallation: z.boolean().optional(),
        requiresDelivery: z.boolean().optional(),
        meterPriceMinor: chargeMoneySchema,
        installationPriceMinor: chargeMoneySchema,
        deliveryPriceMinor: chargeMoneySchema,
        printVisibility: printVisibilitySchema.optional(),
        notes: z.string().optional()
      }),
      permission: P.quotations.manage
    },
    ({ id, ...rest }, ctx) => {
      quotations.updateQuotation(id, rest, ctx)
      return { ok: true }
    }
  )
  // Workflow pass: issuing prepares the customer document. It creates no
  // order, no approved invoice and no production of any kind.
  on(
    bus,
    IPC_CHANNELS.quotations.issue,
    { schema: idSchema, permission: P.quotations.issue },
    ({ id }, ctx) => quotations.issueQuotation(id, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.quotations.revise,
    { schema: idSchema, permission: P.quotations.manage },
    ({ id }, ctx) => quotations.createRevision(id, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.quotations.cancel,
    { schema: idSchema, permission: P.quotations.manage },
    ({ id }, ctx) => {
      quotations.cancelQuotation(id, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.quotations.deletePreview,
    { schema: idSchema, permission: P.quotations.manage },
    ({ id }) => quotations.quotationDeletePreview(id)
  )
  // No reason is ever collected; a converted invoice needs the typed
  // invoice number instead, and the service re-checks orders.fullDelete.
  on(
    bus,
    IPC_CHANNELS.quotations.remove,
    {
      schema: z.object({ id: safeIntegerSchema, confirmation: z.string().optional() }),
      permission: P.quotations.remove
    },
    (req, ctx) => quotations.deleteQuotation(req, ctx)
  )
  // ---- Orders ----
  on(
    bus,
    IPC_CHANNELS.orders.list,
    {
      schema: pagedFilters.extend({
        archived: z.boolean().optional(),
        includeArchived: z.boolean().optional()
      }),
      permission: P.orders.view
    },
    ({ limit, cursor, ...filter }) => orders.listOrders(filter, { limit, cursor })
  )
  on(
    bus,
    IPC_CHANNELS.orders.archive,
    { schema: idSchema, permission: P.orders.archive },
    ({ id }, ctx) => orders.archiveOrder({ id, archive: true }, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.orders.restore,
    { schema: idSchema, permission: P.orders.archive },
    ({ id }, ctx) => orders.archiveOrder({ id, archive: false }, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.orders.reverseCompletion,
    { schema: idSchema, permission: P.orders.complete },
    (req, ctx) => orders.reverseOrderCompletion(req, ctx)
  )
  on(bus, IPC_CHANNELS.orders.get, { schema: idSchema, permission: P.orders.view }, ({ id }) => {
    const detail = orders.getOrder(id)
    const safeOrder = omitFields(detail.order, [
      'estimatedMaterialMinor',
      'estimatedWorkerMinor',
      'estimatedMachineMinor',
      'estimatedOtherMinor'
    ] as const)
    return { ...detail, order: safeOrder }
  })
  on(
    bus,
    IPC_CHANNELS.orders.update,
    {
      schema: z.object({
        id: safeIntegerSchema,
        address: z.string().optional(),
        notes: z.string().optional()
      }),
      permission: P.orders.manage
    },
    ({ id, ...rest }, ctx) => {
      orders.updateOrder(id, rest, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.orders.fulfillFromStock,
    { schema: z.object({ orderId: safeIntegerSchema }), permission: P.orders.manage },
    (req, ctx) => orders.fulfillFromStock(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.orders.remove,
    { schema: idSchema, permission: P.orders.fullDelete },
    ({ id }, ctx) => {
      orders.deleteOrder(id, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.orders.deletionBlockers,
    { schema: idSchema, permission: P.orders.view },
    ({ id }) => {
      orders.assertOrderDeleteCancelEligible(id)
      return { blockers: orders.orderDeletionBlockers(id) }
    }
  )
  on(
    bus,
    IPC_CHANNELS.orders.fullDeletePreview,
    { schema: idSchema, permission: P.orders.fullDelete },
    ({ id }) => {
      orders.assertOrderDeleteCancelEligible(id)
      return orders.fullDeletePreview(id)
    }
  )
  on(
    bus,
    IPC_CHANNELS.orders.fullDelete,
    {
      schema: z.object({ id: safeIntegerSchema, confirmation: z.string().min(1) }),
      permission: P.orders.fullDelete
    },
    (req, ctx) => orders.fullDeleteOrder(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.orders.estimate,
    { schema: idSchema, permission: P.orders.viewEstimatedCost },
    ({ id }, ctx) => {
      const estimate = costing.orderCostEstimate(id)
      return {
        orderId: estimate.orderId,
        estimatedMaterialMinor: estimate.estimatedMaterialMinor,
        estimatedWorkerMinor: estimate.estimatedWorkerMinor,
        estimatedMachineMinor: estimate.estimatedMachineMinor,
        estimatedOtherMinor: estimate.estimatedOtherMinor,
        estimatedOrderExpenseMinor: estimate.estimatedOrderExpenseMinor,
        estimatedTotalMinor: estimate.estimatedTotalMinor,
        sellingPriceMinor: estimate.sellingPriceMinor,
        ...(hasPermission(ctx.session, P.orders.viewExpectedProfit)
          ? { expectedProfitMinor: estimate.expectedProfitMinor }
          : {}),
        ...(hasPermission(ctx.session, P.orders.viewActualCost)
          ? { actualTotalMinor: estimate.actualTotalMinor, varianceMinor: estimate.varianceMinor }
          : {}),
        ...(hasPermission(ctx.session, P.orders.viewActualProfit)
          ? { actualProfitMinor: estimate.actualProfitMinor }
          : {})
      }
    }
  )
  // The Customer Order's commercial + planning snapshot (materials,
  // machines, workers, estimate) — never actual execution.
  on(
    bus,
    IPC_CHANNELS.orders.planningSnapshot,
    // Production Preparation is its own privilege, ON TOP of reaching
    // the Customer Order page — hence the second check below rather
    // than a replacement for orders.view.
    { schema: idSchema, permission: P.productionPrep.view },
    ({ id }, ctx) => {
      requirePermission(ctx.session, P.orders.view)
      const snapshot = planning.orderPlanningSnapshot(id)
      const canViewCost = hasPermission(ctx.session, P.orders.viewEstimatedCost)
      const canViewProfit = hasPermission(ctx.session, P.orders.viewExpectedProfit)
      return {
        orderId: snapshot.orderId,
        sellingPriceMinor: snapshot.sellingPriceMinor,
        ...(canViewCost
          ? {
              materials: snapshot.materials,
              machines: snapshot.machines,
              workers: snapshot.workers,
              expenses: snapshot.expenses,
              estimatedMaterialMinor: snapshot.estimatedMaterialMinor,
              estimatedMachineMinor: snapshot.estimatedMachineMinor,
              estimatedWorkerMinor: snapshot.estimatedWorkerMinor,
              estimatedOtherMinor: snapshot.estimatedOtherMinor,
              estimatedOrderExpenseMinor: snapshot.estimatedOrderExpenseMinor,
              totalEstimatedCostMinor: snapshot.totalEstimatedCostMinor
            }
          : {}),
        ...(canViewProfit ? { expectedProfitMinor: snapshot.expectedProfitMinor } : {})
      }
    }
  )
  on(
    bus,
    IPC_CHANNELS.orders.fulfillment,
    { schema: idSchema, permission: P.orders.view },
    ({ id }) => ({
      status: production.fulfillmentStatus(id),
      deliveries: production.deliveriesForOrder(id)
    })
  )
  // Part 3/4: the Customer Order is the production-planning point. These
  // write PLANNED configuration only — no stock, no payroll, no cash.
  on(
    bus,
    IPC_CHANNELS.orders.savePlannedMaterials,
    {
      schema: z.object({ orderId: safeIntegerSchema, lines: z.array(plannedMaterialSchema) }),
      permission: P.productionPrep.manage
    },
    (req, ctx) => {
      requirePermission(ctx.session, P.orders.view)
      planning.savePlannedMaterials({ orderId: req.orderId }, req.lines, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.orders.savePlannedMachines,
    {
      schema: z.object({
        orderId: safeIntegerSchema,
        lines: z.array(
          z.object({
            id: safeIntegerSchema.int().positive().optional(),
            machineId: safeIntegerSchema.int().positive().nullable().optional(),
            machineName: z.string().min(1),
            usageQtyMicro: safeIntegerSchema.int().nonnegative().optional(),
            usageUnit: z.string().nullable().optional(),
            notes: z.string().nullable().optional()
          })
        )
      }),
      permission: P.productionPrep.manage
    },
    (req, ctx) => {
      requirePermission(ctx.session, P.orders.view)
      planning.savePlannedMachines({ orderId: req.orderId }, req.lines, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.orders.savePlannedWorkers,
    {
      schema: z.object({
        orderId: safeIntegerSchema,
        lines: z.array(
          z.object({
            workerId: safeIntegerSchema.nullable().optional(),
            workerName: z.string().min(1),
            commissionMode: z.enum(['estimated', 'meter']).optional(),
            estimatedCostMinor: safeIntegerSchema.int().nonnegative().optional(),
            meterRateMicro: safeIntegerSchema.int().nonnegative().nullable().optional(),
            meterQtyMicro: safeIntegerSchema.int().nonnegative().nullable().optional(),
            notes: z.string().nullable().optional()
          })
        )
      }),
      permission: P.productionPrep.manage
    },
    (req, ctx) => {
      requirePermission(ctx.session, P.orders.view)
      planning.savePlannedWorkers({ orderId: req.orderId }, req.lines, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.orders.savePlannedExpenses,
    {
      schema: z.object({
        orderId: safeIntegerSchema,
        lines: z.array(
          z.object({ expenseName: z.string().min(1), amountMinor: safeIntegerSchema.int().nonnegative() })
        )
      }),
      permission: P.productionPrep.manage
    },
    (req, ctx) => {
      requirePermission(ctx.session, P.orders.view)
      planning.savePlannedOrderExpenses(req.orderId, req.lines, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.orders.recordPayment,
    {
      schema: z.object({
        orderId: safeIntegerSchema,
        amountMinor: safeIntegerSchema.positive(),
        cashAccountId: safeIntegerSchema.optional(),
        paidAt: z.string().optional(),
        notes: z.string().optional(),
        requestKey: z.string().trim().min(8).max(100)
      }),
      permission: P.payments.manage
    },
    (req, ctx) => orders.recordPayment(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.orders.refundPayment,
    {
      schema: z.object({
        orderId: safeIntegerSchema.int().positive(),
        amountMinor: safeIntegerSchema.int().positive(),
        cashAccountId: safeIntegerSchema.int().positive(),
        requestKey: z.string().trim().min(8).max(100),
        refundedAt: z.string().optional()
      }),
      permission: P.payments.refund
    },
    (req, ctx) => orders.refundPayment(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.orders.cancel,
    {
      schema: z.object({ orderId: safeIntegerSchema, reason: z.string().min(1) }),
      permission: P.orders.cancel
    },
    (req, ctx) => {
      orders.cancelOrder(req, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.orders.costing,
    { schema: idSchema, permission: P.orders.view },
    ({ id }, ctx) => {
      const detail = costing.orderCostDetail(id)
      const canViewCost = hasPermission(ctx.session, P.orders.viewActualCost)
      const canViewProfit = hasPermission(ctx.session, P.orders.viewActualProfit)
      return {
        summary: {
          orderId: detail.summary.orderId,
          documentNumber: detail.summary.documentNumber,
          sellingPriceMinor: detail.summary.sellingPriceMinor,
          isComplete: detail.summary.isComplete,
          ...(canViewCost
            ? {
                materialCostMinor: detail.summary.materialCostMinor,
                machineCostMinor: detail.summary.machineCostMinor,
                workerCostMinor: detail.summary.workerCostMinor,
                deliveryCostMinor: detail.summary.deliveryCostMinor,
                linkedExpensesMinor: detail.summary.linkedExpensesMinor,
                totalActualCostMinor: detail.summary.totalActualCostMinor,
                commercialMaterialValueMinor: detail.summary.commercialMaterialValueMinor,
                costBasisMinor: detail.summary.costBasisMinor
              }
            : {}),
          ...(canViewProfit ? { actualProfitMinor: detail.summary.actualProfitMinor } : {})
        },
        ...(canViewCost
          ? {
              materials: detail.materials,
              machines: detail.machines,
              workers: detail.workers
            }
          : {})
      }
    }
  )
  on(
    bus,
    IPC_CHANNELS.orders.profitability,
    { schema: optionalFilters, permission: P.orders.viewActualProfit },
    (req, ctx) => {
      requirePermission(ctx.session, P.orders.viewActualCost)
      return costing.orderProfitabilityReport({ from: req.from, to: req.to, completedOnly: true })
    }
  )

  // ---- Production orders ("أمر تصنيع") ----
  on(
    bus,
    IPC_CHANNELS.production.consumeMaterial,
    {
      schema: z.object({
        orderId: safeIntegerSchema.optional(),
        workSheetId: safeIntegerSchema.optional(),
        materialId: safeIntegerSchema,
        physicalQtyMicro: safeIntegerSchema.positive(),
        manualCommercialQtyMicro: safeIntegerSchema.optional(),
        overrideCommercialValueMinor: safeIntegerSchema.optional(),
        colorCode: z.string().optional(),
        notes: z.string().optional()
      }),
      permission: P.inventory.consume
    },
    (req, ctx) => production.consumeForOrder(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.production.materialReturns,
    { schema: z.object({ orderId: safeIntegerSchema.int().positive() }), permission: P.orders.view },
    (req, ctx) => {
      const overview = materialReturns.getMaterialReturnsOverview(req.orderId)
      const canViewCost = hasPermission(ctx.session, P.orders.viewActualCost)
      return {
        materials: overview.materials.map((row) => ({
          materialId: row.materialId,
          materialName: row.materialName,
          unit: row.unit,
          issuedQtyMicro: row.issuedQtyMicro,
          returnedQtyMicro: row.returnedQtyMicro,
          returnableQtyMicro: row.returnableQtyMicro,
          netConsumedQtyMicro: row.netConsumedQtyMicro,
          ...(canViewCost
            ? {
                issuedCostMinor: row.issuedCostMinor,
                returnedCostMinor: row.returnedCostMinor,
                netCostMinor: row.netCostMinor
              }
            : {})
        })),
        returns: overview.returns.map((row) =>
          canViewCost ? row : omitFields(row, ['returnedCostMinor'] as const)
        )
      }
    }
  )
  on(
    bus,
    IPC_CHANNELS.production.createMaterialReturn,
    {
      schema: z.object({
        orderId: safeIntegerSchema.int().positive(),
        materialId: safeIntegerSchema.int().positive(),
        quantityMicro: safeIntegerSchema.int().positive(),
        notes: z.string().max(2000).nullable().optional(),
        requestKey: z.string().min(8).max(100)
      }),
      permission: P.production.returnMaterial
    },
    (req, ctx) => materialReturns.createMaterialReturn(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.production.editMaterialReturn,
    {
      schema: z.object({
        id: safeIntegerSchema.int().positive(),
        quantityMicro: safeIntegerSchema.int().positive(),
        notes: z.string().max(2000).nullable().optional(),
        expectedVersion: safeIntegerSchema.int().nonnegative(),
        requestKey: z.string().min(8).max(100)
      }),
      permission: P.production.returnMaterial
    },
    (req, ctx) => materialReturns.editMaterialReturn(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.production.reverseMaterialReturn,
    {
      schema: z.object({
        id: safeIntegerSchema.int().positive(),
        expectedVersion: safeIntegerSchema.int().nonnegative(),
        requestKey: z.string().min(8).max(100)
      }),
      permission: P.production.returnMaterial
    },
    (req, ctx) => materialReturns.reverseMaterialReturn(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.production.correctMaterialConsumption,
    {
      schema: z.object({
        id: safeIntegerSchema,
        materialId: safeIntegerSchema,
        physicalQtyMicro: safeIntegerSchema.positive(),
        manualCommercialQtyMicro: safeIntegerSchema.optional(),
        overrideCommercialValueMinor: safeIntegerSchema.optional(),
        colorCode: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
        reason: z.string().min(1)
      }),
      permission: P.inventory.consume
    },
    (req, ctx) => production.correctMaterialConsumption(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.production.reverseMaterialConsumption,
    {
      schema: z.object({ id: safeIntegerSchema, reason: z.string().min(1) }),
      permission: P.inventory.consume
    },
    (req, ctx) => {
      production.reverseMaterialConsumption(req, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.production.materialLines,
    { schema: z.object({ orderId: safeIntegerSchema }), permission: P.orders.view },
    (req, ctx) =>
      production.materialLinesForOrder(req.orderId).map((row) => {
        if (hasPermission(ctx.session, P.orders.viewActualCost)) return row
        return omitFields(row, ['actualCostMinor', 'returnedCostMinor', 'netCostMinor'] as const)
      })
  )
  on(
    bus,
    IPC_CHANNELS.production.issueWorkSheet,
    {
      schema: z.object({
        orderId: safeIntegerSchema.optional(),
        productId: safeIntegerSchema.optional(),
        quantityMicro: safeIntegerSchema.optional(),
        workerIds: z.array(safeIntegerSchema).optional(),
        notes: z.string().optional(),
        overrideDepositRequirement: z.boolean().optional()
      }),
      permission: P.worksheets.issue
    },
    (req, ctx) => production.issueWorkSheet(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.production.listWorkSheets,
    {
      schema: pagedFilters.extend({
        status: z.string().optional(),
        includeReversed: z.boolean().optional()
      }),
      permission: P.worksheets.view
    },
    ({ limit, cursor, ...filter }) => production.listWorkSheets(filter, { limit, cursor })
  )
  on(
    bus,
    IPC_CHANNELS.production.listOperationalWorkSheets,
    {
      schema: pagedFilters.extend({ status: z.string().optional() }),
      permission: P.worksheets.view
    },
    ({ limit, cursor, ...filter }) => production.listOperationalWorkSheets(filter, { limit, cursor })
  )
  on(
    bus,
    IPC_CHANNELS.production.getWorkSheet,
    { schema: idSchema, permission: P.worksheets.view },
    ({ id }, ctx) => {
      const detail = production.getProductionOrder(id)
      const canViewActualCost = hasPermission(ctx.session, P.orders.viewActualCost)
      const canViewEstimatedCost = hasPermission(ctx.session, P.orders.viewEstimatedCost)
      const order = detail.order
        ? omitFields(detail.order, [
            'estimatedMaterialMinor',
            'estimatedWorkerMinor',
            'estimatedMachineMinor',
            'estimatedOtherMinor'
          ] as const)
        : null
      const plannedMaterials = canViewEstimatedCost
        ? detail.plannedMaterials
        : detail.plannedMaterials.map((line) =>
            omitFields(line, ['estimatedUnitCostMicro', 'estimatedTotalMinor'] as const)
          )
      const preparedWorkers = canViewEstimatedCost
        ? detail.preparedWorkers
        : detail.preparedWorkers.map((line) => omitFields(line, ['estimatedCostMinor', 'meterRateMicro'] as const))
      const preparedMachines = canViewEstimatedCost
        ? detail.preparedMachines
        : detail.preparedMachines.map((line) => omitFields(line, ['estimatedCostMinor', 'rateMicro'] as const))
      if (canViewActualCost) return { ...detail, order, plannedMaterials, preparedWorkers, preparedMachines }
      return {
        ...omitFields(detail, ['actualCostMinor'] as const),
        order,
        plannedMaterials,
        preparedWorkers,
        preparedMachines,
        materialLines: detail.materialLines.map((line) =>
          omitFields(line, ['actualCostMinor', 'returnedCostMinor', 'netCostMinor'] as const)
        ),
        machineUsage: detail.machineUsage.map((usage) =>
          omitFields(usage, ['finalAmountMinor'] as const)
        ),
        assignments: detail.assignments.map((assignment) =>
          omitFields(assignment, ['amountMinor', 'baseAmountMinor'] as const)
        )
      }
    }
  )
  on(
    bus,
    IPC_CHANNELS.production.reverseWorkSheet,
    {
      schema: z.object({
        id: safeIntegerSchema.int().positive(),
        expectedToken: z.string().regex(/^[a-f0-9]{64}$/),
        confirmation: z.string().max(100),
        reason: z.string().trim().min(1).max(2000)
      }),
      permission: P.worksheets.reverse
    },
    (req, ctx) => production.reverseWorkSheet(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.production.startProduction,
    { schema: idSchema, permission: P.worksheets.issue },
    ({ id }, ctx) => production.startProduction(id, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.production.completeProduction,
    { schema: idSchema, permission: P.worksheets.issue },
    ({ id }, ctx) => production.completeProduction(id, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.production.cancelProduction,
    {
      schema: z.object({ id: safeIntegerSchema, reason: z.string().min(1) }),
      permission: P.worksheets.reverse
    },
    (req, ctx) => {
      production.cancelProductionOrder(req, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.production.updatePlannedMaterials,
    {
      schema: z.object({ workSheetId: safeIntegerSchema, lines: z.array(plannedMaterialSchema) }),
      permission: P.worksheets.issue
    },
    (req, ctx) => {
      // Editing the factory's material report never touches the approved
      // preliminary invoice — this writes only the production order's copy.
      production.assertProductionOpen(req.workSheetId)
      planning.savePlannedMaterials({ workSheetId: req.workSheetId }, req.lines, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.production.remove,
    { schema: idSchema, permission: P.worksheets.reverse },
    ({ id }, ctx) => {
      production.deleteProductionOrder(id, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.production.issueRelease,
    {
      schema: z.object({
        orderId: safeIntegerSchema,
        kind: z.enum(['delivery', 'installation', 'transport', 'delivery_installation']),
        workerIds: z.array(safeIntegerSchema).optional(),
        notes: z.string().optional(),
        showPaidExitSentence: z.boolean().optional(),
        unpaidReleaseOverride: z.boolean().optional()
      }),
      permission: P.releases.issue
    },
    (req, ctx) => production.issueRelease(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.production.reverseRelease,
    {
      schema: z.object({
        id: safeIntegerSchema.int().positive(),
        expectedToken: z.string().regex(/^[a-f0-9]{64}$/)
      }),
      permission: P.releases.reverse
    },
    (req, ctx) => production.reverseRelease(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.production.listReleases,
    {
      schema: pagedFilters.extend({
        includeReversed: z.boolean().optional(),
        awaitingCompletion: z.boolean().optional()
      }),
      permission: P.releases.view
    },
    ({ limit, cursor, ...filter }) => production.listReleases(filter, { limit, cursor })
  )
  on(
    bus,
    IPC_CHANNELS.production.recordDelivery,
    {
      schema: z.object({
        orderId: safeIntegerSchema,
        kind: z.enum(['delivery', 'installation', 'delivery_installation', 'handover']),
        releaseId: safeIntegerSchema.optional(),
        workerIds: z.array(safeIntegerSchema).optional(),
        recordedAt: z.string().optional(),
        scheduledAt: z.string().optional(),
        address: z.string().optional(),
        actualCostMinor: safeIntegerSchema.optional(),
        notes: z.string().optional(),
      }),
      permission: P.deliveries.register
    },
    (req, ctx) => production.recordDelivery(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.production.cancelDelivery,
    {
      schema: z.object({ id: safeIntegerSchema, reason: z.string().optional() }),
      permission: P.deliveries.deleteOrReverse
    },
    (req, ctx) => {
      production.cancelDelivery(req, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.production.listDeliveries,
    {
      schema: pagedFilters.extend({ orderId: safeIntegerSchema.optional() }),
      permission: P.deliveries.view
    },
    ({ limit, cursor, ...filter }, ctx) => {
      const page = production.listDeliveries(filter, { limit, cursor })
      if (hasPermission(ctx.session, P.orders.viewActualCost)) return page
      return { ...page, items: page.items.map((row) => omitFields(row, ['actualCostMinor'] as const)) }
    }
  )
  on(
    bus,
    IPC_CHANNELS.production.finishedGoods,
    { schema: z.object({ productId: safeIntegerSchema.optional() }), permission: P.products.view },
    (req) => finishedGoods.listFinishedGoods(req)
  )
  on(
    bus,
    IPC_CHANNELS.production.finishedGoodsMovements,
    {
      schema: z.object({ productId: safeIntegerSchema.optional(), orderId: safeIntegerSchema.optional(), ...pageRequestShape }),
      permission: P.products.view
    },
    ({ limit, cursor, ...filter }) => finishedGoods.listFinishedGoodsMovements(filter, { limit, cursor })
  )

  // ---- Uncollected manufactured products ----
  // Every read goes through the service, which strips internal cost and
  // sale-price fields from the response unless the SESSION itself holds
  // `uncollectedProducts.viewCost`. Hiding them in the renderer would
  // not be security — they never leave main in the first place.
  on(
    bus,
    IPC_CHANNELS.uncollectedProducts.list,
    {
      schema: pagedFilters.extend({
        status: z.enum(['available', 'reserved', 'sold', 'resumed']).optional(),
        sourceOrderId: safeIntegerSchema.int().positive().optional()
      }),
      permission: P.uncollectedProducts.view
    },
    ({ limit, cursor, ...filter }, ctx) => uncollected.listUncollectedProducts(filter, ctx.session, { limit, cursor })
  )
  on(
    bus,
    IPC_CHANNELS.uncollectedProducts.get,
    { schema: idSchema, permission: P.uncollectedProducts.view },
    ({ id }, ctx) => uncollected.getUncollectedProduct(id, ctx.session)
  )
  on(
    bus,
    IPC_CHANNELS.uncollectedProducts.resume,
    {
      schema: z.object({
        id: safeIntegerSchema.int().positive(),
        confirmation: z.string(),
        requestKey: z.string().min(1),
        expectedProductIds: z.array(safeIntegerSchema.int().positive()).min(1)
      }),
      permission: P.uncollectedProducts.resume
    },
    (req, ctx) => uncollected.resumeOriginalOrder(req, ctx)
  )

  on(
    bus,
    IPC_CHANNELS.uncollectedProducts.available,
    {
      schema: z.object({ search: z.string().optional() }),
      // Choosing one for a sale is a selling action, not a browsing one.
      permission: P.uncollectedProducts.sell
    },
    (req) => uncollected.availableUncollectedProducts(req.search)
  )
  on(
    bus,
    IPC_CHANNELS.uncollectedProducts.forOrder,
    { schema: idSchema, permission: P.uncollectedProducts.view },
    ({ id }) => uncollected.productsFromOrder(id)
  )

  // ---- Final invoices ----
  on(
    bus,
    IPC_CHANNELS.finalInvoices.list,
    {
      schema: pagedFilters.extend({
        status: z.string().optional(),
        orderId: safeIntegerSchema.optional(),
        archived: z.boolean().optional()
      }),
      permission: P.finalInvoices.view
    },
    ({ limit, cursor, ...filter }, ctx) => finalInvoices.listFinalInvoices(filter, ctx.session, { limit, cursor })
  )
  on(
    bus,
    IPC_CHANNELS.finalInvoices.get,
    { schema: idSchema, permission: P.finalInvoices.view },
    ({ id }) => finalInvoices.getFinalInvoice(id)
  )
  on(bus, IPC_CHANNELS.finalInvoices.depositDefault, { permission: P.finalInvoices.view }, () =>
    ({ depositPercentBp: settings.getDefaultDepositPercentBp() })
  )
  const finalInvoiceLineSchema = z.object({
    materialColors: z
      .array(
        z.object({
          materialId: safeIntegerSchema.int().positive(),
          colorIds: z.array(safeIntegerSchema.int().positive()).max(500),
          discardLegacyColors: z.boolean().optional()
        })
      )
      .max(500)
      .optional(),
    retainedUnmappedColorIds: z.array(safeIntegerSchema.int().positive()).max(500).optional(),
    sourceLineId: safeIntegerSchema.int().positive().optional(),
    materialIds: z.array(safeIntegerSchema.int().positive()).max(500).optional(),
    colorIds: z.array(safeIntegerSchema.int().positive()).max(500).optional(),
    accessoryIds: z.array(safeIntegerSchema.int().positive()).max(500).optional(),
    discardLegacyMaterials: z.boolean().optional(),
    discardLegacyColors: z.boolean().optional(),
    discardLegacyAccessories: z.boolean().optional(),
    lineKind: z.enum(['standard', 'custom', 'material', 'delivery', 'installation']),
    productId: safeIntegerSchema.nullable().optional(),
    materialId: safeIntegerSchema.nullable().optional(),
    description: z.string().min(1),
    specifications: z.string().nullable().optional(),
    dimensions: z.string().nullable().optional(),
    materialType: z.string().nullable().optional(),
    colorCode: z.string().nullable().optional(),
    accessories: z.string().nullable().optional(),
    accessoryMaterialId: safeIntegerSchema.nullable().optional(),
    materialTypeMaterialId: safeIntegerSchema.nullable().optional(),
    quantityMicro: safeIntegerSchema.positive(),
    unitPriceMinor: safeIntegerSchema.nonnegative(),
    /** Sells an existing physical product instead of building one. */
    uncollectedProductId: safeIntegerSchema.int().positive().nullable().optional(),
    notes: z.string().nullable().optional()
  })
  on(
    bus,
    IPC_CHANNELS.finalInvoices.create,
    {
      schema: z.object({
        customerId: safeIntegerSchema,
        lines: z.array(finalInvoiceLineSchema).min(1),
        discountKind: z.enum(['none', 'amount', 'percent']).optional(),
        discountValue: safeIntegerSchema.optional(),
        depositPercentBp: safeIntegerSchema.optional(),
        requiresInstallation: z.boolean().optional(),
        requiresDelivery: z.boolean().optional(),
        meterPriceMinor: chargeMoneySchema,
        installationPriceMinor: chargeMoneySchema,
        deliveryPriceMinor: chargeMoneySchema,
        paidAmountMinor: safeIntegerSchema.int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
        initialCashAccountId: safeIntegerSchema.int().positive().nullable().optional(),
        printVisibility: printVisibilitySchema.optional(),
        address: z.string().optional(),
        notes: z.string().optional(),
        // Terms picked before the invoice existed (create-flow pass) —
        // same catalog indexes addTerms takes, persisted in the same
        // transaction as the invoice and its items.
        termIndexes: z.array(safeIntegerSchema.int().nonnegative()).optional()
      }),
      permission: P.finalInvoices.manage
    },
    (req, ctx) => finalInvoices.createFinalInvoice(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.finalInvoices.createStandard,
    {
      schema: z.object({
        customerId: safeIntegerSchema,
        productId: safeIntegerSchema,
        quantityMicro: safeIntegerSchema.positive(),
        unitPriceMinor: safeIntegerSchema.optional(),
        discountKind: z.enum(['none', 'amount', 'percent']).optional(),
        discountValue: safeIntegerSchema.optional(),
        depositPercentBp: safeIntegerSchema.optional(),
        requiresInstallation: z.boolean().optional(),
        requiresDelivery: z.boolean().optional(),
        dimensions: z.string().optional(),
        colorCode: z.string().optional(),
        accessories: z.string().optional(),
        specifications: z.string().optional(),
        address: z.string().optional(),
        notes: z.string().optional()
      }),
      permission: P.finalInvoices.manage
    },
    (req, ctx) => finalInvoices.createStandardFinalInvoice(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.finalInvoices.update,
    {
      schema: z.object({
        id: safeIntegerSchema,
        lines: z.array(finalInvoiceLineSchema).optional(),
        discountKind: z.enum(['none', 'amount', 'percent']).optional(),
        discountValue: safeIntegerSchema.optional(),
        depositPercentBp: safeIntegerSchema.optional(),
        requiresInstallation: z.boolean().optional(),
        requiresDelivery: z.boolean().optional(),
        meterPriceMinor: chargeMoneySchema,
        installationPriceMinor: chargeMoneySchema,
        deliveryPriceMinor: chargeMoneySchema,
        paidAmountMinor: safeIntegerSchema.int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
        initialCashAccountId: safeIntegerSchema.int().positive().nullable().optional(),
        printVisibility: printVisibilitySchema.optional(),
        address: z.string().optional(),
        notes: z.string().optional()
      }),
      permission: P.finalInvoices.manage
    },
    ({ id, ...rest }, ctx) => {
      finalInvoices.updateFinalInvoice(id, rest, ctx)
      return { ok: true }
    }
  )
  // THE authoritative approval: it creates the Customer Order, exactly
  // once. Governed by the same permission that governed order creation
  // before this pass, so no existing role gains or loses authority.
  on(
    bus,
    IPC_CHANNELS.finalInvoices.unapprove,
    {
      schema: z.object({
        id: safeIntegerSchema.int().positive(),
        expectedRevision: safeIntegerSchema.int().min(0)
      }),
      permission: P.orders.unapproveInvoice
    },
    (req, ctx) => finalInvoices.unapproveFinalInvoice(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.finalInvoices.approve,
    {
      schema: idSchema.extend({ expectedRevision: safeIntegerSchema.int().nonnegative().optional() }),
      permission: P.finalInvoices.approve
    },
    ({ id, expectedRevision }, ctx) => finalInvoices.approveFinalInvoice(id, ctx, expectedRevision)
  )
  on(
    bus,
    IPC_CHANNELS.finalInvoices.cancel,
    {
      schema: z.object({ id: safeIntegerSchema, reason: z.string().min(1) }),
      permission: P.finalInvoices.cancel
    },
    (req, ctx) => {
      finalInvoices.cancelFinalInvoice(req, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.finalInvoices.remove,
    { schema: idSchema, permission: P.finalInvoices.remove },
    ({ id }, ctx) => {
      finalInvoices.deleteFinalInvoice(id, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.finalInvoices.forOrder,
    { schema: z.object({ orderId: safeIntegerSchema }), permission: P.finalInvoices.view },
    (req) => ({ invoice: finalInvoices.finalInvoiceForOrder(req.orderId) ?? null })
  )
  // The ONE authoritative global Terms/Conditions catalog (same source
  // as Settings and the Preliminary Invoice) — read here under the
  // Approved Invoice's own view permission, not settings.view, so a
  // sales role that can manage invoices is never blocked from it.
  on(bus, IPC_CHANNELS.finalInvoices.termsCatalog, { permission: P.finalInvoices.view }, () =>
    settings.getTerms()
  )
  on(
    bus,
    IPC_CHANNELS.finalInvoices.addTerms,
    {
      schema: z.object({
        id: safeIntegerSchema,
        termIndexes: z.array(safeIntegerSchema.int().nonnegative()).min(1)
      }),
      permission: P.finalInvoices.manage
    },
    (req, ctx) => {
      finalInvoices.addFinalInvoiceTerms(req.id, req.termIndexes, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.finalInvoices.removeTerm,
    {
      schema: z.object({ id: safeIntegerSchema, termId: safeIntegerSchema }),
      permission: P.finalInvoices.manage
    },
    (req, ctx) => {
      finalInvoices.removeFinalInvoiceTerm(req.id, req.termId, ctx)
      return { ok: true }
    }
  )

  // ---- Machines ----
  on(
    bus,
    IPC_CHANNELS.machines.list,
    { schema: optionalFilters, permission: P.machines.view },
    (req) => machines.listMachines(req)
  )
  on(
    bus,
    IPC_CHANNELS.machines.create,
    {
      schema: z.object({
        name: z.string().min(1),
        costingUnit: z.string().min(1),
        defaultRateMicro: safeIntegerSchema.nonnegative(),
        notes: z.string().optional()
      }),
      permission: P.machines.manage
    },
    (req, ctx) => ({ id: machines.createMachine(req, ctx) })
  )
  on(
    bus,
    IPC_CHANNELS.machines.update,
    {
      schema: z.object({
        id: safeIntegerSchema,
        name: z.string().optional(),
        costingUnit: z.string().optional(),
        defaultRateMicro: safeIntegerSchema.optional(),
        active: z.boolean().optional(),
        notes: z.string().optional()
      }),
      permission: P.machines.manage
    },
    ({ id, ...rest }, ctx) => {
      machines.updateMachine(id, rest, ctx)
      return { ok: true }
    }
  )
  // CC04B: تجهيز الإنتاج is the only authoring source for workers/machines. The Manufacturing Order
  // assign-worker / machine-usage write channels (add, update, remove) are intentionally not registered.
  on(
    bus,
    IPC_CHANNELS.machines.usageForOrder,
    { schema: z.object({ orderId: safeIntegerSchema }), permission: P.orders.view },
    (req) => machines.machineUsageForOrder(req.orderId)
  )
  on(
    bus,
    IPC_CHANNELS.machines.remove,
    { schema: idSchema, permission: P.machines.manage },
    ({ id }, ctx) => {
      machines.deleteMachine(id, ctx)
      return { ok: true }
    }
  )

  // ---- Workers ----
  on(
    bus,
    IPC_CHANNELS.workers.commissionAccounts,
    { schema: z.object({}).strict().optional(), permission: P.workers.finance },
    (_req, ctx) => workers.listCommissionPaymentAccounts(ctx)
  )
  on(
    bus,
    IPC_CHANNELS.workers.list,
    { schema: optionalFilters, permission: P.workers.view },
    (req) => workers.listWorkers(req)
  )
  on(
    bus,
    IPC_CHANNELS.workers.create,
    {
      schema: z.object({
        name: z.string().min(1),
        phone: z.string().optional(),
        defaultMethod: z.enum(['fixed', 'percent']).optional(),
        defaultCostingUnit: z.string().optional(),
        defaultRateMicro: safeIntegerSchema.optional(),
        notes: z.string().optional()
      }),
      permission: P.workers.manage
    },
    (req, ctx) => ({ id: workers.createWorker(req, ctx) })
  )
  on(
    bus,
    IPC_CHANNELS.workers.update,
    {
      schema: z.object({
        id: safeIntegerSchema,
        name: z.string().optional(),
        phone: z.string().optional(),
        defaultMethod: z.string().optional(),
        defaultCostingUnit: z.string().optional(),
        defaultRateMicro: safeIntegerSchema.optional(),
        active: z.boolean().optional(),
        notes: z.string().optional()
      }),
      permission: P.workers.manage
    },
    ({ id, ...rest }, ctx) => {
      workers.updateWorker(id, rest, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.workers.statement,
    { schema: idSchema.extend(pageRequestShape), permission: P.workers.finance },
    ({ id, limit, cursor }) => workers.workerStatement(id, { limit, cursor })
  )
  on(
    bus,
    IPC_CHANNELS.workers.transaction,
    {
      schema: z.object({
        workerId: safeIntegerSchema.int().positive(),
        kind: z.enum(['withdrawal', 'repayment']),
        amountMinor: safeIntegerSchema.int().positive().safe(),
        cashAccountId: safeIntegerSchema.int().positive().optional(),
        notes: z.string().optional(),
        occurredAt: z.string().optional(),
        requestKey: z.string().trim().min(8).max(100)
      }),
      permission: P.workers.finance
    },
    (req, ctx) => ({ id: workers.recordWorkerTransaction(req, ctx) })
  )
  on(
    bus,
    IPC_CHANNELS.workers.payCommission,
    {
      schema: z
        .object({
          workerId: safeIntegerSchema.int().positive(),
          amountMinor: safeIntegerSchema.int().positive().safe(),
          cashAccountId: safeIntegerSchema.int().positive(),
          notes: z.string().optional(),
          requestKey: z.string().trim().min(8).max(100)
        })
        .strict(),
      permission: P.workers.finance
    },
    (req, ctx) => ({ id: workers.payWorkerCommission(req, ctx) })
  )
  const workerTransactionSnapshotSchema = z
    .object({
      workerId: safeIntegerSchema.int().positive(),
      kind: z.string(),
      amountMinor: safeIntegerSchema.int().safe(),
      orderId: safeIntegerSchema.int().positive().nullable(),
      reversalOfTransactionId: safeIntegerSchema.int().positive().nullable(),
      cashAccountId: safeIntegerSchema.int().positive().nullable(),
      notes: z.string().nullable(),
      createdAt: z.string()
    })
    .strict()
  on(
    bus,
    IPC_CHANNELS.workers.updateTransaction,
    {
      schema: z
        .object({
          id: safeIntegerSchema.int().positive(),
          expected: workerTransactionSnapshotSchema,
          amountMinor: safeIntegerSchema.int().positive().safe(),
          cashAccountId: safeIntegerSchema.int().positive().nullable().optional(),
          notes: z.string().nullable().optional()
        })
        .strict(),
      permission: P.workers.finance
    },
    (req, ctx) => {
      workers.updateWorkerTransaction(req, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.workers.deleteTransaction,
    {
      schema: z
        .object({
          id: safeIntegerSchema.int().positive(),
          expected: workerTransactionSnapshotSchema
        })
        .strict(),
      permission: P.workers.finance
    },
    (req, ctx) => {
      workers.deleteWorkerTransaction(req, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.workers.remove,
    { schema: idSchema, permission: P.workers.manage },
    ({ id }, ctx) => workers.deleteWorker(id, ctx)
  )

  // ---- Employees ----
  on(
    bus,
    IPC_CHANNELS.employees.list,
    { schema: optionalFilters, permission: P.employees.view },
    (req) => employees.listEmployees(req)
  )
  on(
    bus,
    IPC_CHANNELS.employees.listFormerSettlements,
    { schema: z.object({}).strict(), permission: P.employees.finance },
    () => employees.listFormerEmployeeSettlements()
  )
  on(
    bus,
    IPC_CHANNELS.employees.create,
    {
      schema: z.object({
        name: z.string().min(1),
        position: z.string().optional(),
        phone: z.string().optional(),
        monthlySalaryMinor: safeIntegerSchema.nonnegative(),
        hiredAt: z.string().optional(),
        notes: z.string().optional()
      }),
      permission: P.employees.manage
    },
    (req, ctx) => ({ id: employees.createEmployee(req, ctx) })
  )
  on(
    bus,
    IPC_CHANNELS.employees.update,
    {
      schema: z
        .object({
          id: safeIntegerSchema,
          name: z.string().optional(),
          position: z.string().optional(),
          phone: z.string().optional(),
          monthlySalaryMinor: safeIntegerSchema.optional(),
          notes: z.string().optional(),
          effectiveFrom: z.string().optional()
        })
        .strict(),
      permission: P.employees.manage
    },
    ({ id, ...rest }, ctx) => {
      employees.updateEmployee(id, rest, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.employees.remove,
    {
      schema: z.object({ id: safeIntegerSchema, confirmation: z.string().min(1) }),
      permission: P.employees.manage
    },
    (req, ctx) => employees.deleteEmployee(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.employees.dismissFormerSettlement,
    { schema: idSchema, permission: P.employees.manage },
    ({ id }, ctx) => employees.dismissFormerEmployeeSettlement(id, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.employees.deletePreview,
    { schema: idSchema, permission: P.employees.manage },
    ({ id }) => employees.employeeDeletePreview(id)
  )
  // Level 3: removes the employee with their whole payroll history.
  // Its own permission key, enforced here and re-checked in the service.
  on(
    bus,
    IPC_CHANNELS.employees.fullDelete,
    {
      schema: z.object({ id: safeIntegerSchema, confirmation: z.string().min(1) }),
      permission: P.employees.fullDelete
    },
    (req, ctx) => employees.fullDeleteEmployee(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.employees.statement,
    { schema: idSchema.extend(pageRequestShape), permission: P.employees.finance },
    ({ id, limit, cursor }) => employees.employeeStatement(id, { limit, cursor })
  )
  on(
    bus,
    IPC_CHANNELS.employees.paySalary,
    {
      schema: z.object({
        employeeId: safeIntegerSchema,
        amountMinor: safeIntegerSchema.positive(),
        periodYear: safeIntegerSchema,
        periodMonth: safeIntegerSchema.min(1).max(12),
        deductionMinor: safeIntegerSchema.optional(),
        cashAccountId: safeIntegerSchema.optional(),
        paidAt: z.string().optional(),
        notes: z.string().optional(),
        requestKey: z.string().trim().min(8).max(100)
      }),
      permission: P.employees.finance
    },
    (req, ctx) => employees.paySalary(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.employees.transaction,
    {
      schema: z.object({
        employeeId: safeIntegerSchema,
        kind: z.enum(['advance', 'repayment', 'deduction']),
        amountMinor: safeIntegerSchema.positive(),
        cashAccountId: safeIntegerSchema.optional(),
        notes: z.string().optional(),
        occurredAt: z.string().optional(),
        periodYear: safeIntegerSchema.optional(),
        periodMonth: safeIntegerSchema.min(1).max(12).optional(),
        requestKey: z.string().trim().min(8).max(100)
      }),
      permission: P.employees.finance
    },
    (req, ctx) => ({ id: employees.recordEmployeeTransaction(req, ctx) })
  )
  on(
    bus,
    IPC_CHANNELS.employees.updateTransaction,
    {
      schema: z.object({
        id: safeIntegerSchema,
        amountMinor: safeIntegerSchema.positive().optional(),
        notes: z.string().optional(),
        occurredAt: z.string().optional(),
        cashAccountId: safeIntegerSchema.optional(),
        periodYear: safeIntegerSchema.optional(),
        periodMonth: safeIntegerSchema.min(1).max(12).optional()
      }),
      permission: P.employees.finance
    },
    ({ id, ...rest }, ctx) => {
      employees.updateEmployeeTransaction(id, rest, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.employees.deleteTransaction,
    { schema: idSchema, permission: P.employees.finance },
    ({ id }, ctx) => {
      employees.deleteEmployeeTransaction(id, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.employees.listDeductions,
    {
      schema: z.object({
        employeeId: safeIntegerSchema.optional(),
        year: safeIntegerSchema.optional(),
        month: safeIntegerSchema.optional(),
        ...pageRequestShape
      }),
      permission: P.employees.finance
    },
    ({ limit, cursor, ...filter }) => employees.listDeductions(filter, { limit, cursor })
  )
  on(
    bus,
    IPC_CHANNELS.employees.listAdvances,
    { schema: z.object({ employeeId: safeIntegerSchema.optional(), ...pageRequestShape }), permission: P.employees.finance },
    ({ limit, cursor, ...filter }) => employees.listAdvances(filter, { limit, cursor })
  )
  on(
    bus,
    IPC_CHANNELS.employees.listSalaryPayments,
    {
      schema: z.object({
        employeeId: safeIntegerSchema.optional(),
        year: safeIntegerSchema.optional(),
        month: safeIntegerSchema.min(1).max(12).optional(),
        ...pageRequestShape
      }),
      permission: P.employees.finance
    },
    ({ limit, cursor, ...filter }) => employees.listSalaryPayments(filter, { limit, cursor })
  )
  on(
    bus,
    IPC_CHANNELS.employees.reverseSalaryPayment,
    { schema: idSchema, permission: P.employees.finance },
    ({ id }, ctx) => employees.reverseSalaryPayment(id, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.employees.deleteSalaryPaymentHistory,
    { schema: idSchema, permission: P.employees.finance },
    ({ id }, ctx) => employees.deleteSalaryPaymentFromHistory(id, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.employees.payroll,
    { schema: z.object({ year: safeIntegerSchema, month: safeIntegerSchema }), permission: P.employees.finance },
    (req) => employees.currentMonthlyPayroll(req.year, req.month)
  )

  // ---- Expenses ----
  on(
    bus,
    IPC_CHANNELS.expenses.list,
    {
      schema: pagedFilters.extend({ kind: z.enum(['fixed', 'variable']).optional() }),
      permission: P.expenses.view
    },
    ({ limit, cursor, ...filter }) => expenses.listExpenses(filter, { limit, cursor })
  )
  on(
    bus,
    IPC_CHANNELS.expenses.summary,
    {
      schema: pagedFilters.omit({ limit: true, cursor: true }).extend({ kind: z.enum(['fixed', 'variable']).optional() }),
      permission: P.expenses.view
    },
    (filter) => expenses.expenseSummary(filter)
  )
  // Item 10/11 (final spec): "مصروف جديد" never accepts a type — the
  // schema has no `kind` field at all, so a client sending kind:'fixed'
  // has it silently stripped before createExpense ever sees the
  // request; the row is always created VARIABLE.
  on(
    bus,
    IPC_CHANNELS.expenses.create,
    {
      schema: z.object({
        categoryId: safeIntegerSchema.optional(),
        amountMinor: safeIntegerSchema.positive(),
        orderId: safeIntegerSchema.optional(),
        uncollectedProductId: safeIntegerSchema.int().positive().optional(),
        cashAccountId: safeIntegerSchema.optional(),
        description: z.string().min(1),
        spentAt: z.string().optional(),
        requestKey: z.string().trim().min(8).max(100)
      }),
      permission: P.expenses.manage
    },
    (req, ctx) => ({ id: expenses.createExpense(req, ctx) })
  )
  on(
    bus,
    IPC_CHANNELS.expenses.update,
    {
      schema: z.object({
        id: safeIntegerSchema,
        categoryId: safeIntegerSchema.nullable().optional(),
        kind: z.enum(['fixed', 'variable']).optional(),
        amountMinor: safeIntegerSchema.positive().optional(),
        cashAccountId: safeIntegerSchema.nullable().optional(),
        description: z.string().optional(),
        spentAt: z.string().optional(),
        orderId: safeIntegerSchema.nullable().optional()
      }),
      permission: P.expenses.manage
    },
    ({ id, ...rest }, ctx) => {
      expenses.updateExpense(id, rest, ctx)
      return { ok: true }
    }
  )
  // Deleting a salary-generated expense reverses the payroll payment
  // behind it, so this also re-checks employees.finance in the service.
  on(
    bus,
    IPC_CHANNELS.expenses.remove,
    { schema: idSchema, permission: P.expenses.manage },
    ({ id }, ctx) => expenses.deleteExpense(id, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.expenses.categories,
    { schema: optionalFilters, permission: P.expenses.view },
    (req) => expenses.listCategories(req.activeOnly ?? false)
  )
  on(
    bus,
    IPC_CHANNELS.expenses.createCategory,
    {
      schema: z.object({ name: z.string().min(1), kind: z.enum(['fixed', 'variable']) }),
      permission: P.expenses.manage
    },
    (req, ctx) => ({ id: expenses.createCategory(req, ctx) })
  )
  on(
    bus,
    IPC_CHANNELS.expenses.updateCategory,
    {
      schema: z.object({
        id: safeIntegerSchema,
        name: z.string().optional(),
        kind: z.enum(['fixed', 'variable']).optional(),
        active: z.boolean().optional()
      }),
      permission: P.expenses.manage
    },
    ({ id, ...rest }, ctx) => {
      expenses.updateCategory(id, rest, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.expenses.removeCategory,
    { schema: idSchema, permission: P.expenses.manage },
    ({ id }, ctx) => {
      expenses.deleteCategory(id, ctx)
      return { ok: true }
    }
  )

  // ---- Fixed / recurring expenses (definition + amount history) ----
  on(
    bus,
    IPC_CHANNELS.expenses.listRecurring,
    { schema: optionalFilters, permission: P.expenses.view },
    (req) => expenses.listRecurringExpenses(req.activeOnly ?? false)
  )
  on(
    bus,
    IPC_CHANNELS.expenses.getRecurring,
    { schema: idSchema, permission: P.expenses.view },
    ({ id }) => expenses.getRecurringExpense(id)
  )
  on(
    bus,
    IPC_CHANNELS.expenses.createRecurring,
    {
      schema: z.object({
        categoryId: safeIntegerSchema.optional(),
        description: z.string().min(1),
        amountMinor: safeIntegerSchema.positive(),
        cashAccountId: safeIntegerSchema.optional(),
        startDate: z.string().min(1),
        notes: z.string().optional(),
        requestKey: z.string().trim().min(8).max(100)
      }),
      permission: P.expenses.manage
    },
    (req, ctx) => ({ id: expenses.createRecurringExpense(req, ctx) })
  )
  on(
    bus,
    IPC_CHANNELS.expenses.updateRecurring,
    {
      schema: z.object({
        id: safeIntegerSchema,
        categoryId: safeIntegerSchema.nullable().optional(),
        description: z.string().optional(),
        cashAccountId: safeIntegerSchema.nullable().optional(),
        endDate: z.string().nullable().optional(),
        active: z.boolean().optional()
      }),
      permission: P.expenses.manage
    },
    ({ id, ...rest }, ctx) => {
      expenses.updateRecurringExpense(id, rest, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.expenses.changeRecurringAmount,
    {
      schema: z.object({
        id: safeIntegerSchema,
        amountMinor: safeIntegerSchema.positive(),
        effectiveFrom: z.string().min(1),
        notes: z.string().optional()
      }),
      permission: P.expenses.manage
    },
    ({ id, ...rest }, ctx) => {
      expenses.changeRecurringExpenseAmount(id, rest, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.expenses.removeRecurring,
    { schema: idSchema, permission: P.expenses.manage },
    ({ id }, ctx) => expenses.deleteRecurringExpense(id, ctx)
  )

  // ---- Cash ----
  // `asOf` gives the balance at the end of the selected operational day
  // (opening + every movement up to it), never that day's activity alone.
  on(
    bus,
    IPC_CHANNELS.cash.accounts,
    { schema: z.object({ asOf: z.string().optional() }).optional(), permission: P.cash.view },
    (req) => cash.listAccounts(req ?? {})
  )
  on(
    bus,
    IPC_CHANNELS.cash.createAccount,
    {
      schema: z.object({
        name: z.string().min(1),
        kind: z.enum(['cash', 'bank']),
        openingBalanceMinor: safeIntegerSchema.optional(),
        notes: z.string().optional(),
        requestKey: z.string().trim().min(8).max(100)
      }),
      permission: P.cash.manage
    },
    (req, ctx) => ({ id: cash.createAccount(req, ctx) })
  )
  on(
    bus,
    IPC_CHANNELS.cash.updateAccount,
    {
      schema: z.object({
        id: safeIntegerSchema,
        name: z.string().optional(),
        kind: z.string().optional(),
        notes: z.string().optional(),
        active: z.boolean().optional(),
        openingBalanceMinor: safeIntegerSchema.optional()
      }),
      permission: P.cash.manage
    },
    ({ id, ...rest }, ctx) => {
      cash.updateAccount(id, rest, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.cash.removeAccount,
    { schema: idSchema, permission: P.cash.manage },
    ({ id }, ctx) => {
      cash.deleteAccount(id, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.cash.fullDeleteAccountPreview,
    { schema: idSchema, permission: P.cash.fullDelete },
    ({ id }) => cash.cashAccountFullDeletePreview(id)
  )
  on(
    bus,
    IPC_CHANNELS.cash.fullDeleteAccount,
    {
      schema: z.object({ id: safeIntegerSchema, confirmation: z.string().min(1) }),
      permission: P.cash.fullDelete
    },
    (req, ctx) => cash.fullDeleteCashAccount(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.cash.adjustBalance,
    {
      schema: z.object({
        accountId: safeIntegerSchema,
        desiredBalanceMinor: safeIntegerSchema,
        reason: z.string().min(1),
        occurredAt: z.string().optional(),
        requestKey: z.string().trim().min(8).max(100)
      }),
      permission: P.cash.manage
    },
    (req, ctx) => cash.adjustAccountBalance(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.cash.transactions,
    {
      schema: pagedFilters.extend({ accountId: safeIntegerSchema.optional() }),
      permission: P.cash.view
    },
    ({ limit, cursor, ...filter }) => cash.listTransactions(filter, { limit, cursor })
  )
  // Standalone movements only; the service refuses anything generated
  // by another transaction and names the screen that owns it.
  on(
    bus,
    IPC_CHANNELS.cash.updateTransaction,
    {
      schema: z.object({
        id: safeIntegerSchema,
        accountId: safeIntegerSchema.optional(),
        direction: z.enum(['in', 'out']).optional(),
        amountMinor: safeIntegerSchema.positive().optional(),
        notes: z.string().optional(),
        occurredAt: z.string().optional()
      }),
      permission: P.cash.manage
    },
    (req, ctx) => {
      cash.updateCashMovement(req, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.cash.removeTransaction,
    { schema: idSchema, permission: P.cash.manage },
    ({ id }, ctx) => {
      cash.deleteCashMovement(id, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.cash.transfer,
    {
      schema: z.object({
        fromAccountId: safeIntegerSchema,
        toAccountId: safeIntegerSchema,
        amountMinor: safeIntegerSchema.positive(),
        notes: z.string().optional(),
        occurredAt: z.string().optional(),
        requestKey: z.string().trim().min(8).max(100)
      }),
      permission: P.cash.transfer
    },
    (req, ctx) => {
      cash.transfer(req, ctx)
      return { ok: true }
    }
  )
  // A transfer is fully owned by the Cash module, so — unlike a linked
  // module's movement — it gets its own group-level edit/delete path
  // instead of being permanently locked; both legs always move together.
  on(
    bus,
    IPC_CHANNELS.cash.getTransfer,
    { schema: z.object({ transferGroup: z.string().min(1) }), permission: P.cash.transfer },
    ({ transferGroup }) => cash.getTransfer(transferGroup)
  )
  on(
    bus,
    IPC_CHANNELS.cash.updateTransfer,
    {
      schema: z.object({
        transferGroup: z.string().min(1),
        fromAccountId: safeIntegerSchema,
        toAccountId: safeIntegerSchema,
        amountMinor: safeIntegerSchema.positive(),
        notes: z.string().optional(),
        occurredAt: z.string().optional()
      }),
      permission: P.cash.transfer
    },
    (req, ctx) => {
      cash.updateTransfer(req, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.cash.removeTransfer,
    { schema: z.object({ transferGroup: z.string().min(1) }), permission: P.cash.transfer },
    ({ transferGroup }, ctx) => {
      cash.deleteTransfer(transferGroup, ctx)
      return { ok: true }
    }
  )

  // ---- Profit, savings, withdrawals ----
  on(
    bus,
    IPC_CHANNELS.profit.monthly,
    {
      schema: z.object({ year: safeIntegerSchema, month: safeIntegerSchema.min(1).max(12) }),
      permission: P.profit.view
    },
    (req) => profit.monthlyProfitSummary(req.year, req.month)
  )
  on(bus, IPC_CHANNELS.profit.savingsHistory, { schema: pageSchema.optional(), permission: P.savings.view }, (req) =>
    profit.savingsHistory(req ?? {})
  )
  // الادخار: net profit × rate for the selected period, read from the
  // same monthlyProfitSummary the Profit screen uses.
  on(
    bus,
    IPC_CHANNELS.profit.savingsOverview,
    {
      schema: z.object({ year: safeIntegerSchema, month: safeIntegerSchema.min(1).max(12) }),
      permission: P.savings.view
    },
    (req) => profit.savingsOverview(req.year, req.month)
  )
  on(
    bus,
    IPC_CHANNELS.profit.setSavingsRate,
    {
      schema: z.object({ rateBp: safeIntegerSchema.int().min(0).max(10000) }),
      permission: P.savings.manage
    },
    (req, ctx) => profit.setSavingsRateBp(req.rateBp, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.profit.confirmAllocation,
    {
      schema: z.object({
        year: safeIntegerSchema,
        month: safeIntegerSchema.min(1).max(12),
        requestKey: z.string().trim().min(8).max(100)
      }),
      permission: P.savings.manage
    },
    (req, ctx) => profit.confirmSavingsAllocation(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.profit.updateAllocation,
    {
      schema: z.object({ id: safeIntegerSchema, rateBp: safeIntegerSchema.int().min(0).max(10000) }),
      permission: P.savings.manage
    },
    ({ id, rateBp }, ctx) => profit.updateSavingsAllocation(id, { rateBp }, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.profit.removeAllocation,
    { schema: idSchema, permission: P.savings.manage },
    ({ id }, ctx) => {
      profit.deleteSavingsAllocation(id, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.profit.recordSavingsUsage,
    {
      schema: z.object({
        amountMinor: safeIntegerSchema.positive(),
        cashAccountId: safeIntegerSchema.optional(),
        notes: z.string().optional(),
        occurredAt: z.string().optional(),
        requestKey: z.string().trim().min(8).max(100)
      }),
      permission: P.savings.manage
    },
    (req, ctx) => ({ id: profit.recordSavingsUsage(req, ctx) })
  )
  on(
    bus,
    IPC_CHANNELS.profit.withdrawals,
    { schema: z.object({ from: z.string().max(32).optional(), to: z.string().max(32).optional(), ...pageRequestShape }), permission: P.withdrawals.view },
    ({ limit, cursor, ...filter }) => profit.listWithdrawals(filter, { limit, cursor })
  )
  on(
    bus,
    IPC_CHANNELS.profit.recordWithdrawal,
    {
      schema: z.object({
        amountMinor: safeIntegerSchema.positive(),
        person: z.string().optional(),
        notes: z.string().optional(),
        cashAccountId: safeIntegerSchema.optional(),
        withdrawnAt: z.string().optional(),
        requestKey: z.string().trim().min(8).max(100)
      }),
      permission: P.withdrawals.manage
    },
    (req, ctx) => profit.recordProfitWithdrawal(req, ctx)
  )

  on(
    bus,
    IPC_CHANNELS.profit.updateWithdrawal,
    { schema: profit.withdrawalEditSchema, permission: P.withdrawals.manage },
    (req, ctx) => profit.updateProfitWithdrawal(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.profit.removeWithdrawal,
    { schema: profit.withdrawalDeleteSchema, permission: P.withdrawals.manage },
    (req, ctx) => profit.deleteProfitWithdrawal(req, ctx)
  )

  // ---- Reports & documents ----
  on(bus, IPC_CHANNELS.reports.available, { permission: P.reports.view }, (_req, ctx) =>
    reports.availableReportsForSession(ctx.session)
  )
  on(
    bus,
    IPC_CHANNELS.reports.build,
    {
      schema: z.object({
        key: z.string(),
        from: z.string().optional(),
        to: z.string().optional(),
        year: safeIntegerSchema.optional(),
        month: safeIntegerSchema.optional()
      }),
      permission: P.reports.view
    },
    (req, ctx) => reports.buildAuthorizedReport(req as reports.ReportRequest, ctx.session)
  )

  const documentSchema = z.object({
    kind: z.enum([
      'preliminary_invoice',
      'final_invoice',
      'work_sheet',
      'installation_release',
      'delivery_release'
    ]),
    id: safeIntegerSchema
  })
  on(
    bus,
    IPC_CHANNELS.documents.preview,
    { schema: documentSchema, requireAuth: true },
    (req, ctx) => printing.renderDocumentHtml(req.kind, req.id, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.documents.print,
    { schema: documentSchema, requireAuth: true },
    async (req, ctx) => {
      const { html, documentNumber } = printing.renderDocumentHtml(req.kind, req.id, ctx)
      try {
        if (req.kind === 'final_invoice') {
          return await printing.printFinalInvoice(html, documentNumber)
        }
        await printing.printHtml(html)
        return { method: 'printer' as const }
      } catch (error) {
        logger.error(`Document print output failed [kind=${req.kind}, id=${req.id}]`, error)
        throw error
      }
    }
  )
  on(
    bus,
    IPC_CHANNELS.documents.exportPdf,
    { schema: documentSchema, requireAuth: true },
    async (req, ctx) => {
      const { html, documentNumber } = printing.renderDocumentHtml(req.kind, req.id, ctx)
      return printing.exportPdf(html, req.kind, documentNumber)
    }
  )
  on(
    bus,
    IPC_CHANNELS.documents.printReport,
    {
      schema: z.object({
        key: z.string(),
        from: z.string().optional(),
        to: z.string().optional(),
        year: safeIntegerSchema.optional(),
        month: safeIntegerSchema.optional()
      }),
      permission: P.reports.export
    },
    async (req, ctx) => {
      await printing.printHtml(
        printing.renderReportHtml(
          reports.buildAuthorizedReport(req as reports.ReportRequest, ctx.session)
        )
      )
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.documents.exportReportPdf,
    {
      schema: z.object({
        key: z.string(),
        from: z.string().optional(),
        to: z.string().optional(),
        year: safeIntegerSchema.optional(),
        month: safeIntegerSchema.optional()
      }),
      permission: P.reports.export
    },
    async (req, ctx) => {
      const report = reports.buildAuthorizedReport(req as reports.ReportRequest, ctx.session)
      return printing.exportPdf(
        printing.renderReportHtml(report),
        'reports',
        `${req.key}-${Date.now()}`
      )
    }
  )

  // ---- Administration ----
  on(bus, IPC_CHANNELS.admin.users, { permission: P.users.view }, () => usersAdmin.listUsers())
  on(
    bus,
    IPC_CHANNELS.admin.createUser,
    {
      schema: z.object({
        username: z.string().min(3),
        password: z.string().min(6),
        fullName: z.string().min(1),
        roleId: safeIntegerSchema
      }),
      permission: P.users.manage
    },
    (req, ctx) => ({ id: usersAdmin.createUser(req, ctx) })
  )
  on(
    bus,
    IPC_CHANNELS.admin.updateUser,
    {
      schema: z.object({
        id: safeIntegerSchema,
        fullName: z.string().optional(),
        roleId: safeIntegerSchema.optional(),
        active: z.boolean().optional(),
        password: z.string().optional()
      }),
      permission: P.users.manage
    },
    ({ id, ...rest }, ctx) => {
      usersAdmin.updateUser(id, rest, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.admin.deleteUser,
    { schema: idSchema, permission: P.users.manage },
    ({ id }, ctx) => usersAdmin.deleteUser(id, ctx)
  )
  on(bus, IPC_CHANNELS.admin.roles, { permission: P.roles.view }, () => usersAdmin.listRoles())
  on(
    bus,
    IPC_CHANNELS.admin.createRole,
    {
      schema: z.object({ name: z.string().min(1), permissions: z.array(z.string()) }),
      permission: P.roles.manage
    },
    (req, ctx) => ({ id: usersAdmin.createRole(req, ctx) })
  )
  on(
    bus,
    IPC_CHANNELS.admin.updateRole,
    {
      schema: z.object({
        id: safeIntegerSchema,
        name: z.string().optional(),
        permissions: z.array(z.string()).optional()
      }),
      permission: P.roles.manage
    },
    ({ id, ...rest }, ctx) => {
      usersAdmin.updateRole(id, rest, ctx)
      return { ok: true }
    }
  )
  on(
    bus,
    IPC_CHANNELS.admin.deleteRole,
    {
      schema: z.object({ id: safeIntegerSchema, confirmation: z.string().min(1) }),
      permission: P.roles.manage
    },
    (req, ctx) => {
      usersAdmin.deleteRole(req, ctx)
      return { ok: true }
    }
  )
  on(bus, IPC_CHANNELS.admin.permissions, { permission: P.roles.view }, () =>
    usersAdmin.availablePermissions()
  )
  on(
    bus,
    IPC_CHANNELS.admin.audit,
    {
      schema: z.object({
        action: boundedSearchSchema,
        from: z.string().max(32).optional(),
        to: z.string().max(32).optional(),
        ...pageRequestShape
      }),
      permission: P.audit.view
    },
    ({ limit, cursor, ...filter }) => usersAdmin.listAuditLog(filter, { limit, cursor })
  )

  // ---- Settings ----
  on(bus, IPC_CHANNELS.settings.getAll, { permission: P.settings.view }, () =>
    settings.getAllSettings()
  )
  on(
    bus,
    IPC_CHANNELS.settings.set,
    { schema: z.object({ key: z.string(), value: z.unknown() }), permission: P.settings.manage },
    (req, ctx) => {
      settings.setSetting(req.key, req.value, ctx)
      return { ok: true }
    }
  )

  // ---- Backup & restore ----
  on(bus, IPC_CHANNELS.backup.pickSavePath, { permission: P.backup.create }, async (_req, ctx) => {
    const win = BrowserWindow.fromId(ctx.webContentsId) ?? BrowserWindow.getAllWindows()[0]
    return { path: win ? await pickBackupDestinationFile(win) : undefined }
  })
  on(bus, IPC_CHANNELS.backup.pickFile, { permission: P.backup.restore }, async (_req, ctx) => {
    const win = BrowserWindow.fromId(ctx.webContentsId) ?? BrowserWindow.getAllWindows()[0]
    return { path: win ? await pickBackupFileToRestore(win) : undefined }
  })
  on(
    bus,
    IPC_CHANNELS.backup.create,
    { schema: z.object({ destinationFilePath: z.string().min(1) }), permission: P.backup.create },
    (req, ctx) => backup.createBackup(req, ctx)
  )
  on(
    bus,
    IPC_CHANNELS.backup.validate,
    { schema: z.object({ path: z.string().min(1) }), permission: P.backup.restore },
    (req) => backup.inspectBackup(req.path)
  )
  on(
    bus,
    IPC_CHANNELS.backup.restore,
    { schema: z.object({ backupFilePath: z.string().min(1) }), permission: P.backup.restore, restoreExclusive: true },
    (req, ctx) => restoreFromBackup(req, ctx)
  )
}
