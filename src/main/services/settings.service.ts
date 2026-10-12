import { withTransaction } from '../db/transactions'
import { requirePermission } from '../permissions/permission-guard'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDatabase } from '../db/connection'
import { appSettings } from '../db/schema/settings.schema'
import { nowIso, type ServiceContext } from './base/service.types'
import { recordAuditEvent } from '../audit/audit-log.service'
import { AppError, forbidden } from '../utils/errors'
import { basisPointsSchema, safePositiveIntegerSchema } from '@shared/schemas/common.schema'

/**
 * Business-level settings that must be audited and snapshotted, so
 * they live in the database rather than config.json (which holds only
 * non-secret UI/app preferences).
 */
export const SETTING_KEYS = {
  savingsRateBp: 'savings.rate_bp', // BR-98/BR-110 — default 10%
  depositPercentBp: 'orders.deposit_percent_bp', // BR-42 — default 60%
  quotationValidityHours: 'quotations.validity_hours', // BR-44 — 48 hours
  termsAndConditions: 'documents.terms', // BR-74/BR-79
  companyName: 'company.name',
  companyPhone: 'company.phone',
  companyAddress: 'company.address'
} as const

/** BR-74: the eight confirmed clauses, verbatim. Editable in Settings. */
export const DEFAULT_TERMS: string[] = [
  'يسري هذا العرض لمدة 48 ساعة فقط من تاريخ إصدار الفاتورة، ويُعاد تسعيره بعد انتهاء المدة.',
  'يتم دفع 60% من قيمة الفاتورة عند اعتماد العرض.',
  'يتم سداد المبلغ المتبقي عند تحديد موعد التركيب وقبل مباشرة العمل في الموقع.',
  'الأسعار تعتمد على الأبعاد النهائية بعد أخذ القياسات من قبل فريق الشركة.',
  'تُحدد مدة التنفيذ بناءً على حجم المشروع وتوفّر المواد، ويجري الاتفاق عليها بعد استلام الدفعة المقدمة.',
  'تقدم الشركة ضمانًا على جودة التصنيع والتركيب وفق السياسة المعتمدة، ويُستثنى من الضمان سوء الاستخدام أو العوامل الطارئة والخارجة عن الإرادة.',
  'أي تعديلات أو إضافات بعد اعتماد العرض تُحتسب كقيمة إضافية وفق الأسعار المعتمدة.',
  'يجب تجهيز الموقع للتركيب (إزالة العوائق – اكتمال التشطيبات – توفر مصدر كهرباء)، وفي حال عدم جاهزية الموقع يتم تأجيل العمل مع إمكانية احتساب رسوم إضافية.'
]

const DEFAULTS: Record<string, unknown> = {
  [SETTING_KEYS.savingsRateBp]: 1000, // 10.00%
  [SETTING_KEYS.depositPercentBp]: 6000, // 60.00%
  [SETTING_KEYS.quotationValidityHours]: 48,
  [SETTING_KEYS.termsAndConditions]: DEFAULT_TERMS,
  [SETTING_KEYS.companyName]: 'AURA home',
  [SETTING_KEYS.companyPhone]: '',
  [SETTING_KEYS.companyAddress]: ''
}

/**
 * BL-08: the complete, closed list of settings a user may edit through
 * `settings:set`, each with the authoritative domain its consumers
 * already enforce elsewhere. A key that is not here cannot be written,
 * created or cleared through the Settings IPC — including a key owned by
 * another module (`savings.rate_bp` belongs to the Savings module's
 * `profit:setSavingsRate` under `savings.manage`).
 *
 * Every domain below is the one the code already relies on, not a new
 * policy:
 *  • deposit % — `document-totals.ts` requires 0–10000 basis points
 *    before it computes any document total;
 *  • validity hours — `quotations.service` multiplies it into a Date,
 *    so it must be a positive safe integer (no business ceiling exists
 *    in current source, so none is invented here);
 *  • terms — a `string[]` catalog indexed by `final-invoices.service`
 *    and frozen per document;
 *  • company name — the repo-wide convention for an entity name is a
 *    non-empty string; phone and address are optional free text and
 *    default to ''.
 */
