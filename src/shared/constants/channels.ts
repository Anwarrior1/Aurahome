/**
 * The complete, fixed set of privileged operations the renderer can
 * request. There is no generic invoke(channel) anywhere: the preload
 * bridge exposes one named method per entry below, bound to that
 * literal channel string, so a channel not listed here does not exist
 * (Step 2 §4, Step 3 preload requirements).
 */
export const IPC_CHANNELS = {
  auth: {
    login: 'auth:login',
    logout: 'auth:logout',
    setupStatus: 'auth:setupStatus',
    performSetup: 'auth:performSetup',
    setTheme: 'auth:setTheme',
    /** "تذكرني" — resumes a remembered login, if any; see auth.service.ts. */
    tryResume: 'auth:tryResume'
  },
  system: { getAppInfo: 'system:getAppInfo' },
  dashboard: { summary: 'dashboard:summary' },
  notifications: {
    list: 'notifications:list',
    markAllRead: 'notifications:markAllRead',
    dismiss: 'notifications:dismiss',
    clearAll: 'notifications:clearAll'
  },
  profile: {
    getMyPhoto: 'profile:getMyPhoto',
    pickImage: 'profile:pickImage',
    /** Reads the just-picked file back as a data: URI for the crop
     *  dialog's preview only — writes nothing (see setPhoto). */
    readImageForCrop: 'profile:readImageForCrop',
    /** Saves the FINAL cropped/normalized image (a data: URI), not
     *  the original file. */
    setPhoto: 'profile:setPhoto',
    removePhoto: 'profile:removePhoto'
  },
  categories: {
    tree: 'categories:tree',
    list: 'categories:list',
    create: 'categories:create',
    createChildMaterial: 'categories:createChildMaterial',
    update: 'categories:update',
    deletePreview: 'categories:deletePreview',
    materialDeletePreview: 'categories:materialDeletePreview',
    removeMaterial: 'categories:removeMaterial',
    remove: 'categories:remove'
  },
  colors: {
    materialOptions: 'colors:materialOptions',
    list: 'colors:list',
    create: 'colors:create',
    update: 'colors:update',
    remove: 'colors:remove'
  },
  materials: {
    list: 'materials:list',
    /** Active Color Catalog choices used while creating/editing an
     * inventory leaf. Read-only and scoped to material managers. */
    colorOptions: 'materials:colorOptions',
    /** Raw Materials that qualify as accessories (BR-50) — the source
     *  sales documents pick from. Read-only. */
    accessories: 'materials:accessories',
    /** Every active Raw Material, for the "نوع المادة" selector on
     *  sales documents. Read-only. */
    types: 'materials:types',
    get: 'materials:get',
    create: 'materials:create',
    update: 'materials:update',
    remove: 'materials:remove',
    fullDeletePreview: 'materials:fullDeletePreview',
    fullDelete: 'materials:fullDelete'
  },
  inventory: {
    stock: 'inventory:stock',
    valuation: 'inventory:valuation',
    movements: 'inventory:movements',
    waste: 'inventory:waste',
    adjust: 'inventory:adjust',
    remainders: 'inventory:remainders',
    addRemainder: 'inventory:addRemainder'
  },
  customers: {
    list: 'customers:list',
    create: 'customers:create',
    update: 'customers:update',
    remove: 'customers:remove',
    archive: 'customers:archive',
    restore: 'customers:restore',
    balances: 'customers:balances',
    statement: 'customers:statement'
  },
  suppliers: {
    list: 'suppliers:list',
    create: 'suppliers:create',
    update: 'suppliers:update',
    remove: 'suppliers:remove',
    balances: 'suppliers:balances',
    statement: 'suppliers:statement',
    fullDeletePreview: 'suppliers:fullDeletePreview',
    fullDelete: 'suppliers:fullDelete'
  },
  purchases: {
    list: 'purchases:list',
    forOrder: 'purchases:forOrder',
    get: 'purchases:get',
    create: 'purchases:create',
    update: 'purchases:update',
    remove: 'purchases:remove',
    pay: 'purchases:pay',
    updateSupplierPayment: 'purchases:updateSupplierPayment',
    deleteSupplierPayment: 'purchases:deleteSupplierPayment',
    fullDeletePreview: 'purchases:fullDeletePreview',
    fullDelete: 'purchases:fullDelete'
  },
  products: {
    list: 'products:list',
    get: 'products:get',
    create: 'products:create',
    update: 'products:update',
    setBom: 'products:setBom',
    setMachines: 'products:setMachines',
    setCommission: 'products:setCommission',
    fullDeletePreview: 'products:fullDeletePreview',
    fullDelete: 'products:fullDelete',
    /** BL-04 «صرف من المخزون»: consume BOM × N and add N ready units, atomically. */
    stockIssuePreview: 'products:stockIssuePreview',
    issueStockFromBom: 'products:issueStockFromBom'
  },
  quotations: {
    list: 'quotations:list',
    get: 'quotations:get',
    create: 'quotations:create',
    createStandard: 'quotations:createStandard',
    update: 'quotations:update',
    /** Prepare/send the customer document. Creates no order (workflow pass). */
    issue: 'quotations:issue',
    revise: 'quotations:revise',
    cancel: 'quotations:cancel',
    remove: 'quotations:remove',
    deletePreview: 'quotations:deletePreview'
  },
  orders: {
    list: 'orders:list',
    get: 'orders:get',
    update: 'orders:update',
    archive: 'orders:archive',
    restore: 'orders:restore',
    reverseCompletion: 'orders:reverseCompletion',
    fulfillFromStock: 'orders:fulfillFromStock',
    remove: 'orders:remove',
    deletionBlockers: 'orders:deletionBlockers',
    fullDeletePreview: 'orders:fullDeletePreview',
    fullDelete: 'orders:fullDelete',
    estimate: 'orders:estimate',
    planningSnapshot: 'orders:planningSnapshot',
    fulfillment: 'orders:fulfillment',
    /** Production configuration — the order owns it (workflow pass). */
    savePlannedMaterials: 'orders:savePlannedMaterials',
    savePlannedMachines: 'orders:savePlannedMachines',
    savePlannedWorkers: 'orders:savePlannedWorkers',
    savePlannedExpenses: 'orders:savePlannedExpenses',
    recordPayment: 'orders:recordPayment',
    refundPayment: 'orders:refundPayment',
    cancel: 'orders:cancel',
    costing: 'orders:costing',
    profitability: 'orders:profitability'
  },
  production: {
    consumeMaterial: 'production:consumeMaterial',
    materialReturns: 'production:materialReturns',
    createMaterialReturn: 'production:createMaterialReturn',
    editMaterialReturn: 'production:editMaterialReturn',
    reverseMaterialReturn: 'production:reverseMaterialReturn',
    correctMaterialConsumption: 'production:correctMaterialConsumption',
    reverseMaterialConsumption: 'production:reverseMaterialConsumption',
    materialLines: 'production:materialLines',
    issueWorkSheet: 'production:issueWorkSheet',
    listWorkSheets: 'production:listWorkSheets',
    listOperationalWorkSheets: 'production:listOperationalWorkSheets',
    getWorkSheet: 'production:getWorkSheet',
    startProduction: 'production:startProduction',
    completeProduction: 'production:completeProduction',
    cancelProduction: 'production:cancelProduction',
    reverseWorkSheet: 'production:reverseWorkSheet',
    updatePlannedMaterials: 'production:updatePlannedMaterials',
    remove: 'production:remove',
    issueRelease: 'production:issueRelease',
    reverseRelease: 'production:reverseRelease',
    listReleases: 'production:listReleases',
    recordDelivery: 'production:recordDelivery',
    cancelDelivery: 'production:cancelDelivery',
    listDeliveries: 'production:listDeliveries',
    finishedGoods: 'production:finishedGoods',
    finishedGoodsMovements: 'production:finishedGoodsMovements'
  },
  finalInvoices: {
    list: 'finalInvoices:list',
    get: 'finalInvoices:get',
    depositDefault: 'finalInvoices:depositDefault',
    create: 'finalInvoices:create',
    createStandard: 'finalInvoices:createStandard',
    update: 'finalInvoices:update',
    /** THE authoritative approval that creates the Customer Order. */
    approve: 'finalInvoices:approve',
    unapprove: 'finalInvoices:unapprove',
    cancel: 'finalInvoices:cancel',
    remove: 'finalInvoices:remove',
    forOrder: 'finalInvoices:forOrder',
    /** The one global Terms/Conditions catalog — read-only here, reused
     *  (never duplicated) from the same source Settings/quotations use. */
    termsCatalog: 'finalInvoices:termsCatalog',
    addTerms: 'finalInvoices:addTerms',
    removeTerm: 'finalInvoices:removeTerm'
  },
  /** "المنتجات غير المستلمة" — physical products manufactured for a
   *  Customer Order the customer abandoned, now sellable as they are. */
  uncollectedProducts: {
    list: 'uncollectedProducts:list',
    get: 'uncollectedProducts:get',
    /** Picker source for an Approved Invoice line — available only. */
    available: 'uncollectedProducts:available',
    /** Traceability from the cancelled Customer Order that produced them. */
    forOrder: 'uncollectedProducts:forOrder',
    resume: 'uncollectedProducts:resume'
  },
  machines: {
    list: 'machines:list',
    create: 'machines:create',
    update: 'machines:update',
    remove: 'machines:remove',
    usageForOrder: 'machines:usageForOrder'
  },
  workers: {
    list: 'workers:list',
    commissionAccounts: 'workers:commissionAccounts',
    create: 'workers:create',
    update: 'workers:update',
    remove: 'workers:remove',
    statement: 'workers:statement',
    transaction: 'workers:transaction',
    updateTransaction: 'workers:updateTransaction',
    deleteTransaction: 'workers:deleteTransaction',
    /** CC04 "دفعة": pay recognised commission payable. */
    payCommission: 'workers:payCommission'
  },
  employees: {
    list: 'employees:list',
    listFormerSettlements: 'employees:listFormerSettlements',
    create: 'employees:create',
    update: 'employees:update',
    remove: 'employees:remove',
    dismissFormerSettlement: 'employees:dismissFormerSettlement',
    deletePreview: 'employees:deletePreview',
    fullDelete: 'employees:fullDelete',
    statement: 'employees:statement',
    paySalary: 'employees:paySalary',
    transaction: 'employees:transaction',
    updateTransaction: 'employees:updateTransaction',
    deleteTransaction: 'employees:deleteTransaction',
    listDeductions: 'employees:listDeductions',
    listAdvances: 'employees:listAdvances',
    listSalaryPayments: 'employees:listSalaryPayments',
    reverseSalaryPayment: 'employees:reverseSalaryPayment',
    deleteSalaryPaymentHistory: 'employees:deleteSalaryPaymentHistory',
    payroll: 'employees:payroll'
  },
  expenses: {
    list: 'expenses:list',
    summary: 'expenses:summary',
    create: 'expenses:create',
    update: 'expenses:update',
    remove: 'expenses:remove',
    categories: 'expenses:categories',
    createCategory: 'expenses:createCategory',
    updateCategory: 'expenses:updateCategory',
    removeCategory: 'expenses:removeCategory',
    listRecurring: 'expenses:listRecurring',
    getRecurring: 'expenses:getRecurring',
    createRecurring: 'expenses:createRecurring',
    updateRecurring: 'expenses:updateRecurring',
    changeRecurringAmount: 'expenses:changeRecurringAmount',
    removeRecurring: 'expenses:removeRecurring'
  },
  cash: {
    accounts: 'cash:accounts',
    createAccount: 'cash:createAccount',
    updateAccount: 'cash:updateAccount',
    removeAccount: 'cash:removeAccount',
    adjustBalance: 'cash:adjustBalance',
    transactions: 'cash:transactions',
    updateTransaction: 'cash:updateTransaction',
    removeTransaction: 'cash:removeTransaction',
    transfer: 'cash:transfer',
    getTransfer: 'cash:getTransfer',
    updateTransfer: 'cash:updateTransfer',
    removeTransfer: 'cash:removeTransfer',
    fullDeleteAccountPreview: 'cash:fullDeleteAccountPreview',
    fullDeleteAccount: 'cash:fullDeleteAccount'
  },
  profit: {
    monthly: 'profit:monthly',
    savingsHistory: 'profit:savingsHistory',
    savingsOverview: 'profit:savingsOverview',
    setSavingsRate: 'profit:setSavingsRate',
    confirmAllocation: 'profit:confirmAllocation',
    updateAllocation: 'profit:updateAllocation',
    removeAllocation: 'profit:removeAllocation',
    recordSavingsUsage: 'profit:recordSavingsUsage',
    withdrawals: 'profit:withdrawals',
    recordWithdrawal: 'profit:recordWithdrawal',
    updateWithdrawal: 'profit:updateWithdrawal',
    removeWithdrawal: 'profit:removeWithdrawal'
  },
  reports: { available: 'reports:available', build: 'reports:build' },
  documents: {
    preview: 'documents:preview',
    print: 'documents:print',
    exportPdf: 'documents:exportPdf',
    printReport: 'documents:printReport',
    exportReportPdf: 'documents:exportReportPdf'
  },
  admin: {
    users: 'admin:users',
    createUser: 'admin:createUser',
    updateUser: 'admin:updateUser',
    deleteUser: 'admin:deleteUser',
    roles: 'admin:roles',
    createRole: 'admin:createRole',
    updateRole: 'admin:updateRole',
    deleteRole: 'admin:deleteRole',
    permissions: 'admin:permissions',
    audit: 'admin:audit'
  },
  settings: { getAll: 'settings:getAll', set: 'settings:set' },
  backup: {
    create: 'backup:create',
    validate: 'backup:validate',
    restore: 'backup:restore',
    pickSavePath: 'backup:pickSavePath',
    pickFile: 'backup:pickFile'
  }
} as const

export type ChannelMap = typeof IPC_CHANNELS
