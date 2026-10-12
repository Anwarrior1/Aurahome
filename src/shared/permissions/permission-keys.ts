/**
 * Permission keys are "<module>.<action>" (BR-55/BR-104). Roles are
 * fully configurable: an administrator ticks any subset of these keys
 * for a role. The one bootstrap admin role bypasses the list entirely
 * and can never be locked out.
 *
 * The sensitive keys called out in BR-104 — costs, profit, machine
 * cost, worker cost, supplier prices, operational finance, stock
 * adjustments, restore, permissions, profit withdrawals, Savings &
 * Investment — are each separately grantable below.
 */
export const PERMISSION_KEYS = {
  dashboard: {
    view: 'dashboard.view',
    viewSales: 'dashboard.viewSales',
    viewOrders: 'dashboard.viewOrders',
    viewCosts: 'dashboard.viewCosts',
    viewProfits: 'dashboard.viewProfits',
    viewFinancialAlerts: 'dashboard.viewFinancialAlerts'
  },
  customers: {
    view: 'customers.view',
    manage: 'customers.manage',
    /** The reversible lifecycle: archive a customer out of the active
     *  lists and restore them later. Separate from `manage` because
     *  taking a customer out of circulation is a different decision
     *  from correcting their details. */
    archive: 'customers.archive'
    /**
     * There is deliberately NO `fullDelete` here. Elsewhere that key
     * means a CASCADE permanent delete of a record together with the
     * history it owns (suppliers, materials, purchases, orders each
     * implement one, with their own preview channel). Customers have
     * no such workflow: `customers:remove` refuses outright as soon as
     * a quotation, order, invoice or payment exists, so it is ordinary
     * record cleanup of a never-transacted row and belongs to `manage`
     * — which is also what parties.service enforces internally.
     */
  },
  suppliers: {
    view: 'suppliers.view',
    manage: 'suppliers.manage',
    /** Permanent cascade deletion of a supplier and its whole owned
     *  purchase/payment/inventory chain — separate from `manage`
     *  (which stays blocked once purchase history exists), same shape
     *  as `orders.fullDelete`/`employees.fullDelete`. */
    fullDelete: 'suppliers.fullDelete'
  },
  materials: {
    view: 'materials.view',
    manage: 'materials.manage',
    /** Permanent cascade deletion of a raw material together with its
     *  own unconsumed stock, purchase lines it exclusively owns, and
     *  every live configuration reference to it — separate from
     *  `manage` (which archives instead once real history exists). */
    fullDelete: 'materials.fullDelete'
  },
  colors: { view: 'colors.view', manage: 'colors.manage' },
  inventory: {
    view: 'inventory.view',
    consume: 'inventory.consume',
    adjust: 'inventory.adjust',
    waste: 'inventory.waste',
    valuation: 'inventory.valuation'
  },
  purchases: {
    view: 'purchases.view',
    manage: 'purchases.manage',
    prices: 'purchases.prices',
    paySupplier: 'purchases.paySupplier',
    editSupplierPayment: 'purchases.editSupplierPayment',
    deleteSupplierPayment: 'purchases.deleteSupplierPayment',
    /** Permanent cascade deletion of a purchase invoice together with
     *  its own payments, financial transactions and inventory receipts. */
    fullDelete: 'purchases.fullDelete'
  },
  products: {
    view: 'products.view',
    manage: 'products.manage',
    /** Permanent delete of a Standard Product master together with its
     *  own current BOM/machine/commission configuration — separate
     *  from `manage`, since every historical document line that named
     *  it survives with its own frozen content untouched. */
    fullDelete: 'products.fullDelete'
  },
  /**
   * The PRELIMINARY INVOICE ("الفاتورة المبدئية") — a standalone
   * customer-facing commercial document. It approves nothing, creates
   * no Customer Order and starts no production, so it deliberately has
   * NO approval permission: `issue` is simply "this document is now
   * final and has gone to the customer" (BR-45 then freezes it, and a
   * correction is made as a revision).
   */
  quotations: {
    view: 'quotations.view',
    manage: 'quotations.manage',
    /** Replaces the old, misnamed `quotations.approve`: the action it
     *  guarded was always `issueQuotation`, never an approval. Roles
     *  holding the retired key keep working through LEGACY_FALLBACKS. */
    issue: 'quotations.issue',
    /** Deleting a preliminary invoice — never implied by `manage`. */
    remove: 'quotations.remove'
  },
  /**
   * The APPROVED INVOICE ("الفاتورة المعتمدة") — the commercial
   * document whose APPROVAL is what creates the Customer Order.
   *
   * Previously every one of these actions rode on the Customer Order's
   * own `orders.view`/`orders.manage`, which made "prepare the
   * commercial document" and "approve it into a live order" literally
   * the same privilege. They are separated here so a sales role can own
   * the document without ever being able to commit the factory to it.
   */
  finalInvoices: {
    view: 'finalInvoices.view',
    manage: 'finalInvoices.manage',
    /** The authorisation step: freezes the commercial snapshot and
     *  creates the Customer Order. Sensitive — it is the commitment
     *  point of the whole operational workflow. */
    approve: 'finalInvoices.approve',
    cancel: 'finalInvoices.cancel',
    remove: 'finalInvoices.remove',
    /** Business-wide financial summaries shown above the list, not the
     *  individual document's own figures: the total approved across the
     *  company, and the total still outstanding from customers. */
    viewApprovedTotal: 'finalInvoices.viewApprovedTotal',
    viewOutstanding: 'finalInvoices.viewOutstanding'
  },
  /**
   * "المنتجات غير المستلمة" — physical products that were actually
   * manufactured for a Customer Order the customer then abandoned, and
   * which the business still holds and can resell.
   *
   * Viewing the shelf is separate from seeing what each item cost to
   * build: `viewCost` governs the internal cost basis, which is never
   * customer-facing and is omitted from the payload without it.
   */
  uncollectedProducts: {
    view: 'uncollectedProducts.view',
    viewCost: 'uncollectedProducts.viewCost',
    sell: 'uncollectedProducts.sell',
    resume: 'uncollectedProducts.resume'
  },
  orders: {
    view: 'orders.view',
    manage: 'orders.manage',
    archive: 'orders.archive',
    unapproveInvoice: 'orders.unapproveInvoice',
    cancel: 'orders.cancel',
    fullDelete: 'orders.fullDelete',
    overrideDeposit: 'orders.overrideDeposit',
    complete: 'orders.complete',
    viewEstimatedCost: 'orders.viewEstimatedCost',
    viewExpectedProfit: 'orders.viewExpectedProfit',
    viewActualCost: 'orders.viewActualCost',
    viewActualProfit: 'orders.viewActualProfit'
  },
  /**
   * PRODUCTION PREPARATION ("تجهيز الإنتاج") — the planning block on a
   * Customer Order: planned materials (with their material/colour
   * selections), machines, worker commissions and order expenses.
   *
   * Planning only: saving here deducts no stock, accrues no commission
   * and moves no cash — execution belongs to the Manufacturing Order,
   * whose permissions (`worksheets.*`) stay entirely separate.
   *
   * These two keys govern ACCESS to the section and the right to change
   * it. They deliberately reveal no money on their own: the estimated
   * cost and expected profit inside the section remain governed by
   * `orders.viewEstimatedCost` / `orders.viewExpectedProfit`, which the
   * planning-snapshot handler already applies.
   */
  productionPrep: {
    view: 'productionPrep.view',
    manage: 'productionPrep.manage'
  },
  production: {
    /** Sensitive exception: start customer production even though the
     *  order's authoritative required deposit has not been satisfied. */
    overrideDepositRequirement: 'production.overrideDepositRequirement',
    /** Create, edit and safely reverse customer-order raw-material returns. */
    returnMaterial: 'production.returnMaterial'
  },
  worksheets: { view: 'worksheets.view', issue: 'worksheets.issue', reverse: 'worksheets.reverse' },
  releases: {
    view: 'releases.view',
    issue: 'releases.issue',
    reverse: 'releases.reverse',
    /** Sensitive management exception: authorise an installation
     * permit while the order still has an outstanding balance. */
    overrideUnpaid: 'releases.overrideUnpaid'
  },
  deliveries: {
    view: 'deliveries.view',
    register: 'deliveries.register',
    deleteOrReverse: 'deliveries.deleteOrReverse'
  },
  machines: { view: 'machines.view', manage: 'machines.manage' },
  workers: {
    view: 'workers.view',
    manage: 'workers.manage',
    finance: 'workers.finance'
  },
  employees: {
    view: 'employees.view',
    manage: 'employees.manage',
    finance: 'employees.finance',
    /**
     * Legacy maintenance removal of an employee together with their whole
     * payroll and settlement history. Deliberately separate from `manage`,
     * which owns the production-safe current-employment lifecycle.
     */
    fullDelete: 'employees.fullDelete'
  },
  expenses: { view: 'expenses.view', manage: 'expenses.manage' },
  cash: {
    view: 'cash.view',
    manage: 'cash.manage',
    transfer: 'cash.transfer',
    /** Permanent cascade deletion of a cash/bank account together with
     *  every transaction posted through it and, where a transaction's
     *  authoritative source document cannot survive without it, that
     *  source document as well. */
    fullDelete: 'cash.fullDelete'
  },
  payments: {
    view: 'payments.view',
    manage: 'payments.manage',
    /** Returns real customer money before production is ever issued. */
    refund: 'payments.refund'
  },
  costing: { view: 'costing.view' },
  profit: { view: 'profit.view' },
  savings: { view: 'savings.view', manage: 'savings.manage' },
  withdrawals: { view: 'withdrawals.view', manage: 'withdrawals.manage' },
  reports: { view: 'reports.view', export: 'reports.export' },
  users: { view: 'users.view', manage: 'users.manage' },
  roles: { view: 'roles.view', manage: 'roles.manage' },
  settings: { view: 'settings.view', manage: 'settings.manage' },
  backup: { create: 'backup.create', restore: 'backup.restore' },
  audit: { view: 'audit.view' }
} as const

