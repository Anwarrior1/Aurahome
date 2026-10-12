import { useState, type ReactElement } from 'react'
import { Layers, Tag } from 'lucide-react'
import { useQuery } from '@renderer/lib/useQuery'
import { Card, DataTable, Field, Input, PageHeader, Stat, Toolbar } from '@renderer/components/ui'
import { fmtMoney, fmtQty } from '@renderer/lib/format'

interface Row {
  materialId: number; sku: string; name: string; categoryName: string; unit: string
  qtyMicro: number; fifoValueMinor: number; marketValueMinor: number
}
interface Valuation {
  materials: Row[]
  byCategory: Array<{ categoryId: number; categoryName: string; fifoValueMinor: number; marketValueMinor: number }>
  totals: { fifoValueMinor: number; marketValueMinor: number }
}

export function ValuationPage(): ReactElement {
  const [search, setSearch] = useState('')
  const query = useQuery<Valuation>('inventory', 'valuation', { search })
  const data = query.data

  return (
    <>
      <PageHeader
        title="تقييم رأس مال المخزون"
        subtitle="قيمتان منفصلتان دائماً: التكلفة الفعلية حسب الأقدم فالأحدث، والقيمة السوقية الحالية"
      />
      <div className="grid grid--2" style={{ marginBottom: 16 }}>
        <Stat label="إجمالي التكلفة الفعلية" value={fmtMoney(data?.totals.fifoValueMinor ?? 0)} tone="brand"
          hint="رأس المال المرتبط فعلياً في المخزون بأسعار الشراء" icon={<Layers size={20} strokeWidth={2.25} />} />
        <Stat label="إجمالي القيمة السوقية الحالية" value={fmtMoney(data?.totals.marketValueMinor ?? 0)}
          hint="بأسعار السوق الحالية — لا تُخلط مع التكلفة الفعلية" icon={<Tag size={20} strokeWidth={2.25} />} />
      </div>

      <Card title="حسب التصنيف">
        <DataTable
          rows={data?.byCategory ?? []}
          rowKey={(row) => row.categoryId}
          loading={query.loading}
          columns={[
            { key: 'cat', header: 'التصنيف', render: (row) => row.categoryName },
            { key: 'fifo', header: 'التكلفة الفعلية', numeric: true, render: (row) => fmtMoney(row.fifoValueMinor) },
            { key: 'market', header: 'القيمة السوقية', numeric: true, render: (row) => fmtMoney(row.marketValueMinor) }
          ]}
        />
      </Card>

      <Card title="حسب المادة">
        <Toolbar>
          <Field label="بحث"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="الاسم أو الكود" /></Field>
        </Toolbar>
        <DataTable
          rows={data?.materials ?? []}
          rowKey={(row) => row.materialId}
          loading={query.loading}
          empty="لا توجد مواد"
          columns={[
            { key: 'sku', header: 'الكود', render: (row) => row.sku },
            { key: 'name', header: 'المادة', render: (row) => row.name },
            { key: 'cat', header: 'التصنيف', render: (row) => row.categoryName },
            { key: 'qty', header: 'الكمية', numeric: true, render: (row) => fmtQty(row.qtyMicro, row.unit) },
            { key: 'fifo', header: 'التكلفة الفعلية', numeric: true, render: (row) => fmtMoney(row.fifoValueMinor) },
            { key: 'market', header: 'القيمة السوقية', numeric: true, render: (row) => fmtMoney(row.marketValueMinor) }
          ]}
        />
      </Card>
    </>
  )
}
