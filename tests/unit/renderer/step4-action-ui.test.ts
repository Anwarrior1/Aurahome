import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (path: string): string => readFileSync(path, 'utf8')

describe('Step 4 action/navigation UI contract', () => {
  it('uses accessible icon-only actions for users and expenses', () => {
    const users = read('src/renderer/pages/users/UsersPage.tsx')
    const expenses = read('src/renderer/pages/expenses/ExpensesPage.tsx')
    expect(users).toContain('title="تعديل" aria-label="تعديل"')
    expect(users).toContain('title="حذف المستخدم" aria-label="حذف المستخدم"')
    expect(expenses).toContain('title="تعديل" aria-label="تعديل"')
    expect(expenses).toContain('title="حذف" aria-label="حذف"')
  })

  it('keeps the list Trash dialog exclusively for strongly-confirmed permanent delete', () => {
    const orders = read('src/renderer/pages/orders/OrdersPage.tsx')
    const detail = read('src/renderer/pages/orders/OrderDetailPage.tsx')
    expect(orders).not.toContain('إلغاء الطلب')
    expect(orders).toContain('حذف الطلب نهائياً')
    expect(orders).toContain('confirmation: deleteDialog.confirmation')
    expect(detail).toContain('إلغاء الطلب')
    expect(detail).toContain("call('orders', 'cancel'")
  })

  it('keeps inventory route while removing only its sidebar item', () => {
    const nav = read('src/renderer/routes/nav.ts')
    const router = read('src/renderer/routes/router.tsx')
    expect(nav).not.toContain("label: 'حركة المخزون'")
    expect(router).toContain(
      '<Route path="/inventory" element={protect(P.inventory.view, <InventoryPage />)} />'
    )
  })

  it('exposes icon-only Arabic-labelled actions on touched lists', () => {
    const purchases = read('src/renderer/pages/purchases/PurchasesPage.tsx')
    const colors = read('src/renderer/pages/colors/ColorsPage.tsx')
    const production = read('src/renderer/pages/worksheets/ProductionOrderPage.tsx')
    for (const source of [purchases, colors]) {
      expect(source).toContain('title="تعديل" aria-label="تعديل"')
      expect(source).toContain('title="حذف" aria-label="حذف"')
    }
    // Actual FIFO consumption — and correcting/reversing it — is a
    // Production Order concern only, never the Customer Order screen.
    expect(production).toContain('title="تعديل" aria-label="تعديل"')
    expect(production).toContain('title="عكس الحركة" aria-label="عكس الحركة"')
  })

  it('makes the Customer Order the production-PLANNING point, never the execution point', () => {
    const order = read('src/renderer/pages/orders/OrderDetailPage.tsx')
    // Actual execution still belongs to the Production Order screen.
    expect(order).not.toContain('title="عكس الحركة" aria-label="عكس الحركة"')
    expect(order).not.toContain("'production', 'consumeMaterial'")
    expect(order).not.toContain("'machines', 'addUsage'")
    expect(order).not.toContain("'workers', 'assign'")
    expect(order).not.toContain('التكلفة الفعلية والربح')
    // Workflow pass: three separated, editable configuration sections…
    expect(order).toContain('تجهيز الإنتاج')
    expect(order).toContain("setTab('materials')")
    expect(order).toContain("setTab('machines')")
    expect(order).toContain("setTab('workers')")
    expect(order).toContain("'orders', 'savePlannedMaterials'")
    expect(order).toContain("'orders', 'savePlannedMachines'")
    expect(order).toContain("'orders', 'savePlannedWorkers'")
    expect(order).toContain("'orders', 'planningSnapshot'")
    // …and the manufacturing order stays an explicit, separate decision.
    expect(order).toContain('إصدار أمر تصنيع')
    expect(order).toContain("'production', 'issueWorkSheet'")
  })

  it('keeps the preliminary invoice independent: no costing panel, no conversion', () => {
    const quotations = read('src/renderer/pages/quotations/QuotationsPage.tsx')
    expect(quotations).not.toContain('التكلفة التقديرية الداخلية')
    expect(quotations).not.toContain("'orders', 'createFromQuotation'")
    expect(quotations).not.toContain("'quotations', 'costing'")
    expect(quotations).not.toContain('savePlannedMaterials')
    expect(quotations).not.toContain('تحويل لطلب')
  })

  it('puts the authoritative approval on the approved-invoice screen', () => {
    const invoices = read('src/renderer/pages/invoices/FinalInvoicesPage.tsx')
    expect(invoices).toContain("'finalInvoices', 'approve'")
    expect(invoices).toContain('اعتماد وإنشاء طلب')
    // The retired end-of-workflow issuance is gone from the UI too.
    expect(invoices).not.toContain("'finalInvoices', 'issue'")
    expect(invoices).not.toContain("'finalInvoices', 'eligibility'")
  })

  it('lets the user pick Terms/Conditions on a brand-new, not-yet-saved Approved Invoice', () => {
    const invoices = read('src/renderer/pages/invoices/FinalInvoicesPage.tsx')
    // The old "save first" gate and its blocking message are gone —
    // "+ بند" is never conditioned on editingId any more.
    expect(invoices).not.toContain('يمكن إضافة البنود والشروط بعد حفظ الفاتورة كمسودة أولاً')
    expect(invoices).not.toContain('{editingId && (')
    // Terms picked before the first save travel with the create call,
    // in the same transaction as the invoice and its items — never a
    // sequence of separate requests.
    expect(invoices).toContain('termIndexes: terms.map((t) => t.termIndex)')
  })

  it('renames the Products module to المنتجات القياسية and drops its preliminary-invoice shortcut', () => {
    const nav = read('src/renderer/routes/nav.ts')
    const products = read('src/renderer/pages/products/ProductsPage.tsx')
    expect(nav).toContain("label: 'المنتجات القياسية'")
    expect(products).toContain('title="المنتجات القياسية"')
    // The shortcut and everything it needed are gone — not just hidden.
    expect(products).not.toContain('إنشاء فاتورة مبدئية')
    expect(products).not.toContain('createStandardInvoice')
    expect(products).not.toContain("'quotations', 'createStandard'")
    // The two remaining row actions are untouched.
    expect(products).toContain('قائمة المكونات')
    expect(products).toContain('setEditing(row)')
    // BL-04 (owner-approved, supersedes the earlier removal): the list shows
    // the ready quantity and an availability DERIVED from it — no editable flag.
    expect(products).toContain("'production', 'finishedGoods'")
    expect(products).toContain('standardProductAvailability(readyMicro(row.id))')
    expect(products).toContain("'products', 'issueStockFromBom'")
    // The new per-line material price and its read-only cost summary.
    expect(products).toContain('السعر (د.ل)')
    expect(products).toContain('unitPriceMicro')
    expect(products).toContain("setTab('cost')")
    expect(products).toContain('التكلفة الإنتاجية')
    expect(products).toContain('إجمالي تكلفة المواد')
    expect(products).toContain('إجمالي تكلفة الآلات')
    expect(products).toContain('إجمالي عمولات العمال')
  })

  it('removes the "طريقة الاحتساب" box from Savings without losing its actions, and gives allocations icon-only actions', () => {
    const savings = read('src/renderer/pages/savings/SavingsPage.tsx')
    expect(savings).not.toContain('طريقة الاحتساب')
    expect(savings).not.toContain('صافي الربح هنا هو نفسه المعروض في')
    // The confirm-allocation action and rate-edit action both survive —
    // relocated, never removed (Test 1: UI removal only, no lost function).
    expect(savings).toContain('اعتماد مخصص هذه الفترة')
    expect(savings).toContain('تعديل نسبة الادخار')
    // Approved Allocations History gets icon-only Edit/Delete, matching
    // the ERP's existing compact action-icon convention (Test 2).
    expect(savings).toContain('title="تعديل" aria-label="تعديل"')
    expect(savings).toContain('title="حذف" aria-label="حذف"')
    expect(savings).not.toContain('>تعديل</Button>')
    expect(savings).not.toContain('>حذف</Button>')
    // The savings formula/service call is untouched (Item 4/9 — reuse,
    // never a parallel calculation).
    expect(savings).toContain("'profit', 'updateAllocation'")
    expect(savings).toContain("'profit', 'removeAllocation'")
    expect(savings).toContain("'profit', 'savingsOverview'")
  })

  it('makes user delete a real, confirmed, permanent removal — never a silent disable', () => {
    const usersPage = read('src/renderer/pages/users/UsersPage.tsx')
    // Delete confirmation text is the exact, permanent-action wording —
    // no more "will be disabled instead" caveat baked into the prompt.
    expect(usersPage).toContain(
      'هل أنت متأكد من حذف هذا المستخدم نهائيًا؟ لا يمكن التراجع عن هذا الإجراء.'
    )
    expect(usersPage).not.toContain('سيتم تعطيله بدلاً من حذفه')
    // Roles get their own delete action now, matching the existing
    // icon-button convention used for the Users table.
    expect(usersPage).toContain('title="حذف الدور" aria-label="حذف الدور"')
    expect(usersPage).toContain("call('admin', 'deleteRole'")
  })

  it('keeps User and Role deletion fully independent — Role delete never touches Users, User delete never touches the Role', () => {
    const usersPage = read('src/renderer/pages/users/UsersPage.tsx')
    // Deleting a user never reaches deleteRole, and vice versa — two
    // separate handlers, two separate server calls.
    expect(usersPage).toContain("await call('admin', 'deleteUser'")
    expect(usersPage).toContain("await call('admin', 'deleteRole'")
    // Role delete is now its own typed-name confirmation (not a plain
    // window.confirm), gated on the LIVE user count fetched fresh at
    // click time — never a count the table happened to render earlier.
    expect(usersPage).toContain("await call<Role[]>('admin', 'roles')")
    expect(usersPage).toContain('fresh.userCount > 0')
    expect(usersPage).toContain(
      'deleteRoleDialog?.confirmation.trim() !== deleteRoleDialog?.row.name.trim()'
    )
    // Deleting a user refreshes the roles list too, so a role's own
    // "المستخدمون" count in the table can never show a stale figure.
    expect(usersPage).toContain('Promise.all([users.reload(), roles.reload()])')
  })

  it('redesigns the material-categories tree: collapsed by default, icon actions, child-count badge on parents only', () => {
    const categories = read('src/renderer/pages/categories/CategoriesPage.tsx')
    // Item 1: collapse state starts empty — nothing pre-expanded, no
    // auto-expand-all left over from the old flat rendering.
    expect(categories).toContain('useState<Set<number>>(new Set())')
    // Item 5: icon-only actions, same convention/library as the rest
    // of the ERP — not the old "تعديل"/"حذف" text buttons.
    expect(categories).toContain('title="تعديل"')
    expect(categories).toContain('aria-label="تعديل"')
    expect(categories).toContain('title="حذف"')
    expect(categories).toContain('aria-label="حذف"')
    expect(categories).not.toContain('>تعديل</Button>')
    expect(categories).not.toContain('>حذف</Button>')
    // Root creation is explicit and each known organizational depth has
    // its own business label; the generic old child-material action is gone.
    expect(categories).not.toContain('+ إضافة مادة فرعية')
    expect(categories).toContain("? 'فئة مادة'")
    expect(categories).toContain("? 'نوع مادة'")
    expect(categories).toContain("? 'صنف مادة'")
    expect(categories).toContain('+ تصنيف رئيسي')
    expect(categories).toContain('isTopLevel &&')
    // Item 8: dynamic Arabic child-count wording, no new DB field.
    expect(categories).toContain('لا توجد مواد فرعية')
    expect(categories).toContain('مادة فرعية واحدة')
    // Item 11: search reveals a matching child's parent without
    // permanently touching the manual expand/collapse state.
    expect(categories).toContain('subtreeMatches')
    expect(categories).not.toContain('setExpanded(new Set(')
  })

  it('opens the shared Raw Material form only from an explicit material-type node', () => {
    const categories = read('src/renderer/pages/categories/CategoriesPage.tsx')
    // "+ فرعي" now opens the SHARED material form (reused, not forked)
    // preselecting the clicked type by id. Organizational parent actions
    // create the next organizational level instead.
    expect(categories).toContain("from '../materials/MaterialFormModal'")
    expect(categories).toContain('parentNodeId: node.id')
    expect(categories).toContain('clientRequestId: crypto.randomUUID()')
    expect(categories).toContain("node.nodeKind === 'material_type'")
    expect(categories).toContain('<MaterialFormModal')
    expect(categories).not.toContain("setEditing({ name: '', parentId: String(node.id) })")
    expect(categories).not.toContain('التصنيف الأب')
  })

  it('removes the obsolete Accessories toggle from every classification dialog', () => {
    const categories = read('src/renderer/pages/categories/CategoriesPage.tsx')
    expect(categories).not.toContain('تصنيف إكسسوارات — تظهر مواده في الفواتير')
    expect(categories).not.toContain('isAccessory')
  })

  it('links each material to filtered movement history, keeps edit, and drops the create entry point', () => {
    const materials = read('src/renderer/pages/materials/MaterialsPage.tsx')
    expect(materials).toContain('title="سجل حركة المخزون"')
    expect(materials).toContain('aria-label="سجل حركة المخزون"')
    expect(materials).toContain('`/inventory?materialId=${row.id}`')
    // Creation moved to تصنيفات المواد's "+ فرعي" — المواد الخام keeps
    // edit/delete/search/filter/stock but no longer offers "+ مادة جديدة".
    expect(materials).not.toContain('+ مادة جديدة')
    expect(materials).toContain('setMaterialRequest({ material: row })')
    // The create/edit form itself is the ONE shared component — never a
    // second copy of its fields/validation living in this page.
    expect(materials).toContain("from './MaterialFormModal'")
    expect(materials).toContain('<MaterialFormModal')
    expect(materials).not.toContain('form-section-title')
  })

  it('keeps Raw Materials viewing and editing without any deletion path', () => {
    const materials = read('src/renderer/pages/materials/MaterialsPage.tsx')
    expect(materials).toContain('setMaterialRequest({ material: row })')
    expect(materials).toContain('aria-label="سجل حركة المخزون"')
    expect(materials).not.toContain('fullDelete')
    expect(materials).not.toContain('removeMaterial')
    expect(materials).not.toContain('aria-label="حذف"')
    expect(materials).not.toContain('deleteDialog')
    expect(materials).not.toContain('onContextMenu')
    expect(materials).not.toContain('onKeyDown')
  })

  it('the shared Raw Material form creates under a stable parent id and keeps linked placement read-only', () => {
    const form = read('src/renderer/pages/materials/MaterialFormModal.tsx')
    // The root-only restriction is gone: create/edit uses the same
    // hierarchical, parent-and-child option list the filter already
    // builds — never a root-only subset, and no more disabled legacy
    // placeholder now that a subcategory is a normal, selectable choice.
    expect(form).not.toContain('rootCategoryOptions')
    expect(form).not.toContain('legacyEditCategory')
    expect(form).not.toContain('تصنيف فرعي حالي — محفوظ كما هو')
    expect(form).not.toContain('category.parentId === null && category.active')
    expect(form).toContain("call('categories', 'createChildMaterial'")
    expect(form).toContain('parentId: request.parentNodeId')
    expect(form).toContain('clientRequestId: request.clientRequestId')
    expect(form).toContain('request?.material?.hierarchyNodeId')
  })

  it('gives Worker delete a simple, non-destructive remove-from-active-list path that never reverses money or history', () => {
    const workersPage = read('src/renderer/pages/workers/WorkersPage.tsx')
    // A single plain call — no typed-name confirmation, no dependency
    // preview, no separate elevated permission: deleting a worker is
    // always safe, so it never needs to be.
    expect(workersPage).toContain("call('workers', 'remove'")
    expect(workersPage).not.toContain('fullDeletePreview')
    expect(workersPage).not.toContain("call('workers', 'fullDelete'")
    expect(workersPage).not.toContain('P.workers.fullDelete')
    expect(workersPage).not.toContain('deleteDialog')
    // The mandated wording is present, and the old misleading
    // reversal/disabled wording is gone for good.
    expect(workersPage).toContain(
      'سيتم حذف العامل من قائمة العمال الحالية ومنعه من التعيينات الجديدة'
    )
    expect(workersPage).toContain('مع الاحتفاظ بسجلاته ومستحقاته السابقة')
    expect(workersPage).not.toContain('تُعكَس مستحقاته')
    expect(workersPage).not.toContain('معطل')
    // The main list only ever shows active workers — a removed worker
    // never lingers here under any status badge.
    expect(workersPage).toContain("'workers', 'list', { search, activeOnly: true }")
  })

  it('makes Worker delete a plain archive-or-hard-delete, never a reversal of earnings/payments/cash', () => {
    const workersService = read('src/main/services/production/workers.service.ts')
    expect(workersService).not.toContain('export function reverseWorkerEarning(')
    expect(workersService).not.toContain('export function workerEarningReversalPreview(')
    expect(workersService).not.toContain('export function workerFullDeletePreview(')
    expect(workersService).not.toContain('export function fullDeleteWorker(')
    // The worker master-record delete itself never touches cash or
    // transaction history. Manual transaction deletion has its own
    // separately-authorized path later in this service.
    const deleteWorker = workersService.slice(
      workersService.indexOf('export function deleteWorker('),
      workersService.indexOf('export function computeCompensation(')
    )
    expect(deleteWorker).not.toContain('removeCashMovementForRef')
    expect(deleteWorker).not.toContain('DELETE FROM worker_transactions')
    // deleteWorker itself: hard-delete when there is no history at
    // all, otherwise archive via the worker's own existing `active`
    // lifecycle field — never a schema change, never a reversal.
    expect(workersService).toContain('export function deleteWorker(')
    expect(workersService).toContain('.set({ active: false })')
    // A removed (inactive) worker can never receive a fresh assignment.
    expect(workersService).toContain('if (!targetWorker.active)')
  })

  it('collects the "إلغاء الأمر" cancellation reason through a Modal, never window.prompt (Electron does not implement it)', () => {
    const production = read('src/renderer/pages/worksheets/ProductionOrderPage.tsx')
    // window.prompt() silently returns null in Electron's BrowserWindow —
    // no dialog is ever shown — so a reason gathered this way always
    // failed the `!reason?.trim()` guard and the cancel IPC call was
    // never reached. This was the root cause of the reported bug.
    expect(production).not.toContain("window.prompt('سبب إلغاء أمر التصنيع؟')")
    // The reason is now collected through the same Modal + Field/Input
    // pattern used elsewhere in this ERP, validated before the IPC call.
    expect(production).toContain("call('production', 'cancelProduction'")
    expect(production).toContain('سبب إلغاء أمر التصنيع مطلوب')
    expect(production).toContain('cancelDialog.reason.trim()')
  })
})