export interface PermissionDescriptor {
  key: string
  module: string
  action: string
  section: PermissionSection
  label: string
  sensitive: boolean
}

export const PERMISSION_SECTIONS = [
  { key: 'dashboard', label: 'لوحة المعلومات' },
  { key: 'customers', label: 'العملاء' },
  { key: 'suppliers', label: 'الموردون' },
  { key: 'materials', label: 'المواد الخام' },
  { key: 'inventory', label: 'المخزون' },
  { key: 'purchases', label: 'المشتريات' },
  { key: 'quotations', label: 'الفواتير المبدئية' },
  { key: 'finalInvoices', label: 'الفواتير المعتمدة' },
  { key: 'uncollectedProducts', label: 'المنتجات غير المستلمة' },
  { key: 'orders', label: 'طلبات العملاء' },
  { key: 'production', label: 'الإنتاج' },
  { key: 'deliveries', label: 'التسليم والتركيب' },
  { key: 'finance', label: 'المالية' },
  { key: 'employees', label: 'الموظفون والرواتب' },
  { key: 'reports', label: 'التقارير' },
  { key: 'administration', label: 'المستخدمون والأدوار' },
  { key: 'settings', label: 'الإعدادات' },
  { key: 'audit', label: 'سجل العمليات' },
  { key: 'backup', label: 'النسخ الاحتياطي والاستعادة' }
] as const

