import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { shell } from 'electron'

vi.mock('@main/windows/print-window', () => ({
  createPrintWindow: vi.fn()
}))

import { createPrintWindow } from '@main/windows/print-window'
import { printFinalInvoice } from '@main/services/documents/print.service'

function printWindow(options: {
  printSuccess?: boolean
  printReason?: string
  pdf?: Buffer
}) {
  let destroyed = false
  return {
    loadURL: vi.fn(async () => undefined),
    isDestroyed: vi.fn(() => destroyed),
    destroy: vi.fn(() => { destroyed = true }),
    webContents: {
      print: vi.fn((_settings, callback) => {
        callback(options.printSuccess ?? true, options.printReason ?? '')
      }),
      printToPDF: vi.fn(async () => options.pdf ?? Buffer.from('%PDF-test'))
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(createPrintWindow).mockReset()
})

describe('Approved Invoice print output', () => {
  it('keeps the native print flow when Electron reaches a printer', async () => {
    const win = printWindow({ printSuccess: true })
    vi.mocked(createPrintWindow).mockReturnValue(win as never)
    const open = vi.spyOn(shell, 'openPath')

    await expect(printFinalInvoice('<html dir="rtl">فاتورة</html>', 'FI-PRINT'))
      .resolves.toEqual({ method: 'printer' })
    expect(win.webContents.print).toHaveBeenCalledOnce()
    expect(win.webContents.printToPDF).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('generates and opens the complete PDF when the OS has no printers', async () => {
    const nativeWindow = printWindow({
      printSuccess: false,
      printReason: 'No printers available on the network'
    })
    const pdfBytes = Buffer.from('%PDF-1.7 approved invoice content')
    const pdfWindow = printWindow({ pdf: pdfBytes })
    vi.mocked(createPrintWindow)
      .mockReturnValueOnce(nativeWindow as never)
      .mockReturnValueOnce(pdfWindow as never)
    const open = vi.spyOn(shell, 'openPath').mockResolvedValue('')

    const result = await printFinalInvoice(
      '<html dir="rtl"><body>فاتورة معتمدة</body></html>',
      'FI-NO-PRINTER'
    )

    expect(result.method).toBe('pdf')
    if (result.method !== 'pdf') throw new Error('Expected PDF fallback')
    expect(existsSync(result.path)).toBe(true)
    expect(readFileSync(result.path)).toEqual(pdfBytes)
    expect(pdfWindow.webContents.printToPDF).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledWith(result.path)
    rmSync(result.path, { force: true })
  })

  it('does not convert unrelated print failures into a PDF', async () => {
    const win = printWindow({ printSuccess: false, printReason: 'Invalid printer settings' })
    vi.mocked(createPrintWindow).mockReturnValue(win as never)
    const open = vi.spyOn(shell, 'openPath')

    await expect(printFinalInvoice('<html></html>', 'FI-ERROR'))
      .rejects.toThrow('Invalid printer settings')
    expect(open).not.toHaveBeenCalled()
  })
})
