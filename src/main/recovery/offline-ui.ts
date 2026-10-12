/** Standalone, non-operational Arabic journey preview. No file or database writes. */
export type RecoveryPreviewScreen =
  | 'start' | 'select' | 'inspect' | 'validation' | 'risk' | 'decision'
  | 'preservation' | 'activation-pending' | 'financial-review' | 'completion'

export interface RecoveryPreviewContext {
  archiveSha256: string
  unverifiedDate: string
  validationPassed: boolean
}

const STEPS: readonly RecoveryPreviewScreen[] = [
  'start', 'select', 'inspect', 'validation', 'risk', 'decision', 'preservation',
  'activation-pending', 'financial-review', 'completion'
]

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]!)
}

export function renderArabicRecoveryPreview(screen: RecoveryPreviewScreen, context: RecoveryPreviewContext): string {
  if (!STEPS.includes(screen)) throw new Error('Unknown recovery preview screen')
  if (!context.validationPassed && ['decision', 'preservation', 'activation-pending', 'financial-review', 'completion'].includes(screen)) {
    throw new Error('Failed validation cannot advance to recovery approval')
  }
  const hash = escapeHtml(context.archiveSha256)
  const date = escapeHtml(context.unverifiedDate)
  const content: Record<RecoveryPreviewScreen, string> = {
    start: '<h1>استعادة أورا عند تعطل قاعدة البيانات</h1><p>أغلق برنامج أورا قبل المتابعة. لن نحذف قاعدة البيانات التالفة.</p>',
    select: '<h1>اختيار نسخة احتياطية</h1><p>اختر ملف AURABAK1 واحدًا أنشأته يدويًا.</p><input type="file" accept=".aurabak" aria-label="اختيار نسخة احتياطية تجريبية"><p>اختيار الملف هنا للعرض فقط؛ لا يبدأ فحصًا أو استعادة.</p>',
    inspect: '<h1>جارٍ فحص النسخة الاحتياطية...</h1><p>يجب فحص بنية الأرشيف وقاعدة البيانات والحسابات قبل أي قرار.</p><progress aria-label="تقدم تجريبي" max="100" value="40"></progress>',
    validation: `<h1>نتيجة الفحص</h1><p>${context.validationPassed ? 'نتيجة تجريبية: اجتازت النسخة الخيالية الفحوص المحددة.' : 'فشل الفحص؛ لا يمكن الموافقة على الاستعادة.'}</p><p>نجاح الفحص لا يثبت مصدر النسخة.</p>`,
    risk: `<h1>مصدر النسخة غير مؤكّد</h1><strong lang="en" dir="ltr">UNKNOWN ORIGIN</strong><p>هذه النسخة غير موقّعة، ولا يمكن إثبات مصدرها بصورة مؤكدة.</p><p>تاريخ النسخة كما ورد داخلها (غير موثّق): <bdi>${date}</bdi></p><p>قد تضيع العمليات الأحدث من هذه النسخة، ولا يمكن تقدير عددها بدقة.</p><p>بصمة الملف المحدد: <bdi dir="ltr">${hash}</bdi></p>`,
    decision: `<h1>قرار استثنائي لهذه النسخة فقط</h1><p>بصمة الملف المحدد: <bdi dir="ltr">${hash}</bdi></p><label>كيف وصلت إليك النسخة؟ <textarea disabled aria-label="شرح المصدر والحفظ"></textarea></label><label><input type="checkbox" disabled> أفهم أن مصدر النسخة غير مؤكّد</label><label><input type="checkbox" disabled> أقبل احتمال فقد العمليات الأحدث</label><p>قرار المالك الحقيقي يتطلب سجلًا محميًا وتحقّقًا من هوية مسؤول Windows؛ هذه معاينة فقط.</p>`,
    preservation: '<h1>حفظ قاعدة البيانات الأصلية</h1><p>يجب حفظ erp.db وأي ملفات WAL وSHM موجودة كما هي، ثم مقارنة الأحجام والبصمات. عند فشل الحفظ تتوقف العملية.</p><p>لم تُنسخ أي قاعدة بيانات حقيقية في هذه المعاينة.</p>',
    'activation-pending': '<h1>التنشيط مؤجل</h1><p>لا يوجد زر لاستبدال قاعدة البيانات. تنشيط الاستعادة يحتاج اختبارات Windows x64 الأصلية قبل إتاحته.</p>',
    'financial-review': '<h1>مراجعة الأرصدة قبل متابعة العمل</h1><p>يجب التحقق من سلامة SQLite والعلاقات والترحيلات و73 مطابقة مالية، ثم مقارنة الأرصدة بسجلات مستقلة.</p><ul><li>النقد وأرصدة العملاء</li><li>مستحقات العمال وديونهم</li><li>المخزون وتكلفة FIFO</li><li>الفواتير والحركات الأخيرة</li></ul><p>اعتماد المالك هنا معاينة غير مفعّلة ولا يرفع إيقاف أورا.</p>',
    completion: '<h1>اكتمال المسار التجريبي</h1><p>لم تُستعد أي قاعدة بيانات. لا يمكن إعلان النجاح أو فتح أورا للعمل بناءً على هذه المعاينة.</p>'
  }
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>استعادة أورا — معاينة</title><style>
    body{margin:0;background:#f3f5f6;color:#182f38;font:18px/1.7 system-ui,sans-serif}main{max-width:740px;margin:4rem auto;background:white;padding:2rem;border-radius:16px;box-shadow:0 8px 30px #142d3b16}h1{font-size:1.8rem;line-height:1.35}p{margin:.8rem 0}label{display:block;margin:1rem 0}textarea{display:block;width:100%;min-height:5rem}button,input,textarea{font:inherit}button{padding:.7rem 1rem;border-radius:8px}button[disabled]{background:#e7ebed;color:#40515a;border:1px solid #9eafb7;cursor:not-allowed}.banner{background:#783519;color:white;padding:.8rem 1rem;border-radius:8px}bdi{overflow-wrap:anywhere}strong[lang=en]{color:#9d241a}footer{margin-top:2rem;border-top:1px solid #d5dfe2;padding-top:1rem;font-size:.9rem}
  </style></head><body><main><p class="banner" role="status">عرض تجريبي فقط — لا توجد أداة استعادة عاملة بعد. Windows x64 غير مختبر.</p>${content[screen]}<footer><p>النسخ الاحتياطية العادية تبقى يدوية دون تغيير. لا تنشيط ولا رجوع ولا رفع لإيقاف التشغيل في هذه المعاينة.</p><button type="button" disabled>الاستعادة غير متاحة</button></footer></main></body></html>`
}