export type PermissionSection = (typeof PERMISSION_SECTIONS)[number]['key']

const MODULE_SECTION: Record<string, PermissionSection> = {
  dashboard: 'dashboard',
  customers: 'customers',
  suppliers: 'suppliers',
  materials: 'materials',
  colors: 'materials',
  inventory: 'inventory',
  purchases: 'purchases',
  products: 'production',
  productionPrep: 'production',
  quotations: 'quotations',
  finalInvoices: 'finalInvoices',
  uncollectedProducts: 'uncollectedProducts',
  orders: 'orders',
  payments: 'orders',
  production: 'production',
  worksheets: 'production',
  releases: 'production',
  machines: 'production',
  workers: 'production',
  deliveries: 'deliveries',
  employees: 'employees',
  expenses: 'finance',
  cash: 'finance',
  costing: 'orders',
  profit: 'finance',
  savings: 'finance',
  withdrawals: 'finance',
  reports: 'reports',
  users: 'administration',
  roles: 'administration',
  settings: 'settings',
  audit: 'audit',
  backup: 'backup'
}

const EXPLICIT_LABELS: Record<string, string> = {
  'dashboard.view': 'الدخول إلى لوحة المعلومات',
  'customers.archive': 'أرشفة واستعادة العملاء',
  // The preliminary invoice is issued to the customer; it approves
  // nothing and creates nothing downstream, so the label must not say
  // "اعتماد" — that word belongs to the Approved Invoice alone.
  'quotations.issue': 'إصدار الفاتورة المبدئية للعميل',
  'quotations.remove': 'حذف فاتورة مبدئية',
  'finalInvoices.view': 'عرض الفواتير المعتمدة',
  'finalInvoices.manage': 'إنشاء وتعديل الفواتير المعتمدة',
  'finalInvoices.approve': 'اعتماد الفاتورة وإنشاء طلب العميل',
  'finalInvoices.cancel': 'إلغاء فاتورة معتمدة',
  'finalInvoices.remove': 'حذف فاتورة معتمدة',
  'uncollectedProducts.view': 'عرض المنتجات غير المستلمة',
  'uncollectedProducts.viewCost': 'عرض التكلفة الفعلية للمنتج غير المستلم',
  'uncollectedProducts.sell': 'بيع منتج غير مستلم لعميل جديد',
  'uncollectedProducts.resume': 'استئناف الطلب من المنتجات غير المستلمة',
  'finalInvoices.viewApprovedTotal': 'عرض إجمالي المعتمد (إجمالي الشركة)',
  'finalInvoices.viewOutstanding': 'عرض المتبقي على العملاء (إجمالي الشركة)',
  'dashboard.viewSales': 'عرض مؤشرات المبيعات والتحصيل',
  'dashboard.viewOrders': 'عرض مؤشرات الطلبات',
  'dashboard.viewCosts': 'عرض مؤشرات التكاليف والمصروفات',
  'dashboard.viewProfits': 'عرض مؤشرات الأرباح',
  'dashboard.viewFinancialAlerts': 'عرض الأرصدة والتنبيهات المالية',
  'orders.viewEstimatedCost': 'عرض التكلفة التقديرية',
  'orders.viewExpectedProfit': 'عرض الربح المتوقع',
  'orders.viewActualCost': 'عرض التكلفة الفعلية',
  'orders.viewActualProfit': 'عرض الربح الفعلي',
  'purchases.paySupplier': 'تسجيل دفعة مورد',
  'purchases.editSupplierPayment': 'تعديل دفعة مورد',
  'purchases.deleteSupplierPayment': 'حذف أو عكس دفعة مورد',
  'deliveries.view': 'عرض سجلات التسليم والتركيب',
  'deliveries.register': 'تسجيل عملية تسليم أو تركيب',
  'deliveries.deleteOrReverse': 'حذف أو عكس عملية مكتملة',
  'reports.export': 'تصدير وطباعة التقارير',
  'production.overrideDepositRequirement': 'السماح بإصدار أمر تصنيع بدون استيفاء العربون',
  'production.returnMaterial': 'إرجاع مواد الطلب للمخزون',
  'releases.overrideUnpaid': 'السماح بخروج طلب غير مسدد',
  'orders.overrideDeposit': 'تعديل نسبة المقدمة',
  'orders.archive': 'أرشفة واستعادة الطلبات المكتملة',
  'orders.unapproveInvoice': 'إلغاء اعتماد الفاتورة للتصحيح',
  'worksheets.reverse': 'التراجع عن أمر التصنيع وآثاره',
  'releases.reverse': 'التراجع عن إذن الخروج',
  'inventory.valuation': 'عرض تكلفة وتقييم المخزون',
  'purchases.prices': 'عرض أسعار وتكاليف الشراء',
  'costing.view': 'صلاحية التكلفة القديمة (للتوافق)',
  'profit.view': 'عرض ملخص الأرباح',
  'backup.restore': 'استعادة نسخة احتياطية',
  'backup.create': 'إنشاء نسخة احتياطية'
}

