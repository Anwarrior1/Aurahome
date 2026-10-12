import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, financialCall } from '@renderer/lib/api'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, value)
    }
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('financialCall request-key lifecycle', () => {
  it('keeps one key across failure/restart uncertainty and clears it only after confirmed success', async () => {
    const storage = memoryStorage()
    let generated = 0
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('crypto', { randomUUID: () => `db05-renderer-key-${++generated}` })

    const delivered: Array<Record<string, unknown>> = []
    let fail = true
    const recordPayment = vi.fn(async (payload: unknown) => {
      delivered.push(payload as Record<string, unknown>)
      if (fail) return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'uncertain result' } }
      return { ok: true, data: { paidMinor: 100_000 } }
    })
    vi.stubGlobal('window', { erp: { orders: { recordPayment } } })

    await expect(
      financialCall(
        'orders',
        'recordPayment',
        { orderId: 1, amountMinor: 100_000 },
        'orders.recordPayment:1'
      )
    ).rejects.toEqual(expect.any(ApiError))
    expect(storage.getItem('aura.financialRequest.orders.recordPayment:1')).toBe(
      'db05-renderer-key-1'
    )

    // A renderer/application restart preserves localStorage but replaces its JS runtime.
    fail = false
    await expect(
      financialCall(
        'orders',
        'recordPayment',
        { orderId: 1, amountMinor: 100_000 },
        'orders.recordPayment:1'
      )
    ).resolves.toEqual({ paidMinor: 100_000 })
    expect(delivered[0].requestKey).toBe('db05-renderer-key-1')
    expect(delivered[1].requestKey).toBe('db05-renderer-key-1')
    expect(storage.getItem('aura.financialRequest.orders.recordPayment:1')).toBeNull()

    await financialCall(
      'orders',
      'recordPayment',
      { orderId: 1, amountMinor: 100_000 },
      'orders.recordPayment:1'
    )
    expect(delivered[2].requestKey).toBe('db05-renderer-key-2')
  })

  it('uses independent keys for distinct pending command slots', async () => {
    const storage = memoryStorage()
    let generated = 0
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('crypto', { randomUUID: () => `db05-slot-key-${++generated}` })
    const create = vi.fn(async () => ({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'uncertain result' }
    }))
    vi.stubGlobal('window', { erp: { expenses: { create } } })

    await expect(
      financialCall('expenses', 'create', { amountMinor: 1 }, 'expenses.create:first')
    ).rejects.toBeInstanceOf(ApiError)
    await expect(
      financialCall('expenses', 'create', { amountMinor: 1 }, 'expenses.create:second')
    ).rejects.toBeInstanceOf(ApiError)

    expect(storage.getItem('aura.financialRequest.expenses.create:first')).toBe('db05-slot-key-1')
    expect(storage.getItem('aura.financialRequest.expenses.create:second')).toBe('db05-slot-key-2')
  })
})
