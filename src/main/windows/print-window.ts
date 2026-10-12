import { BrowserWindow } from 'electron'

/**
 * Creates an off-screen window used only to render document HTML
 * (Preliminary Invoice, Final Invoice, Manufacturing Work Sheet,
 * Installation Authorization, Delivery Release, reports) for direct
 * printing or PDF export (Step 2 §9). Loads app://assets content and
 * the same design tokens/fonts as the main UI — never a network URL.
 * See src/main/reports and src/main/printing.
 */
export function createPrintWindow(): BrowserWindow {
  return new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
}