const EDITABLE_SETTINGS: Readonly<Record<string, z.ZodType>> = {
  [SETTING_KEYS.depositPercentBp]: basisPointsSchema,
  [SETTING_KEYS.quotationValidityHours]: safePositiveIntegerSchema,
  [SETTING_KEYS.termsAndConditions]: z.array(z.string()),
  [SETTING_KEYS.companyName]: z.string().min(1),
  [SETTING_KEYS.companyPhone]: z.string(),
  [SETTING_KEYS.companyAddress]: z.string()
}

export function getSetting<T>(key: string): T {
  const row = getDatabase().select().from(appSettings).where(eq(appSettings.key, key)).get()
  if (!row) return DEFAULTS[key] as T
  try {
    return JSON.parse(row.value) as T
  } catch {
    return DEFAULTS[key] as T
  }
}

/**
 * The USER-EDITABLE Settings boundary — everything `settings:set`
 * reaches. An unknown, retired or module-owned key is refused, and an
 * allowed key's value must satisfy its own domain (BL-08).
 */
export function setSetting(key: string, value: unknown, ctx?: ServiceContext): void {
  if (!ctx) throw forbidden()
  requirePermission(ctx.session, P.settings.manage)
  if (key.startsWith('backup.')) {
    throw new AppError('VALIDATION_ERROR', 'إعدادات النسخ التلقائي لم تعد مدعومة')
  }
  const schema = EDITABLE_SETTINGS[key]
  if (!schema) {
    throw new AppError('VALIDATION_ERROR', 'هذا الإعداد غير قابل للتعديل من الإعدادات العامة')
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 'قيمة الإعداد غير صحيحة')
  }
  writeSetting(key, parsed.data, ctx)
}

/** Compatibility alias for generic settings; reserved keys remain owner-only. */
export function setSettingInternal(key: string, value: unknown, ctx?: ServiceContext): void {
  setSetting(key, value, ctx)
}

/** BR-98/BR-110: the sole savings-rate owner, re-exported by the Profit service. */
export function setSavingsRateBp(rateBp: number, ctx: ServiceContext): { savingsRateBp: number } {
  requirePermission(ctx.session, P.savings.manage)
  if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > 10000) {
    throw new AppError('VALIDATION_ERROR', 'نسبة الادخار يجب أن تكون بين 0% و100%')
  }
  // Confirmed allocations retain their own rate; this never rewrites history.
  writeSetting(SETTING_KEYS.savingsRateBp, rateBp, ctx)
  return { savingsRateBp: rateBp }
}

function writeSetting(key: string, value: unknown, ctx?: ServiceContext): void {
  return withTransaction(() => {
    const db = getDatabase()
    const encoded = JSON.stringify(value)
    const existing = db.select().from(appSettings).where(eq(appSettings.key, key)).get()
    if (existing) {
      db.update(appSettings)
        .set({ value: encoded, updatedAt: nowIso(), updatedBy: ctx?.session.user.username })
        .where(eq(appSettings.key, key))
        .run()
    } else {
      db.insert(appSettings)
        .values({ key, value: encoded, updatedAt: nowIso(), updatedBy: ctx?.session.user.username })
        .run()
    }
    recordAuditEvent({
      userId: ctx?.session.user.id,
      action: 'settings.update',
      entity: 'app_settings',
      entityId: key,
      details: { value }
    })
  })
}

export function getAllSettings(): Record<string, unknown> {
  const out: Record<string, unknown> = { ...DEFAULTS }
  for (const row of getDatabase().select().from(appSettings).all()) {
    if (row.key.startsWith('backup.')) continue
    try {
      out[row.key] = JSON.parse(row.value)
    } catch {
      /* keep the default when a row is unreadable */
    }
  }
  return out
}

export function getTerms(): string[] {
  return getSetting<string[]>(SETTING_KEYS.termsAndConditions)
}

export function getDefaultDepositPercentBp(): number {
  return getSetting<number>(SETTING_KEYS.depositPercentBp)
}

export function getSavingsRateBp(): number {
  return getSetting<number>(SETTING_KEYS.savingsRateBp)
}
