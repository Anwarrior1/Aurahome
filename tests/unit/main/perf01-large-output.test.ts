import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

const fault = vi.hoisted(() => ({ write: false, rename: false }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      await fs.writeFile(...args)
      if (fault.write) throw new Error('partial write failure')
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (fault.rename) throw new Error('publication failure')
      await fs.rename(...args)
    }
  }
})

vi.mock('@main/windows/print-window', () => ({ createPrintWindow: vi.fn() }))
import { createPrintWindow } from '@main/windows/print-window'
import { exportPdf, printHtml } from '@main/services/documents/print.service'

function windowFixture() {
  let destroyed = false
  return {
    loadURL: vi.fn(async (_url: string) => undefined),
    isDestroyed: vi.fn(() => destroyed),
    destroy: vi.fn(() => {
      destroyed = true
    }),
    webContents: {
      print: vi.fn((_options, callback) => callback(true)),
      printToPDF: vi.fn(async () => Buffer.from('%PDF-1.7\nfixture\n%%EOF'))
    }
  }
}

afterEach(() => {
  vi.mocked(createPrintWindow).mockReset()
  fault.write = false
  fault.rename = false
})

describe('PERF-01 complete document output transport', () => {
  it('loads a complete 10,034-row UTF-8 report without percent-encoding expansion', async () => {
    const html =
      '<html dir="rtl"><body><table><tbody>' +
      Array.from(
        { length: 10034 },
        (_, i) =>
          `<tr><td>PERF${String(i).padStart(6, '0')}</td><td>أرصدة العملاء &amp; المبلغ</td><td>42.750,00 د.ل</td></tr>`
      ).join('') +
      '</tbody></table></body></html>'
    const win = windowFixture()
    vi.mocked(createPrintWindow).mockReturnValue(win as never)
    await printHtml(html)
    const url = win.loadURL.mock.calls[0][0]
    expect(url).toMatch(/^data:text\/html;charset=utf-8;base64,/)
    expect(url.length).toBeLessThan(2 * 1024 * 1024)
    expect(Buffer.from(url.split(',')[1], 'base64').toString('utf8')).toBe(html)
    expect(win.webContents.print).toHaveBeenCalledOnce()
    expect(win.destroy).toHaveBeenCalledOnce()
  })

  it.each(['print', 'pdf'] as const)(
    'destroys a rejected loading window before the %s leaf',
    async (kind) => {
      const win = windowFixture()
      win.loadURL.mockRejectedValue(new Error('ERR_INVALID_URL'))
      vi.mocked(createPrintWindow).mockReturnValue(win as never)
      const action =
        kind === 'print'
          ? printHtml('<html>bad load</html>')
          : exportPdf('<html>bad load</html>', 'reports', 'PERF01-REJECTED')
      await expect(action).rejects.toThrow('ERR_INVALID_URL')
      expect(win.destroy).toHaveBeenCalledOnce()
      expect(win.webContents.print).not.toHaveBeenCalled()
      expect(win.webContents.printToPDF).not.toHaveBeenCalled()
    }
  )

  it('does not publish a PDF when native generation fails', async () => {
    const win = windowFixture()
    win.webContents.printToPDF.mockRejectedValue(new Error('native failure'))
    vi.mocked(createPrintWindow).mockReturnValue(win as never)
    await expect(
      exportPdf('<html>complete</html>', 'reports', 'PERF01-NATIVE-FAILURE')
    ).rejects.toThrow('native failure')
    expect(win.destroy).toHaveBeenCalledOnce()
  })

  it('preserves the existing PDF filename and replacement semantics', async () => {
    const first = windowFixture(),
      second = windowFixture()
    const bytes = Buffer.from('%PDF-1.7\nsecond complete fixture\n%%EOF')
    second.webContents.printToPDF.mockResolvedValue(bytes)
    vi.mocked(createPrintWindow)
      .mockReturnValueOnce(first as never)
      .mockReturnValueOnce(second as never)
    const a = await exportPdf('<html>first</html>', 'reports', 'PERF01-COLLISION')
    try {
      const b = await exportPdf('<html>second</html>', 'reports', 'PERF01-COLLISION')
      expect(b.path).toBe(a.path)
      expect(existsSync(a.path)).toBe(true)
      expect(readFileSync(a.path)).toEqual(bytes)
      expect(first.destroy).toHaveBeenCalledOnce()
      expect(second.destroy).toHaveBeenCalledOnce()
    } finally {
      rmSync(a.path, { force: true })
    }
  })

  it.each(['write', 'rename'] as const)(
    'preserves an existing PDF and removes scratch bytes on %s failure',
    async (stage) => {
      const first = windowFixture(),
        second = windowFixture()
      vi.mocked(createPrintWindow)
        .mockReturnValueOnce(first as never)
        .mockReturnValueOnce(second as never)
      const { path } = await exportPdf('<html>original</html>', 'reports', 'PERF01-PUBLICATION')
      const original = readFileSync(path)
      const entries = readdirSync(dirname(path)).sort()
      try {
        fault[stage] = true
        await expect(
          exportPdf('<html>replacement</html>', 'reports', 'PERF01-PUBLICATION')
        ).rejects.toThrow(stage === 'write' ? 'partial write failure' : 'publication failure')
        expect(readFileSync(path)).toEqual(original)
        expect(readdirSync(dirname(path)).sort()).toEqual(entries)
        expect(second.destroy).toHaveBeenCalledOnce()
      } finally {
        rmSync(path, { force: true })
      }
    }
  )
})
