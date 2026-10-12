import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { Select } from '@renderer/components/ui'
import { RATE_OPTIONS, isSavingsRateBp, parseSavingsRateDraft, savingsRateOptions, savingsRateLabel } from '@renderer/pages/savings/savings-rate'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { uiWf08Fixture } from '../helpers/ui-wf08-savings'
import { uiWf07Snapshot } from '../helpers/ui-wf07-production'
import { getRawConnection } from '@main/db/connection'
import { getSavingsRateBp, setSavingsRateBp, setSetting } from '@main/services/settings.service'
import { savingsOverview, monthlyProfitSummary } from '@main/services/finance/profit.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { IPC_CHANNELS } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'
import type { ServiceContext } from '@main/services/base/service.types'
const shell = vi.hoisted(() => ({ data: undefined as unknown, loading: false }))
vi.mock('@renderer/state/session.store', () => ({ useSession: () => ({ can: () => true }) }))
vi.mock('@renderer/state/selected-date.store', () => ({ useSelectedDate: () => ({ selectedDateIso: '2026-10-08' }) }))
vi.mock('@renderer/lib/useQuery', () => ({ useQuery: (_group: string, method: string) => ({ data: method === 'savingsOverview' ? shell.data : undefined, loading: shell.loading, reload: async () => undefined }) }))
vi.mock('@renderer/lib/toast', () => ({ useToast: () => ({ show: () => undefined }) }))
import { SavingsPage } from '@renderer/pages/savings/SavingsPage'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())
function actor(manage: boolean): ServiceContext {
  const roleId = createRole({ name: 'UIWF08 actor', permissions: ['savings.view', ...(manage ? ['savings.manage'] : [])] }, env.ctx)
  createUser({ username: 'actor', password: 'secret123', fullName: 'Actor', roleId }, env.ctx)
  return { session: login('actor', 'secret123', 88).session }
}
async function routes() {
  const result = new Map<string, (event: IpcMainInvokeEvent, payload: unknown) => Promise<IpcResult<unknown>>>()
  const electron = await import('electron')
  const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { result.set(channel, handler) }) as never)
  try { (await import('@main/ipc/router')).registerIpcRouter() } finally { spy.mockRestore() }
  return result
}
const event = { sender: { id: 88 } } as IpcMainInvokeEvent
function markup(draft: string | undefined, current: unknown) {
  const rate = parseSavingsRateDraft(draft)
  return renderToStaticMarkup(React.createElement(Select, { value: rate === undefined ? '' : String(rate), onChange: () => undefined }, [React.createElement('option', { key: 'missing', value: '', disabled: true }, 'اختر نسبة صحيحة'), ...savingsRateOptions(current, rate).map((bp) => React.createElement('option', { key: bp, value: bp }, savingsRateLabel(bp)))]))
}
const financial = (state: ReturnType<typeof uiWf07Snapshot>) => Object.fromEntries(Object.entries(state).filter(([name]) => !['app_settings', 'audit_log', 'sqlite_sequence'].includes(name)))
const auditCount = () => (getRawConnection().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='settings.update' AND entity_id='savings.rate_bp'").get() as { n: number }).n

describe('UI-WF-08 controlled savings rate and authoritative persistence', () => {
  it.each([
    [undefined, true, true], [undefined, false, true], [0, false, false], [10000, false, false],
    [null, false, true], [10001, false, true], ['10000', false, true]
  ])('actual page with rate %s / loading %s keeps editor disabled=%s until a valid authoritative value exists', (rate, loading, disabled) => {
    shell.data = rate === undefined ? undefined : { savingsRateBp: rate }
    shell.loading = loading as boolean
    const before = uiWf07Snapshot()
    const html = renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(SavingsPage)))
    const button = html.match(/<button[^>]*>تعديل نسبة الادخار<\/button>/)?.[0]
    expect(button).toBeDefined()
    expect(button?.includes('disabled=""')).toBe(disabled)
    if (rate !== undefined && !isSavingsRateBp(rate)) expect(html).toContain('نسبة الادخار المحفوظة غير صالحة')
    expect(uiWf07Snapshot()).toEqual(before)
  })
  it('represents every owner-valid integer basis-point value exactly, with a unique matching option', () => {
    for (let bp = 0; bp <= 10000; bp++) {
      const options = savingsRateOptions(bp)
      expect(options.filter((value) => value === bp)).toHaveLength(1)
      expect(options.every(isSavingsRateBp)).toBe(true)
      expect(new Set(options).size).toBe(options.length)
      expect(parseSavingsRateDraft(String(bp))).toBe(bp)
      const fraction = bp % 100
      const exactLabel = `${Math.floor(bp / 100)}${fraction ? ',' + String(fraction).padStart(2, '0').replace(/0$/, '') : ''}%`
      expect(savingsRateLabel(bp)).toBe(exactLabel)
    }
  })
  it('keeps established presets and adds only the valid full boundary and non-preset current value', () => {
    expect(RATE_OPTIONS).toEqual([0, 500, 1000, 1500, 2000, 2500, 3000, 4000, 5000])
    expect(savingsRateOptions(3333)).toEqual([0, 500, 1000, 1500, 2000, 2500, 3000, 3333, 4000, 5000, 10000])
  })
  it('retains a non-preset unsaved draft if an asynchronous authoritative refresh changes the stored rate', () => {
    expect(markup('3333', 4000)).toContain('value="3333" selected="">33,33%</option>')
    expect(parseSavingsRateDraft('3333')).toBe(3333)
    expect(savingsRateOptions(4000, 3333)).toContain(3333)
    expect(savingsRateOptions(4000, '')).not.toContain(NaN)
  })
  it.each([[0, '0%'], [10000, '100%'], [2500, '25%'], [3333, '33,33%'], [1, '0,01%'], [9999, '99,99%']] as const)('stored %i has matching controlled label %s, unchanged Save and IPC/read-back parity', async (rate, label) => {
    const ctx = actor(true)
    setSavingsRateBp(rate, ctx)
    const loaded = savingsOverview(2026, 10).savingsRateBp
    const html = markup(String(loaded), loaded)
    expect(html).toContain(`value="${rate}" selected="">${label}</option>`)
    const before = uiWf07Snapshot(), a = auditCount()
    const handlers = await routes()
    expect(await handlers.get(IPC_CHANNELS.profit.setSavingsRate)!(event, { rateBp: parseSavingsRateDraft(String(loaded)) })).toEqual({ ok: true, data: { savingsRateBp: rate } })
    expect(getSavingsRateBp()).toBe(rate)
    expect(getRawConnection().prepare("SELECT value FROM app_settings WHERE key='savings.rate_bp'").get()).toEqual({ value: String(rate) })
    expect(await handlers.get(IPC_CHANNELS.profit.savingsOverview)!(event, { year: 2026, month: 10 })).toMatchObject({ ok: true, data: { savingsRateBp: rate } })
    expect(markup(String(getSavingsRateBp()), getSavingsRateBp())).toContain(`>${label}</option>`)
    expect(auditCount()).toBe(a + 1)
    expect(financial(uiWf07Snapshot())).toEqual(financial(before))
  })
  it.each([[0, 10000], [10000, 0], [2500, 4000], [4000, 1500]])('selection %i → %i remains read-only until one legitimate save', async (initial, target) => {
    const ctx = actor(true)
    setSavingsRateBp(initial, ctx)
    const before = uiWf07Snapshot(), a = auditCount()
    const draft = String(target)
    expect(markup(draft, initial)).toContain(`value="${target}" selected="">${savingsRateLabel(target)}</option>`)
    expect(uiWf07Snapshot()).toEqual(before)
    const handlers = await routes()
    expect(await handlers.get(IPC_CHANNELS.profit.setSavingsRate)!(event, { rateBp: parseSavingsRateDraft(draft) })).toMatchObject({ ok: true, data: { savingsRateBp: target } })
    expect(getSavingsRateBp()).toBe(target)
    expect(auditCount()).toBe(a + 1)
    expect(financial(uiWf07Snapshot())).toEqual(financial(before))
  })
  it('keeps valid zero distinct from missing configuration and empty/invalid drafts', () => {
    expect(getRawConnection().prepare("SELECT value FROM app_settings WHERE key='savings.rate_bp'").get()).toBeUndefined()
    expect(getSavingsRateBp()).toBe(1000) // Existing owner default, never a renderer zero fallback.
    setSavingsRateBp(0, env.ctx)
    expect(getSavingsRateBp()).toBe(0)
    expect(parseSavingsRateDraft('0')).toBe(0)
    for (const value of [undefined, '', ' ', '-1', '10001', '1.5', 'NaN', '0100']) {
      expect(parseSavingsRateDraft(value)).toBeUndefined()
      expect(markup(value, undefined)).toContain('value="" disabled="" selected=""')
      expect(markup(value, undefined)).not.toContain('value="0" selected=""')
    }
    for (const value of [undefined, null, '', '10000', NaN, Infinity, -1, 10001, 1.5]) expect(isSavingsRateBp(value)).toBe(false)
  })
  it('inspection, draft change and cancellation perform no writes or financial changes', () => {
    setSavingsRateBp(10000, env.ctx)
    const before = uiWf07Snapshot()
    markup(String(getSavingsRateBp()), getSavingsRateBp())
    markup('0', getSavingsRateBp())
    markup(undefined, getSavingsRateBp())
    expect(uiWf07Snapshot()).toEqual(before)
  })
  it.each([-1, 10001, 1.5, null, '', false, '10000'])('registered IPC independently rejects invalid/unmatched %s with no writes', async (rateBp) => {
    actor(true)
    const handlers = await routes(), before = uiWf07Snapshot()
    expect(await handlers.get(IPC_CHANNELS.profit.setSavingsRate)!(event, { rateBp })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(uiWf07Snapshot()).toEqual(before)
  })
  it('real read-only role cannot save through service or registered IPC', async () => {
    const ctx = actor(false), handlers = await routes(), before = uiWf07Snapshot()
    expect(() => setSavingsRateBp(10000, ctx)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(await handlers.get(IPC_CHANNELS.profit.setSavingsRate)!(event, { rateBp: 10000 })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(uiWf07Snapshot()).toEqual(before)
  })
  it('generic settings cannot bypass the reserved savings owner', () => {
    const before = uiWf07Snapshot()
    expect(() => setSetting('savings.rate_bp', 0, env.ctx)).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }))
    expect(uiWf07Snapshot()).toEqual(before)
  })
  it('required audit failure rolls the legitimate rate write back', async () => {
    actor(true)
    setSavingsRateBp(10000, env.ctx)
    const handlers = await routes()
    getRawConnection().exec("CREATE TEMP TRIGGER uiwf08_fail BEFORE INSERT ON audit_log WHEN NEW.action='settings.update' AND NEW.entity_id='savings.rate_bp' BEGIN SELECT RAISE(ABORT,'UIWF08 required audit failure'); END")
    try {
      const before = uiWf07Snapshot()
      expect(await handlers.get(IPC_CHANNELS.profit.setSavingsRate)!(event, { rateBp: 0 })).toMatchObject({ ok: false })
      expect(uiWf07Snapshot()).toEqual(before)
    } finally { getRawConnection().exec('DROP TRIGGER uiwf08_fail') }
  })
  it('valid rate changes preserve confirmed historical allocation/cash while the existing future proposal formula applies', () => {
    const period = uiWf08Fixture(env.ctx), before = uiWf07Snapshot()
    expect(period.netProfitMinor).toBe(5000000)
    for (const rate of [0, 10000, 2500, 3333]) {
      setSavingsRateBp(rate, env.ctx)
      expect(monthlyProfitSummary(period.year, period.month).savingsProposedMinor).toBe(500 * rate)
      expect(savingsOverview(period.year, period.month).confirmedMinor).toBe(500000)
      expect(financial(uiWf07Snapshot())).toEqual(financial(before))
    }
  })
})
