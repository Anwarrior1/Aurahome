import type { ReactElement, ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: (initial: unknown) => [initial, vi.fn()], useEffect: vi.fn(), useRef: (current: unknown) => ({ current }) }))
vi.mock('react-router-dom', async original => ({ ...await original<typeof import('react-router-dom')>(), useLocation: () => ({ pathname: '/' }) }))
vi.mock('@renderer/state/session.store', () => ({ useSession: () => ({ session: { user: { fullName: 'Fictional owner', roleName: 'Owner' } }, can: () => true, logout: vi.fn(), login: vi.fn(), needsSetup: false }) }))
vi.mock('@renderer/theme/ThemeProvider', () => ({ useTheme: () => ({ theme: 'light', toggle: vi.fn() }) }))
vi.mock('@renderer/state/selected-date.store', () => ({ useSelectedDate: () => ({ selectedDateIso: '2026-10-09', setSelectedDateIso: vi.fn(), goPreviousDay: vi.fn(), goNextDay: vi.fn(), goToday: vi.fn(), isToday: true }) }))
import { LoginPage } from '@renderer/pages/login/LoginPage'
import { AppLayout } from '@renderer/layouts/AppLayout'
function nodes(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(nodes)
  if (!node || typeof node !== 'object' || !('props' in node)) return []
  const element = node as ReactElement<Record<string, unknown>>
  return [element, ...nodes(element.props.children as ReactNode)]
}
const logo = (page: () => ReactElement): string => String(nodes(page()).find(n => n.type === 'img' && n.props.alt === 'AURA home')!.props.src)
const resource = 'brand/logo-full.jpeg'
describe('E2E-02 actual component branding resource resolution', () => {
  it.each([['login', LoginPage], ['sidebar', AppLayout]] as const)('%s resolves to the bundled image under file://, independent of install location', (_name, component) => {
    for (const directory of [resolve('out/renderer'), '/Applications/Fictional ERP with spaces/renderer']) {
      const url = new URL(logo(component), pathToFileURL(directory + '/index.html').href + '#/login')
      expect(url.href).toBe(pathToFileURL(directory + '/' + resource).href)
      expect(url.href).not.toBe('file:///brand/logo-full.jpeg')
    }
  })
  it.each([['login', LoginPage], ['sidebar', AppLayout]] as const)('%s resolves to the same public image on the development server', (_name, component) => {
    expect(new URL(logo(component), 'http://localhost:5173/#/login').href).toBe('http://localhost:5173/' + resource)
  })
  it('both components use the same offline resource with no remote fallback', () => {
    expect(logo(LoginPage)).toBe(logo(AppLayout))
    expect(logo(LoginPage)).not.toMatch(/^(?:https?:|\/\/|file:)/)
    expect(logo(LoginPage)).not.toMatch(/^\//)
  })
  it('the case-exact copied artwork exists and is byte-identical in the renderer output', () => {
    const source = resolve('resources/assets', resource)
    const built = resolve('out/renderer', resource)
    expect(existsSync(source)).toBe(true); expect(existsSync(built)).toBe(true)
    const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
    expect(hash(built)).toBe(hash(source))
    expect(readFileSync(source).subarray(0, 3)).toEqual(Buffer.from([255, 216, 255]))
  })
  it('compiled entry retains local scripts and the restrictive source CSP', () => {
    const built = readFileSync('out/renderer/index.html', 'utf8')
    const source = readFileSync('src/renderer/index.html', 'utf8')
    const csp = (html: string) => html.match(/content="(default-src[^"]+)"/)![1]
    expect(csp(built)).toBe(csp(source)); expect(csp(built)).toContain("connect-src 'none'")
    expect(csp(built)).toContain("img-src 'self' app: data:")
    expect(built).toMatch(/src="\.\/assets\//)
  })
})
