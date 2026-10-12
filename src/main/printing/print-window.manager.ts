import { createPrintWindow } from '../windows/print-window'

/**
 * Loads generated document HTML into a hidden window and returns it
 * ready for print() or printToPDF() (Step 2 §9). Callers must destroy
 * the window when done — see src/main/reports/renderer.
 */
export async function loadDocumentForPrint(html: string) {
  const win = createPrintWindow()
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  return win
}
