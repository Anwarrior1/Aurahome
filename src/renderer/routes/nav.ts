import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'

export interface NavItem {
  path: string
  label: string
  icon: string
  permission?: string | string[]
}
/** Page reachability is a union; each operation keeps its own permission. */
export function canAccessNavItem(item: NavItem, can: (permission: string) => boolean): boolean {
  if (!item.permission) return true
  return Array.isArray(item.permission) ? item.permission.some(can) : can(item.permission)
}

export interface NavGroup {
  label: string
  /** Icon for the group's OWN header row — only meaningful for a
   *  group with more than one item, which the sidebar renders as a
   *  collapsible section (see AppLayout.tsx). A single-item group
   *  (e.g. "الرئيسية") renders as a flat link using that one item's
   *  own icon instead, so it never needs one. */
  icon?: string
  items: NavItem[]
}

/** Sidebar structure. Items whose permission the role lacks are hidden
 *  for convenience; the real block is enforced in main (BR-104). */
export const NAV: NavGroup[] = [
  {
    label: 'الرئيسية',
    items: [{ path: '/', label: 'لوحة المعلومات', icon: 'home', permission: P.dashboard.view }]
  },
  {
    label: 'المبيعات',
    icon: 'groupSales',
    items: [
      { path: '/customers', label: 'العملاء', icon: 'customers', permission: P.customers.view },
      { path: '/quotations', label: 'الفواتير المبدئية', icon: 'quotations', permission: P.quotations.view },
      // Workflow order: the approved invoice creates the customer order.
      // Its own view permission — NOT the Customer Order's — is what
      // gates this entry: a Sales role can see/open Approved Invoices
      // without ever reaching طلبات العملاء.
      { path: '/final-invoices', label: 'الفواتير المعتمدة', icon: 'finalInvoices', permission: P.finalInvoices.view },
      { path: '/orders', label: 'طلبات العملاء', icon: 'orders', permission: P.orders.view },
      // Physical products left behind by cancelled orders — a stock of
      // finished goods that is sold through the same Approved Invoice.
      { path: '/uncollected-products', label: 'المنتجات غير المستلمة', icon: 'uncollectedProducts', permission: P.uncollectedProducts.view }
    ]
  },
  {
    label: 'المخزون والمشتريات',
    icon: 'groupInventory',
    items: [
      { path: '/materials', label: 'المواد الخام', icon: 'materials', permission: P.materials.view },
      { path: '/categories', label: 'التصنيفات', icon: 'categories', permission: P.materials.view },
      { path: '/colors', label: 'كتالوج الألوان', icon: 'colors', permission: P.colors.view },
      { path: '/valuation', label: 'تقييم المخزون', icon: 'valuation', permission: P.inventory.valuation },
      { path: '/suppliers', label: 'الموردون', icon: 'suppliers', permission: P.suppliers.view },
      { path: '/purchases', label: 'المشتريات', icon: 'purchases', permission: P.purchases.view }
    ]
  },
  {
    label: 'الإنتاج',
    icon: 'groupProduction',
    items: [
      { path: '/products', label: 'المنتجات القياسية', icon: 'products', permission: P.products.view },
      { path: '/worksheets', label: 'أوامر التصنيع', icon: 'worksheets', permission: P.worksheets.view },
      { path: '/releases', label: 'أذونات الخروج', icon: 'releases', permission: P.releases.view },
      { path: '/deliveries', label: 'التسليم والتركيب', icon: 'deliveries', permission: P.deliveries.view },
      { path: '/machines', label: 'الآلات', icon: 'machines', permission: P.machines.view },
      { path: '/workers', label: 'العمال', icon: 'workers', permission: P.workers.view }
    ]
  },
  {
    label: 'المالية',
    icon: 'groupFinance',
    items: [
      { path: '/cash', label: 'الحسابات النقدية', icon: 'cash', permission: P.cash.view },
      { path: '/expenses', label: 'المصروفات', icon: 'expenses', permission: P.expenses.view },
      { path: '/employees', label: 'الموظفون والرواتب', icon: 'employees', permission: P.employees.view },
      { path: '/profit', label: 'ملخص الأرباح', icon: 'profit', permission: P.profit.view },
      { path: '/savings', label: 'الادخار', icon: 'savings', permission: P.savings.view },
      { path: '/withdrawals', label: 'مسحوبات الأرباح', icon: 'withdrawals', permission: P.withdrawals.view }
    ]
  },
  {
    label: 'التقارير والنظام',
    icon: 'groupSystem',
    items: [
      { path: '/reports', label: 'التقارير', icon: 'reports', permission: P.reports.view },
      { path: '/users', label: 'المستخدمون والأدوار', icon: 'users', permission: P.users.view },
      { path: '/audit', label: 'سجل العمليات', icon: 'audit', permission: P.audit.view },
      { path: '/backup', label: 'النسخ الاحتياطي', icon: 'backup', permission: [P.backup.create, P.backup.restore] },
      { path: '/settings', label: 'الإعدادات', icon: 'settings', permission: P.settings.view }
    ]
  }
]
