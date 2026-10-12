import { writeFile } from 'node:fs/promises'
import { loadDocumentForPrint } from '../../printing/print-window.manager'

export async function exportDocumentToPdf(html: string, outputPath: string): Promise<void> {
  const win = await loadDocumentForPrint(html)
  try {
    const pdfBuffer = await win.webContents.printToPDF({ landscape: false, pageSize: 'A4' })
    await writeFile(outputPath, pdfBuffer)
  } finally {
    win.destroy()
  }
}