const ACTION_LABELS: Record<string, string> = {
  view: 'عرض', manage: 'إنشاء وتعديل', approve: 'اعتماد', cancel: 'إلغاء', complete: 'إكمال',
  issue: 'إصدار', consume: 'صرف من المخزون', adjust: 'تسوية المخزون', waste: 'تسجيل هالك',
  valuation: 'عرض التقييم', finance: 'عرض البيانات المالية', prices: 'عرض الأسعار',
  transfer: 'تحويل', create: 'إضافة', restore: 'استعادة', fullDelete: 'حذف نهائي',
  returnMaterial: 'إرجاع مواد الطلب للمخزون', refund: 'استرداد دفعة', export: 'تصدير'
}

/**
 * The few keys whose owning MODULE and the section a user looks for
 * them in genuinely differ. `orders.unapproveInvoice` reverses an
 * Approved Invoice's approval, so it belongs beside the rest of that
 * document's actions even though its key (and therefore every existing
 * role assignment) stays exactly as it is.
 */
const KEY_SECTION_OVERRIDES: Record<string, PermissionSection> = {
  [PERMISSION_KEYS.orders.unapproveInvoice]: 'finalInvoices'
}

const MODULE_LABELS: Record<string, string> = {
  dashboard: 'لوحة المعلومات', customers: 'العملاء', suppliers: 'الموردون', materials: 'المواد الخام',
  colors: 'كتالوج الألوان', inventory: 'المخزون', purchases: 'المشتريات', products: 'المنتجات القياسية',
  quotations: 'الفواتير المبدئية', finalInvoices: 'الفواتير المعتمدة', orders: 'طلبات العملاء',
  productionPrep: 'تجهيز الإنتاج', payments: 'دفعات العملاء', production: 'مرتجعات المواد',
  worksheets: 'أوامر التصنيع', releases: 'أذونات الخروج', deliveries: 'التسليم والتركيب', machines: 'الآلات',
  workers: 'العمال', employees: 'الموظفون والرواتب', expenses: 'المصروفات', cash: 'الحسابات النقدية',
  costing: 'تكاليف الطلبات', profit: 'الأرباح', savings: 'الادخار', withdrawals: 'مسحوبات الأرباح',
  reports: 'التقارير', users: 'المستخدمون', roles: 'الأدوار والصلاحيات', settings: 'الإعدادات',
  audit: 'سجل العمليات', backup: 'النسخ الاحتياطي'
}

