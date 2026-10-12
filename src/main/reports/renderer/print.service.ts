import { loadDocumentForPrint } from '../../printing/print-window.manager'

export async function printDocument(html: string): Promise<void> {
  const win = await loadDocumentForPrint(html)
  try {
    await win.webContents.print({ silent: false })
  } finally {
    win.destroy()
  }
}
