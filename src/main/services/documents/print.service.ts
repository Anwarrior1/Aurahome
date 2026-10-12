import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { writeFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { BrowserWindow, shell } from 'electron'
import { createPrintWindow } from '../../windows/print-window'
import { getDocumentsRoot } from '../../files/paths'
import {
  renderPreliminaryInvoice,
  renderFinalInvoice,
  renderWorkSheet,
  renderRelease,
  renderReport
} from '../../reports/templates/documents.template'
import {
  buildPreliminaryInvoice,
  buildFinalInvoice,
  buildWorkSheet,
  buildRelease,
  companyBlock
} from './documents.service'
import type { ServiceContext } from '../base/service.types'
import type { ReportDTO } from '../../reports/dto/report.dto'
import { AppError } from '../../utils/errors'
import { logger } from '../../utils/logger'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { requirePermission } from '../../permissions/permission-guard'

export type DocumentKind =
  | 'preliminary_invoice'
  | 'final_invoice'
  | 'work_sheet'
  | 'installation_release'
  | 'delivery_release'

function documentReadPermission(kind: DocumentKind): string {
  switch (kind) {
    case 'preliminary_invoice': return P.quotations.view
    case 'final_invoice': return P.finalInvoices.view
    case 'work_sheet': return P.worksheets.view
    case 'installation_release':
    case 'delivery_release': return P.releases.view
    default: throw new AppError('VALIDATION_ERROR', 'نوع المستند غير معروف')
  }
}

/** Authoritative output owner shared by preview, print and PDF export. */
export function renderDocumentHtml(
  kind: DocumentKind,
  id: number,
  ctx: ServiceContext
): { html: string; documentNumber: string } {
  try {
    // Guard before DTO construction. Snapshot builders also serve independently
    // authorized lifecycle writers, so their internal calls retain that authority.
    requirePermission(ctx.session, documentReadPermission(kind))
    const company = companyBlock()
    switch (kind) {
      case 'preliminary_invoice': {
        const dto = buildPreliminaryInvoice(id)
        return { html: renderPreliminaryInvoice(dto, company), documentNumber: dto.documentNumber }
      }
      case 'final_invoice': {
        const dto = buildFinalInvoice(id)
        return { html: renderFinalInvoice(dto, company), documentNumber: dto.documentNumber }
      }
      case 'work_sheet': {
        const dto = buildWorkSheet(id, ctx)
        return { html: renderWorkSheet(dto, company), documentNumber: dto.documentNumber }
      }
      case 'installation_release':
      case 'delivery_release': {
        const dto = buildRelease(id)
        return { html: renderRelease(dto, company), documentNumber: dto.documentNumber }
      }
      default:
        throw new AppError('VALIDATION_ERROR', 'نوع المستند غير معروف')
    }
  } catch (error) {
    logger.error(`Document render failed [kind=${kind}, id=${id}]`, error)
    throw error
  }
}

export function renderReportHtml(dto: ReportDTO<Record<string, string>>): string {
  return renderReport(dto, companyBlock())
}

async function loadHtml(html: string): Promise<BrowserWindow> {
  const win = createPrintWindow()
  try {
    // Keep the existing isolated data origin without percent-encoding expansion.
    await win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`)
    // Give Chromium a moment to lay out the bundled Cairo webfonts.
    await new Promise((resolve) => setTimeout(resolve, 150))
    return win
  } catch (error) {
    if (!win.isDestroyed()) win.destroy()
    throw error
  }
}

/** Direct local printing with the OS print dialog (Step 2 §9). */
export async function printHtml(html: string): Promise<void> {
  const win = await loadHtml(html)
  try {
    await new Promise<void>((resolve, reject) => {
      win.webContents.print({ silent: false, printBackground: true }, (success, reason) => {
        if (!success && reason && reason !== 'cancelled') reject(new Error(reason))
        else resolve()
      })
    })
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

export type PrintDelivery =
  | { method: 'printer' }
  | { method: 'pdf'; path: string }

function noPrinterAvailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return message.includes('no printer') || message.includes('printers unavailable')
}

/**
 * Sends a document to the native print dialog. Electron fails before it
 * can show that dialog when the OS has no configured printers; in that
 * one case, preserve the user's print flow by opening the same rendered
 * document as a real PDF. Other output failures remain failures.
 */
export async function printFinalInvoice(
  html: string,
  documentNumber: string
): Promise<PrintDelivery> {
  try {
    await printHtml(html)
    return { method: 'printer' }
  } catch (error) {
    if (!noPrinterAvailable(error)) throw error

    logger.warn(`No printer available; opening PDF fallback [kind=final_invoice, document=${documentNumber}]`, error)
    const { path } = await exportPdf(html, 'final_invoice', documentNumber)
    const openError = await shell.openPath(path)
    if (openError) throw new Error(`Failed to open print fallback PDF: ${openError}`)
    return { method: 'pdf', path }
  }
}

/** PDF export, archived under %APPDATA%\AURA home\documents\<year>\<type>. */
export async function exportPdf(
  html: string,
  kind: string,
  documentNumber: string
): Promise<{ path: string }> {
  const win = await loadHtml(html)
  try {
    const buffer = await win.webContents.printToPDF({
      pageSize: 'A4',
      landscape: false,
      printBackground: true
      // Margins are left at Electron's default and controlled by each
      // template's own `@page { margin: ... }` CSS. (Electron 43 removed
      // the old `margins: { marginType: 'default' }` option.)
    })
    const year = String(new Date().getFullYear())
    const dir = join(getDocumentsRoot(), year, kind)
    mkdirSync(dir, { recursive: true })
    const safeName = documentNumber.replace(/[^A-Za-z0-9._-]/g, '_') || `document-${Date.now()}`
    const path = join(dir, `${safeName}.pdf`)
    const pending = join(dir, `.${safeName}.${randomUUID()}.tmp`)
    try {
      await writeFile(pending, buffer, { flag: 'wx' })
      await rename(pending, path)
    } finally {
      await rm(pending, { force: true })
    }
    return { path }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
