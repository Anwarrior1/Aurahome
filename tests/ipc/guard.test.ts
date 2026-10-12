import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import type { IpcMainInvokeEvent } from 'electron'
import { createHandler } from '@main/ipc/guard'
import { positiveMoneyMinorSchema, positiveQuantityMicroSchema } from '@shared/schemas/common.schema'

describe('createHandler (IPC guard: validate → auth → permission → handler)', () => {
  it('blocks malformed integer-domain IPC money and quantity before invoking a handler', async () => {
    let called = 0
    const handler = createHandler({ schema: z.object({
      amountMinor: positiveMoneyMinorSchema,
      qtyMicro: positiveQuantityMicroSchema
    }) }, async () => { called++; return called })
    for (const value of [0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10', null, undefined, 0, -1]) {
      const result = await handler({} as IpcMainInvokeEvent,
        { amountMinor: value, qtyMicro: 1 })
      expect(result.ok).toBe(false)
      const quantityResult = await handler({} as IpcMainInvokeEvent,
        { amountMinor: 1, qtyMicro: value })
      expect(quantityResult.ok).toBe(false)
    }
    expect(called).toBe(0)
    expect((await handler({} as IpcMainInvokeEvent,
      { amountMinor: Number.MAX_SAFE_INTEGER, qtyMicro: 1 })).ok).toBe(true)
  })
  it('rejects a payload that fails schema validation before the handler runs', async () => {
    const schema = z.object({ name: z.string().min(1) })
    let handlerCalled = false
    const handler = createHandler({ schema }, async () => {
      handlerCalled = true
      return { ok: true }
    })

    const result = await handler({} as IpcMainInvokeEvent, { name: '' })

    expect(handlerCalled).toBe(false)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_ERROR')
  })

  it('resolves ok:true with the handler result when validation passes', async () => {
    const schema = z.object({ name: z.string().min(1) })
    const handler = createHandler({ schema }, async (req) => ({ greeting: `مرحباً ${req.name}` }))

    const result = await handler({} as IpcMainInvokeEvent, { name: 'أحمد' })

    expect(result).toEqual({ ok: true, data: { greeting: 'مرحباً أحمد' } })
  })
})
