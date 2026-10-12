import { DOCUMENT_STYLES } from './document-styles'
import type { CustomerDocumentDTO } from '../dto/customer-document.dto'
import type { InternalWorkSheetDTO } from '../dto/internal-worksheet.dto'
import type { InternalReleaseDTO } from '../dto/internal-release.dto'
import type { ReportDTO } from '../dto/report.dto'
import { EXIT_PERMIT_LABEL, permitIncludesInstallation } from '@shared/production/exit-permit'

export interface CompanyInfo {
  name: string
  phone?: string
  address?: string
}

function esc(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

type ItemColumnKey = keyof CustomerDocumentDTO['itemColumns']

/**
 * The items table's optional columns, in their fixed display order.
 * Whether each one actually renders comes from `dto.itemColumns`
 * (itself resolved straight from the document's saved print-visibility
 * configuration) — never from whether a line's formatted value happens
 * to be an empty string, and never a hardcoded column set.
 */
const ITEM_COLUMNS: Array<{ key: ItemColumnKey; header: string; width: string; numeric: boolean }> = [
  { key: 'description', header: 'البيان', width: '', numeric: false },
  { key: 'quantity', header: 'الكمية', width: '70px', numeric: true },
  { key: 'unitPrice', header: 'سعر الوحدة', width: '110px', numeric: true },
  { key: 'lineTotal', header: 'الإجمالي', width: '120px', numeric: true }
]

function visibleItemColumns(dto: CustomerDocumentDTO): typeof ITEM_COLUMNS {
  return ITEM_COLUMNS.filter((column) => dto.itemColumns[column.key])
}

/**
 * The items table's `<thead>` row, built from ONLY the columns this
 * document is allowed to print. An unchecked column has no `<th>` here
 * at all — no header text, no reserved width — so the browser's normal
 * (non-fixed) table layout gives its space to whatever columns remain,
 * with no manual width recalculation needed.
 */
function itemsTableHead(dto: CustomerDocumentDTO): string {
  const cells = visibleItemColumns(dto)
    .map(
      (column) =>
        `<th${column.numeric ? ' class="num"' : ''}${column.width ? ` style="width:${column.width}"` : ''}>${esc(column.header)}</th>`
    )
    .join('')
  return `<th style="width:32px">#</th>${cells}`
}

/** One item row's `<td>`s, built from the same column set as the head — never one cell per possible column with a blank value standing in for a hidden one. */
function itemRowCells(dto: CustomerDocumentDTO, line: CustomerDocumentDTO['lines'][number], index: number): string {
  const values: Record<ItemColumnKey, string> = {
    description: `<td><div>${esc(line.description)}</div></td>`,
    quantity: `<td class="num">${esc(line.quantity)}</td>`,
    unitPrice: `<td class="num">${esc(line.unitPrice)}</td>`,
    lineTotal: `<td class="num">${esc(line.lineTotal)}</td>`
  }
  const cells = visibleItemColumns(dto)
    .map((column) => values[column.key])
    .join('')
  return `<td class="num">${index + 1}</td>${cells}`
}

/**
 * The item's specifications, as their OWN table row directly beneath
 * its "البيان" row — never merged into the same cell. `colspan` reaches
 * from the first optional column to the far edge, so the box matches
 * the item row's full VISIBLE content width — never wider than the
 * columns actually printed, and never narrower, however many of them
 * are hidden. Renders nothing at all when the line has no specification
 * content, so a plain line never leaves an empty box behind (the same
 * "omit when empty" convention already used for discount/deposit rows
 * and the work-sheet's optional sections elsewhere in this file).
 */
function specRow(dto: CustomerDocumentDTO, parts: string[]): string {
  const content = parts.filter(Boolean).join('')
  if (!content) return ''
  const colspan = Math.max(visibleItemColumns(dto).length, 1)
  return `<tr class="spec-row"><td></td><td colspan="${colspan}"><div class="spec-box"><div class="spec-label">المواصفات وملاحظات التصنيع</div>${content}</div></td></tr>`
}

/** Both commercial PDFs share the same grouped, visibility-filtered presentation. */
function materialColorRows(line: CustomerDocumentDTO['lines'][number]): string {
  if (line.materialGroups !== undefined) {
    return line.materialGroups.map(group => `<div class="material-color-group">${group.material ? `<div class="spec">المادة: ${esc(group.material)}</div>` : ''}${group.colors ? `<div class="spec">اللون/التشطيب: ${esc(group.colors)}</div>` : ''}</div>`).join('')
      + (line.unmappedColors ? `<div class="spec">ألوان/تشطيبات محفوظة دون ارتباط مؤكد بمادة: ${esc(line.unmappedColors)}</div>` : '')
  }
  // Compatibility for older callers providing a preformatted document DTO.
  return (line.materialType ? `<div class="spec">نوع المادة: ${esc(line.materialType)}</div>` : '')
    + (line.colorCode ? `<div class="spec">كود اللون/التشطيب: ${esc(line.colorCode)}</div>` : '')
}

/**
 * The fulfilment statements ("يشمل التركيب" / "يشمل التوصيل").
 *
 * The DTO has already applied both gates — the document's own business
 * boolean AND its print visibility — so a flag arriving here true is
 * always a true statement the document is allowed to make. Renders
 * nothing at all when neither applies, leaving no empty block behind.
 */
function fulfillmentNotes(dto: CustomerDocumentDTO): string {
  const statements = [
    dto.includesInstallation ? 'يشمل التركيب' : '',
    dto.includesDelivery ? 'يشمل التوصيل' : ''
  ].filter(Boolean)
  if (!statements.length) return ''
  return `<div class="fulfillment">${statements
    .map((text) => `<span class="fulfillment-item">${esc(text)}</span>`)
    .join('')}</div>`
}

/** Free-text document notes, printed only when the DTO carries them. */
function notesBlock(dto: CustomerDocumentDTO): string {
  if (!dto.notes) return ''
  return `<div class="doc-notes"><div class="doc-notes-label">ملاحظات</div><div>${esc(dto.notes)}</div></div>`
}

const CONTACT_ICON = {
  phone: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.69 2.8a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.33 1.85.56 2.81.69A2 2 0 0 1 22 16.92z"/></svg>`,
  location: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 10c0 7-9 12-9 12S3 17 3 10a9 9 0 1 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`,
  facebook: `<svg viewBox="0 0 24 24" aria-hidden="true"><path class="icon-fill" d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047V9.414c0-3.025 1.792-4.697 4.533-4.697 1.312 0 2.686.236 2.686.236v2.974h-1.513c-1.49 0-1.956.931-1.956 1.887v2.259h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073z"/></svg>`
} as const

/** Shared, customer-facing footer used only by both invoice templates. */
function invoiceContactFooter(): string {
  return `<footer class="invoice-contact-footer">
    <div class="invoice-contact-details">
      <div class="invoice-contact-row">${CONTACT_ICON.phone}<bdi dir="ltr">091 1717111</bdi></div>
      <div class="invoice-contact-row">${CONTACT_ICON.phone}<bdi dir="ltr">092 1217111</bdi></div>
      <div class="invoice-contact-row invoice-contact-address">${CONTACT_ICON.location}<span>طريق الجديدة بالقرب من مركز اللافي</span></div>
      <div class="invoice-contact-row">${CONTACT_ICON.facebook}<bdi dir="ltr">AURA HOME</bdi></div>
    </div>
    <figure class="invoice-location-qr">
      <img src="app://assets/references/qr.jpeg" alt="رمز موقع AURA HOME" />
      <figcaption>امسح لعرض موقعنا</figcaption>
    </figure>
  </footer>`
}

/**
 * The CHARGE rows between the goods subtotal and the final amount.
 *
 * Only genuinely additive amounts belong here, so that the column reads
 * as the arithmetic it is: products + installation + delivery = final.
 * (سعر المتر is deliberately NOT one of them — see `meterPriceNote`.)
 *
 * Each row is omitted entirely when its value is absent — either
 * because it is zero or because the document hides it — so a hidden
 * charge collapses cleanly instead of leaving a blank line. The final
 * total printed underneath is always the document's real stored total,
 * which already includes every charge exactly once whether or not its
 * row is shown.
 */
function chargeRows(dto: CustomerDocumentDTO): string {
  return [
    dto.installationPrice
      ? `<tr><td>سعر التركيب</td><td class="num">${esc(dto.installationPrice)}</td></tr>`
      : '',
    dto.deliveryPrice
      ? `<tr><td>سعر التوصيل</td><td class="num">${esc(dto.deliveryPrice)}</td></tr>`
      : ''
  ].join('')
}

/**
 * The quoted per-metre rate, shown OUTSIDE the totals column.
 *
 * It is commercial information, not a charge: nothing in this document
 * model derives a line price from it and it is not part of any total.
 * Printing it inside the additive stack would invite the reader to add
 * it up with the rest and arrive at a figure the invoice never charged,
 * so it sits on its own line above the totals instead.
 */
function meterPriceNote(dto: CustomerDocumentDTO): string {
  if (!dto.meterPrice) return ''
  return `<div class="rate-note"><span class="rate-note-label">سعر المتر</span><span class="rate-note-value">${esc(dto.meterPrice)}</span></div>`
}

/**
 * Every document is rendered by Chromium with the bundled Cairo fonts
 * loaded over app://assets — the same engine and the same typography
 * as the UI, so Arabic shaping, bidi and RTL are identical on screen
 * and on paper (Step 2 §9/§10).
 */
function shell(title: string, body: string): string {
  return `<!doctype html>
<html dir="rtl" lang="ar">
<head>
<meta charset="utf-8" />
<title>${esc(title)}</title>
<link rel="stylesheet" href="app://assets/fonts/fonts.css" />
<style>${DOCUMENT_STYLES}</style>
</head>
<body>${body}</body>
</html>`
}

function header(company: CompanyInfo, title: string, number: string, date: string, internal = false): string {
  return `
  <div class="doc-header">
    <div class="brand">
      <img src="app://assets/brand/logo-full.jpeg" alt="AURA home" />
      <div>
        <div class="brand-name">${esc(company.name)}</div>
        ${company.phone ? `<div class="brand-meta">هاتف: ${esc(company.phone)}</div>` : ''}
        ${company.address ? `<div class="brand-meta">${esc(company.address)}</div>` : ''}
      </div>
    </div>
    <div class="doc-title">
      <h1>${esc(title)}</h1>
      <div class="num">${esc(number)}</div>
      <div class="date">${esc(date)}</div>
      ${internal ? '<div class="internal-badge">مستند داخلي</div>' : ''}
    </div>
  </div>`
}

/** BR-71–BR-74: Preliminary Invoice / Quotation. */
export function renderPreliminaryInvoice(dto: CustomerDocumentDTO, company: CompanyInfo): string {
  return shell(
    `فاتورة مبدئية ${dto.documentNumber}`,
    `
  ${header(company, 'فاتورة مبدئية', dto.documentNumber, dto.issuedAt)}
  <div class="party">
    <div class="row">
      <div><div class="label">العميل</div><div class="value">${esc(dto.customer.name)}</div></div>
      ${dto.customer.phone ? `<div><div class="label">الهاتف</div><div class="value">${esc(dto.customer.phone)}</div></div>` : ''}
      ${dto.customer.address ? `<div><div class="label">العنوان</div><div class="value">${esc(dto.customer.address)}</div></div>` : ''}
      ${dto.validUntil ? `<div><div class="label">صالح حتى</div><div class="value">${esc(dto.validUntil)}</div></div>` : ''}
    </div>
  </div>
  <table>
    <thead><tr>${itemsTableHead(dto)}</tr></thead>
    <tbody>
      ${dto.lines
        .map(
          (line, index) => `<tr>${itemRowCells(dto, line, index)}</tr>${specRow(dto, [
            line.specifications ? `<div class="spec">${esc(line.specifications)}</div>` : '',
            materialColorRows(line),
            line.dimensions ? `<div class="spec">الأبعاد: ${esc(line.dimensions)}</div>` : '',
            line.accessories ? `<div class="spec">الإكسسوارات: ${esc(line.accessories)}</div>` : ''
          ])}`
        )
        .join('')}
    </tbody>
  </table>
  <table class="totals">
    ${dto.subtotal ? `<tr><td>إجمالي المنتجات</td><td class="num">${esc(dto.subtotal)}</td></tr>` : ''}
    ${chargeRows(dto)}
    ${dto.discount ? `<tr><td>الخصم</td><td class="num">${esc(dto.discount)}</td></tr>` : ''}
    <tr class="grand"><td>الإجمالي النهائي</td><td class="num">${esc(dto.totalAfterDiscount)}</td></tr>
    ${dto.depositRequired ? `<tr class="deposit"><td>الدفعة المقدمة المطلوبة</td><td class="num">${esc(dto.depositRequired)}</td></tr>` : ''}
    ${dto.remainingBalance ? `<tr><td>المبلغ المتبقي</td><td class="num">${esc(dto.remainingBalance)}</td></tr>` : ''}
  </table>
  ${meterPriceNote(dto)}
  ${fulfillmentNotes(dto)}
  ${notesBlock(dto)}
  ${
    dto.termsAndConditions?.length
      ? `<div class="terms"><h3>الشروط والأحكام</h3><ol>${dto.termsAndConditions
          .map((term) => `<li>${esc(term)}</li>`)
          .join('')}</ol></div>`
      : ''
  }
  <div class="sign invoice-sign"><div>توقيع العميل</div><div>عن الشركة</div></div>
  ${invoiceContactFooter()}`
  )
}

/** BR-63: Final Invoice. */
export function renderFinalInvoice(dto: CustomerDocumentDTO, company: CompanyInfo): string {
  return shell(
    `فاتورة معتمدة ${dto.documentNumber}`,
    `
  ${header(company, 'فاتورة معتمدة', dto.documentNumber, dto.issuedAt)}
  <div class="party">
    <div class="row">
      <div><div class="label">العميل</div><div class="value">${esc(dto.customer.name)}</div></div>
      ${dto.customer.phone ? `<div><div class="label">الهاتف</div><div class="value">${esc(dto.customer.phone)}</div></div>` : ''}
      ${dto.customer.address ? `<div><div class="label">العنوان</div><div class="value">${esc(dto.customer.address)}</div></div>` : ''}
    </div>
  </div>
  <table>
    <thead><tr>${itemsTableHead(dto)}</tr></thead>
    <tbody>
      ${dto.lines
        .map(
          (line, index) => `<tr>${itemRowCells(dto, line, index)}</tr>${specRow(dto, [
            line.specifications ? `<div class="spec">${esc(line.specifications)}</div>` : '',
            materialColorRows(line),
            line.dimensions ? `<div class="spec">الأبعاد: ${esc(line.dimensions)}</div>` : '',
            line.accessories ? `<div class="spec">الإكسسوارات: ${esc(line.accessories)}</div>` : ''
          ])}`
        )
        .join('')}
    </tbody>
  </table>
  <table class="totals">
    ${dto.subtotal ? `<tr><td>إجمالي المنتجات</td><td class="num">${esc(dto.subtotal)}</td></tr>` : ''}
    ${chargeRows(dto)}
    ${dto.discount ? `<tr><td>الخصم</td><td class="num">${esc(dto.discount)}</td></tr>` : ''}
    <tr class="grand"><td>الإجمالي النهائي</td><td class="num">${esc(dto.totalAfterDiscount)}</td></tr>
    <tr><td>المدفوع</td><td class="num">${esc(dto.depositRequired ?? '')}</td></tr>
    ${dto.remainingBalance ? `<tr><td>المتبقي</td><td class="num">${esc(dto.remainingBalance)}</td></tr>` : ''}
  </table>
  ${meterPriceNote(dto)}
  ${fulfillmentNotes(dto)}
  ${notesBlock(dto)}
  ${
    dto.termsAndConditions?.length
      ? `<div class="terms"><h3>البنود والشروط</h3><ol>${dto.termsAndConditions
          .map((term) => `<li>${esc(term)}</li>`)
          .join('')}</ol></div>`
      : ''
  }
  <div class="sign invoice-sign"><div>توقيع العميل</div><div>عن الشركة</div></div>
  ${invoiceContactFooter()}`
  )
}

/**
 * The factory instruction document ("أمر تصنيع").
 *
 * Item 13/14: what to build and which materials to use — and not one
 * monetary figure. The DTO it renders has no cost field to print.
 */
export function renderWorkSheet(dto: InternalWorkSheetDTO, company: CompanyInfo): string {
  const statusLabel: Record<string, string> = {
    draft: 'مسودة',
    ready: 'جاهز للتصنيع',
    in_production: 'قيد التصنيع',
    completed: 'مكتمل',
    cancelled: 'ملغى',
    reversed: 'تم التراجع — مستند تاريخي غير فعّال'
  }
  return shell(
    `أمر تصنيع ${dto.documentNumber}`,
    `
  ${header(company, 'أمر تصنيع داخلي', dto.documentNumber, dto.issuedAt, true)}
  <div class="party">
    <div class="row">
      <div><div class="label">رقم الطلب</div><div class="value">${esc(dto.orderNumber)}</div></div>
      <div><div class="label">العميل / المرجع</div><div class="value">${esc(dto.customerReference)}</div></div>
      <div><div class="label">الحالة</div><div class="value">${esc(statusLabel[dto.status] ?? dto.status)}</div></div>
      <div><div class="label">الفني المسؤول</div><div class="value">${esc(dto.assignedWorkers.join('، ') || '—')}</div></div>
      ${dto.fulfillmentRequirement ? `<div><div class="label">التسليم / التركيب</div><div class="value">${esc(dto.fulfillmentRequirement)}</div></div>` : ''}
    </div>
  </div>

  <h2 style="margin:14px 0 6px">المطلوب تصنيعه</h2>
  <table>
    <thead><tr>
      <th style="width:32px">#</th><th>المنتج / البند</th>
      <th class="num" style="width:70px">الكمية</th>
      <th style="width:130px">الأبعاد</th>
      <th style="width:120px">النوع / اللون</th>
      <th>المواصفات والإكسسوارات</th>
    </tr></thead>
    <tbody>
      ${dto.items
        .map(
          (item, index) => `<tr>
        <td class="num">${index + 1}</td>
        <td>${esc(item.product)}</td>
        <td class="num">${esc(item.quantity)}</td>
        <td>${esc(item.dimensions ?? '—')}</td>
        <td>${esc(item.materialType ?? '—')}${item.colorCode ? `<div class="spec">كود اللون: ${esc(item.colorCode)}</div>` : ''}</td>
        <td>${item.specifications ? `<div class="spec">${esc(item.specifications)}</div>` : ''}
            ${(item.accessories ?? []).map((acc) => `<div class="spec">إكسسوار: ${esc(acc)}</div>`).join('') || (item.specifications ? '' : '—')}</td>
      </tr>`
        )
        .join('')}
    </tbody>
  </table>

  <h2 style="margin:16px 0 6px">المواد المطلوبة للتصنيع</h2>
  <table>
    <thead><tr>
      <th style="width:32px">#</th><th>المادة</th>
      <th class="num" style="width:80px">الكمية</th>
      <th style="width:70px">الوحدة</th>
      <th style="width:120px">الأبعاد / المقاس</th>
      <th style="width:80px">السماكة</th>
      <th style="width:110px">اللون / التشطيب</th>
      <th>ملاحظات</th>
    </tr></thead>
    <tbody>
      ${
        dto.requiredMaterials.length
          ? dto.requiredMaterials
              .map(
                (line, index) => `<tr>
        <td class="num">${index + 1}</td>
        <td>${esc(line.material)}</td>
        <td class="num">${esc(line.quantity)}</td>
        <td>${esc(line.unit ?? '—')}</td>
        <td>${esc(line.dimensions ?? '—')}</td>
        <td>${esc(line.thickness ?? '—')}</td>
        <td>${esc(line.colorCode ?? '—')}</td>
        <td>${esc(line.notes ?? '—')}</td>
      </tr>`
              )
              .join('')
          : '<tr><td colspan="8">لم تُحدَّد مواد للتصنيع بعد</td></tr>'
      }
    </tbody>
  </table>

  ${
    // The planned machines/processes the job is expected to need. The
    // section is omitted entirely when the plan names none, rather than
    // printing an empty table on a factory sheet.
    dto.requiredMachines.length
      ? `<h2 style="margin:16px 0 6px">الآلات المطلوبة للتصنيع</h2>
  <table>
    <thead><tr>
      <th style="width:32px">#</th><th>الآلة / العملية</th>
      <th style="width:140px">الاستخدام المتوقع</th>
      <th>ملاحظات</th>
    </tr></thead>
    <tbody>
      ${dto.requiredMachines
        .map(
          (line, index) => `<tr>
        <td class="num">${index + 1}</td>
        <td>${esc(line.machine)}</td>
        <td>${esc(line.usage ?? '—')}</td>
        <td>${esc(line.notes ?? '—')}</td>
      </tr>`
        )
        .join('')}
    </tbody>
  </table>`
      : ''
  }

  ${dto.manufacturingNotes ? `<div class="party"><div class="label">ملاحظات التصنيع</div><div>${esc(dto.manufacturingNotes)}</div></div>` : ''}
  <div class="sign"><div>مسؤول الإنتاج</div><div>المستلم</div></div>`
  )
}

/** BR-83/BR-112: the four Exit Permit document semantics. */
export function renderRelease(dto: InternalReleaseDTO, company: CompanyInfo): string {
  const includesInstallation = permitIncludesInstallation(dto.kind)
  const title = EXIT_PERMIT_LABEL[dto.kind]
  const notice = dto.kind === 'installation'
    ? 'تم سداد كامل قيمة الطلب. يُسمح بخروج الطلب من المصنع والتوجه لموقع التركيب.'
    : dto.kind === 'delivery_installation'
      ? 'تم سداد كامل قيمة الطلب. يُسمح بتوصيل الطلب والتوجه لموقع التركيب.'
      : dto.kind === 'transport'
        ? 'تم سداد كامل قيمة الطلب. يُسمح بتوصيل الطلب للعميل.'
        : 'تم سداد كامل قيمة الطلب. يُسمح بتسليم الطلب للعميل.'
  const showPaidNotice = dto.balanceConfirmedPaid && (!includesInstallation || dto.showPaidExitSentence)
  const unpaidOverrideNotice = dto.authorizationType === 'unpaid_override'
    ? `<div class="notice notice--warning">
        <div>تم التصريح بخروج الطلب بموافقة إدارية مع وجود رصيد متبقٍ قدره ${esc(dto.remainingAtIssue ?? '—')}.</div>
      </div>`
    : ''
  const paymentStatus = dto.balanceConfirmedPaid
    ? 'مسدد بالكامل'
    : `غير مسدد بالكامل${dto.remainingAtIssue ? ` — المتبقي ${dto.remainingAtIssue}` : ''}`
  return shell(
    `${title} ${dto.documentNumber}`,
    `
  ${header(company, title, dto.documentNumber, dto.authorizedAt, true)}
  ${dto.reversed ? '<div class="notice">تم التراجع عن إذن الخروج — مستند تاريخي غير فعّال</div>' : ''}
  ${showPaidNotice ? `<div class="notice">${esc(notice)}</div>` : ''}
  ${unpaidOverrideNotice}
  <div class="party">
    <div class="row">
      <div><div class="label">رقم الطلب</div><div class="value">${esc(dto.orderNumber)}</div></div>
      <div><div class="label">العميل</div><div class="value">${esc(dto.customerName)}</div></div>
      ${dto.address ? `<div><div class="label">${includesInstallation ? 'موقع التركيب' : dto.kind === 'transport' ? 'عنوان التوصيل' : 'عنوان التسليم'}</div><div class="value">${esc(dto.address)}</div></div>` : ''}
      <div><div class="label">${includesInstallation ? 'فريق التركيب/التوصيل' : 'المكلف بالتنفيذ'}</div><div class="value">${esc(dto.assignedWorkers.join('، ') || '—')}</div></div>
      <div><div class="label">حالة السداد</div><div class="value">${esc(paymentStatus)}</div></div>
    </div>
  </div>
  <table>
    <thead><tr><th style="width:32px">#</th><th>الأصناف</th></tr></thead>
    <tbody>${dto.items.map((item, index) => `<tr><td class="num">${index + 1}</td><td>${esc(item)}</td></tr>`).join('')}</tbody>
  </table>
  ${dto.notes ? `<div class="party"><div class="label">ملاحظات</div><div>${esc(dto.notes)}</div></div>` : ''}
  <div class="sign"><div>${includesInstallation ? 'مسؤول المصنع' : 'المسلِّم'}</div><div>المستلم</div></div>`
  )
}

/** BR-25/BR-100: generic operational report layout. */
export function renderReport(
  dto: ReportDTO<Record<string, string>>,
  company: CompanyInfo
): string {
  return shell(
    dto.title,
    `
  ${header(company, dto.title, '', dto.period ? `${dto.period.from} — ${dto.period.to}` : '', true)}
  <table>
    <thead><tr>${dto.columns.map((column) => `<th>${esc(column)}</th>`).join('')}</tr></thead>
    <tbody>
      ${dto.rows
        .map(
          (row) =>
            `<tr>${dto.columns.map((column) => `<td>${esc(row[column] ?? '')}</td>`).join('')}</tr>`
        )
        .join('')}
    </tbody>
  </table>
  ${
    dto.totals
      ? `<table class="totals">${Object.entries(dto.totals)
          .map(([key, value]) => `<tr><td>${esc(key)}</td><td class="num">${esc(value)}</td></tr>`)
          .join('')}</table>`
      : ''
  }`
  )
}