const SENSITIVE_KEYS = new Set<string>([
  // Approval is the commitment point of the whole operational
  // workflow: it freezes the commercial terms and creates the
  // Customer Order.
  PERMISSION_KEYS.finalInvoices.approve,
  PERMISSION_KEYS.finalInvoices.remove,
  // The internal build cost of a physical product — never customer-facing.
  PERMISSION_KEYS.uncollectedProducts.viewCost,
  PERMISSION_KEYS.finalInvoices.viewApprovedTotal,
  PERMISSION_KEYS.finalInvoices.viewOutstanding,
  PERMISSION_KEYS.orders.archive,
  PERMISSION_KEYS.orders.unapproveInvoice,
  PERMISSION_KEYS.payments.refund,
  PERMISSION_KEYS.worksheets.reverse,
  PERMISSION_KEYS.releases.reverse,
  PERMISSION_KEYS.dashboard.viewCosts,
  PERMISSION_KEYS.dashboard.viewProfits,
  PERMISSION_KEYS.dashboard.viewFinancialAlerts,
  PERMISSION_KEYS.orders.viewEstimatedCost,
  PERMISSION_KEYS.orders.viewExpectedProfit,
  PERMISSION_KEYS.orders.viewActualCost,
  PERMISSION_KEYS.orders.viewActualProfit,
  PERMISSION_KEYS.production.overrideDepositRequirement,
  PERMISSION_KEYS.inventory.valuation,
  PERMISSION_KEYS.purchases.prices,
  PERMISSION_KEYS.costing.view,
  PERMISSION_KEYS.profit.view,
  PERMISSION_KEYS.workers.finance,
  PERMISSION_KEYS.employees.finance
])

export function allPermissionKeys(): PermissionDescriptor[] {
  const out: PermissionDescriptor[] = []
  for (const [module, actions] of Object.entries(PERMISSION_KEYS)) {
    for (const [action, key] of Object.entries(actions as Record<string, string>)) {
      out.push({
        key,
        module,
        action,
        section: KEY_SECTION_OVERRIDES[key] ?? MODULE_SECTION[module] ?? 'settings',
        label: EXPLICIT_LABELS[key] ?? `${MODULE_LABELS[module] ?? module} — ${ACTION_LABELS[action] ?? action}`,
        sensitive: SENSITIVE_KEYS.has(key)
      })
    }
  }
  return out
}
