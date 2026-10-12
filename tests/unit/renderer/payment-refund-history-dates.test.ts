import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'
import React from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {describe, expect, it} from 'vitest'
import {fmtDate, fmtDateTime, fmtMoney} from '@renderer/lib/format'

const source=readFileSync('src/renderer/components/ui/index.tsx','utf8')
const module={exports:{}} as {exports:{DataTable:React.ComponentType<Record<string,unknown>>}}
runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,
  {module,exports:module.exports,require:createRequire(import.meta.url)})

describe('Contract C actual history table representations',()=>{
  it.each(['orders/OrderDetailPage','customers/CustomersPage'])('%s separates the authoritative factory day from execution time',page=>{
    const file=ts.createSourceFile('page.tsx',readFileSync(`src/renderer/pages/${page}.tsx`,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
    let columns: string|undefined
    function visit(node: ts.Node) {
      if(ts.isJsxAttribute(node)&&node.name.getText(file)==='columns'&&node.initializer&&ts.isJsxExpression(node.initializer)) {
        const text=node.initializer.expression?.getText(file)
        if(text?.includes('row.effectiveBusinessDay'))columns=text
      }
      ts.forEachChild(node,visit)
    }
    visit(file);expect(columns).toBeDefined()
    const view=runInNewContext(ts.transpileModule(`(${columns})`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{fmtDate,fmtDateTime,fmtMoney})
    const rows=[
      {rowKey:'refund-1',entryType:'refund',amountMinor:-2000000,effectiveBusinessDay:'2026-10-01',paidAt:'2026-09-30T22:10:00Z',executionAt:'2026-09-30T22:10:00.000Z',notes:null},
      {rowKey:'payment-1',entryType:'payment',amountMinor:5400000,effectiveBusinessDay:'2026-10-01',paidAt:'2026-10-01',executionAt:'2026-09-30T22:05:00.000Z',notes:null}
    ]
    const html=renderToStaticMarkup(React.createElement(module.exports.DataTable,{columns:view,rows,rowKey:(r:{rowKey:string})=>r.rowKey}))
    expect(html).toContain('اليوم الفعلي');expect(html).toContain('وقت التسجيل (UTC)')
    expect(html.split(fmtDate('2026-10-01')).length-1).toBe(2)
    expect(html).toContain(fmtDateTime(rows[0]!.executionAt));expect(html).toContain(fmtDateTime(rows[1]!.executionAt))
    expect(html.indexOf('استرداد دفعة')).toBeLessThan(html.indexOf('دفعة عميل'))
    expect(html).not.toContain('2026-09-30T22:10:00Z')
  })
})
