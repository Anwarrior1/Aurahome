import type { ReactElement, ReactNode } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthLayout } from '@renderer/layouts/AuthLayout'
import { AppLayout } from '@renderer/layouts/AppLayout'
import { useSession } from '@renderer/state/session.store'

import { LoginPage } from '@renderer/pages/login/LoginPage'
import { DashboardPage } from '@renderer/pages/dashboard/DashboardPage'
import { CustomersPage } from '@renderer/pages/customers/CustomersPage'
import { SuppliersPage } from '@renderer/pages/suppliers/SuppliersPage'
import { CategoriesPage } from '@renderer/pages/categories/CategoriesPage'
import { ColorsPage } from '@renderer/pages/colors/ColorsPage'
import { MaterialsPage } from '@renderer/pages/materials/MaterialsPage'
import { InventoryPage } from '@renderer/pages/inventory/InventoryPage'
import { ValuationPage } from '@renderer/pages/valuation/ValuationPage'
import { PurchasesPage } from '@renderer/pages/purchases/PurchasesPage'
import { ProductsPage } from '@renderer/pages/products/ProductsPage'
import { QuotationsPage } from '@renderer/pages/quotations/QuotationsPage'
import { OrdersPage } from '@renderer/pages/orders/OrdersPage'
import { OrderDetailPage } from '@renderer/pages/orders/OrderDetailPage'
import { WorkSheetsPage } from '@renderer/pages/worksheets/WorkSheetsPage'
import { ProductionOrderPage } from '@renderer/pages/worksheets/ProductionOrderPage'
import { FinalInvoicesPage } from '@renderer/pages/invoices/FinalInvoicesPage'
import { UncollectedProductsPage } from '@renderer/pages/uncollected/UncollectedProductsPage'
import { ReleasesPage } from '@renderer/pages/releases/ReleasesPage'
import { DeliveriesPage } from '@renderer/pages/deliveries/DeliveriesPage'
import { MachinesPage } from '@renderer/pages/machines/MachinesPage'
import { WorkersPage } from '@renderer/pages/workers/WorkersPage'
import { EmployeesPage } from '@renderer/pages/employees/EmployeesPage'
import { ExpensesPage } from '@renderer/pages/expenses/ExpensesPage'
import { CashPage } from '@renderer/pages/cash/CashPage'
import { ProfitPage } from '@renderer/pages/profit/ProfitPage'
import { SavingsPage } from '@renderer/pages/savings/SavingsPage'
import { WithdrawalsPage } from '@renderer/pages/withdrawals/WithdrawalsPage'
import { ReportsPage } from '@renderer/pages/reports/ReportsPage'
import { UsersPage } from '@renderer/pages/users/UsersPage'
import { AuditPage } from '@renderer/pages/audit/AuditPage'
import { BackupPage } from '@renderer/pages/backup/BackupPage'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { NAV, canAccessNavItem } from './nav'

function firstAuthorizedPath(can: (permission: string) => boolean): string | undefined {
  const visible = NAV.flatMap((group) => group.items)
    .find((item) => canAccessNavItem(item, can))?.path
  if (visible) return visible
  if (can(P.inventory.view)) return '/inventory'
  if (can(P.roles.view)) return '/users'
  return undefined
}

function ProtectedPage({ permission, children }: { permission: string | string[]; children: ReactNode }): ReactElement {
  const { can } = useSession()
  const allowed = Array.isArray(permission) ? permission.some(can) : can(permission)
  if (allowed) return <>{children}</>
  const destination = firstAuthorizedPath(can)
  return destination
    ? <Navigate to={destination} replace />
    : <div className="state">لا توجد أقسام متاحة لهذا الدور. راجع مدير النظام.</div>
}

const protect = (permission: string | string[], page: ReactNode): ReactElement => (
  <ProtectedPage permission={permission}>{page}</ProtectedPage>
)

/** HashRouter — this is a file:// packaged app, not a served site. */
export function AppRouter(): ReactElement {
  const { session, ready } = useSession()

  if (!ready) return <div className="state">جارٍ تشغيل النظام…</div>

  if (!session) {
    return (
      <HashRouter>
        <Routes>
          <Route element={<AuthLayout />}>
            <Route path="*" element={<LoginPage />} />
          </Route>
        </Routes>
      </HashRouter>
    )
  }

  return (
    <HashRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={protect(P.dashboard.view, <DashboardPage />)} />
          <Route path="/customers" element={protect(P.customers.view, <CustomersPage />)} />
          <Route path="/suppliers" element={protect(P.suppliers.view, <SuppliersPage />)} />
          <Route path="/categories" element={protect(P.materials.view, <CategoriesPage />)} />
          <Route path="/colors" element={protect(P.colors.view, <ColorsPage />)} />
          <Route path="/materials" element={protect(P.materials.view, <MaterialsPage />)} />
          <Route path="/inventory" element={protect(P.inventory.view, <InventoryPage />)} />
          <Route path="/valuation" element={protect(P.inventory.valuation, <ValuationPage />)} />
          <Route path="/purchases" element={protect(P.purchases.view, <PurchasesPage />)} />
          <Route path="/products" element={protect(P.products.view, <ProductsPage />)} />
          <Route path="/quotations" element={protect(P.quotations.view, <QuotationsPage />)} />
          <Route path="/orders" element={protect(P.orders.view, <OrdersPage />)} />
          <Route path="/orders/:id" element={protect(P.orders.view, <OrderDetailPage />)} />
          <Route path="/worksheets" element={protect(P.worksheets.view, <WorkSheetsPage />)} />
          <Route path="/worksheets/:id" element={protect(P.worksheets.view, <ProductionOrderPage />)} />
          <Route path="/final-invoices" element={protect(P.finalInvoices.view, <FinalInvoicesPage />)} />
          <Route path="/uncollected-products" element={protect(P.uncollectedProducts.view, <UncollectedProductsPage />)} />
          <Route path="/releases" element={protect(P.releases.view, <ReleasesPage />)} />
          <Route path="/deliveries" element={protect(P.deliveries.view, <DeliveriesPage />)} />
          <Route path="/machines" element={protect(P.machines.view, <MachinesPage />)} />
          <Route path="/workers" element={protect(P.workers.view, <WorkersPage />)} />
          <Route path="/employees" element={protect(P.employees.view, <EmployeesPage />)} />
          <Route path="/expenses" element={protect(P.expenses.view, <ExpensesPage />)} />
          <Route path="/cash" element={protect(P.cash.view, <CashPage />)} />
          <Route path="/profit" element={protect(P.profit.view, <ProfitPage />)} />
          <Route path="/savings" element={protect(P.savings.view, <SavingsPage />)} />
          <Route path="/withdrawals" element={protect(P.withdrawals.view, <WithdrawalsPage />)} />
          <Route path="/reports" element={protect(P.reports.view, <ReportsPage />)} />
          <Route path="/users" element={protect([P.users.view, P.roles.view], <UsersPage />)} />
          <Route path="/audit" element={protect(P.audit.view, <AuditPage />)} />
          <Route path="/backup" element={protect([P.backup.create, P.backup.restore], <BackupPage />)} />
          <Route path="/settings" element={protect(P.settings.view, <SettingsPage />)} />
          <Route path="*" element={<AuthorizedStart />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}

function AuthorizedStart(): ReactElement {
  const { can } = useSession()
  const destination = firstAuthorizedPath(can)
  return destination
    ? <Navigate to={destination} replace />
    : <div className="state">لا توجد أقسام متاحة لهذا الدور. راجع مدير النظام.</div>
}
