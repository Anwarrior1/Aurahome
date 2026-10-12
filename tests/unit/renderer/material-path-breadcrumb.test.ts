import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const page = readFileSync('src/renderer/pages/materials/MaterialsPage.tsx', 'utf8')
const styles = readFileSync('src/renderer/styles/global.css', 'utf8')

describe('Raw Materials path breadcrumb presentation', () => {
  it('uses the existing path value and only changes its visual separators', () => {
    expect(page).toContain("path?.split(' ← ')")
    expect(page).toContain("segments.join(' › ')")
    expect(page).toContain('<MaterialPathBreadcrumb path={row.hierarchyPath} />')
  })

  it('keeps root-to-current order stable for mixed Arabic and Latin names', () => {
    expect(page).toContain('className="material-path-breadcrumb"')
    expect(page).toContain('dir="ltr"')
    expect(page).toContain('<bdi')
    expect(page).toContain('dir="auto"')
    expect(styles).toContain('unicode-bidi: isolate')
  })

  it('stays on one line, truncates, and exposes a tooltip only when truncated', () => {
    expect(styles).toContain('white-space: nowrap')
    expect(styles).toContain('text-overflow: ellipsis')
    expect(page).toContain('container.scrollWidth > container.clientWidth')
    expect(page).toContain('title={truncated ? displayPath : undefined}')
  })

  it('uses AURA theme tokens for the parent, current, and separator hierarchy', () => {
    expect(styles).toContain('color: var(--text-secondary)')
    expect(styles).toContain('color: var(--text-primary)')
    expect(styles).toContain('color: var(--text-muted)')
  })
})
