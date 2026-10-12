import {
  Home, Users, FilePenLine, ClipboardList, Boxes, FolderTree, Palette,
  ArrowLeftRight, BarChart3, Handshake, ArrowDownToLine, LayoutGrid,
  Cog, DoorOpen, PackageCheck, Wrench, HardHat, Wallet, MinusCircle, ReceiptText,
  UserCog, TrendingUp, PiggyBank, ArrowUpCircle, FileBarChart2,
  KeyRound, History, Archive, Settings,
  ShoppingCart, Warehouse, Factory, Landmark, MonitorCog, PackageOpen, type LucideIcon
} from 'lucide-react'

/**
 * Sidebar icon set (Step-4 follow-up: icon style pass only). One
 * consistent stroke-based icon per nav item, keyed by the `icon` name
 * in routes/nav.ts — never inline in nav.ts so brand color/sizing stay
 * centralized here and in global.css's .sidebar__icon-wrap.
 */
export const NAV_ICONS: Record<string, LucideIcon> = {
  home: Home,
  customers: Users,
  quotations: FilePenLine,
  orders: ClipboardList,
  finalInvoices: ReceiptText,
  materials: Boxes,
  categories: FolderTree,
  colors: Palette,
  inventory: ArrowLeftRight,
  valuation: BarChart3,
  suppliers: Handshake,
  purchases: ArrowDownToLine,
  products: LayoutGrid,
  worksheets: Cog,
  releases: DoorOpen,
  deliveries: PackageCheck,
  uncollectedProducts: PackageOpen,
  machines: Wrench,
  workers: HardHat,
  cash: Wallet,
  expenses: MinusCircle,
  employees: UserCog,
  profit: TrendingUp,
  savings: PiggyBank,
  withdrawals: ArrowUpCircle,
  reports: FileBarChart2,
  users: KeyRound,
  audit: History,
  backup: Archive,
  settings: Settings,

  // Group-header icons only (sidebar redesign — collapsible sections).
  // Distinct from every item icon above so a section's own header
  // never visually duplicates one of its children's icons.
  groupSales: ShoppingCart,
  groupInventory: Warehouse,
  groupProduction: Factory,
  groupFinance: Landmark,
  groupSystem: MonitorCog
}
