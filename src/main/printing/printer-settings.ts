/** Printer defaults, remembered in app-config.ts (not the business
 * database) — general Windows desktop behavior, not a business rule. */
export interface PrinterSettings {
  defaultPrinterName?: string
  paperSize: 'A4'
}
