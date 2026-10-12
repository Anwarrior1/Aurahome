import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import {
  createEmployee,
  deleteEmployee,
  recordEmployeeTransaction
} from '@main/services/hr/employees.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { getRawConnection } from '@main/db/connection'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { moneyFromMajor } from '@shared/money/money'

let env: TestEnv
let handlers: Map<
  string,
  (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>
>
let event: IpcMainInvokeEvent
let windowId = 8800

beforeEach(async () => {
  env = setupTestDatabase()
  windowId += 1
  event = { sender: { id: windowId } } as IpcMainInvokeEvent
  login('owner', 'secret123', windowId)
  handlers = new Map()
  const electron = await import('electron')
  const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((
    channel: string,
    handler: never
  ) => {
    handlers.set(channel, handler)
  }) as never)
  const { registerIpcRouter } = await import('@main/ipc/router')
  registerIpcRouter()
  spy.mockRestore()
})

afterEach(() => env.cleanup())

async function invoke(channel: string, request: unknown): Promise<IpcResult<unknown>> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler registered for ${channel}`)
  return handler(event, request)
}

describe('employee lifecycle IPC security', () => {
  it('requires manage permission and typed-name confirmation for removal', async () => {
    const employeeId = createEmployee(
      { name: 'موظف محمي', monthlySalaryMinor: moneyFromMajor(900) },
      env.ctx
    )
    const roleId = createRole(
      { name: 'مالية فقط', permissions: [P.employees.view, P.employees.finance] },
      env.ctx
    )
    createUser(
      { username: 'finance-only-lifecycle', password: 'secret789', fullName: 'مالي', roleId },
      env.ctx
    )
    login('finance-only-lifecycle', 'secret789', windowId)

    const unauthorized = await invoke(IPC_CHANNELS.employees.remove, {
      id: employeeId,
      confirmation: 'موظف محمي'
    })
    expect(unauthorized.ok).toBe(false)
    if (!unauthorized.ok) expect(unauthorized.error.code).toBe('FORBIDDEN')

    login('owner', 'secret123', windowId)
    const wrongName = await invoke(IPC_CHANNELS.employees.remove, {
      id: employeeId,
      confirmation: 'اسم آخر'
    })
    expect(wrongName.ok).toBe(false)
    if (!wrongName.ok) expect(wrongName.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects active manipulation through generic employee update IPC', async () => {
    const employeeId = createEmployee(
      { name: 'لا يتغير', monthlySalaryMinor: moneyFromMajor(900) },
      env.ctx
    )

    const result = await invoke(IPC_CHANNELS.employees.update, { id: employeeId, active: false })

    expect(result.ok).toBe(false)
    expect(
      (
        getRawConnection().prepare('SELECT active FROM employees WHERE id = ?').get(employeeId) as {
          active: number
        }
      ).active
    ).toBe(1)
  })

  it('blocks direct IPC creation of salary, deduction and advance after removal, while bounded repayment succeeds', async () => {
    const employeeId = createEmployee(
      { name: 'موظف سابق', monthlySalaryMinor: moneyFromMajor(1_500) },
      env.ctx
    )
    recordEmployeeTransaction(
      { employeeId, kind: 'advance', amountMinor: moneyFromMajor(300) },
      env.ctx
    )
    deleteEmployee({ id: employeeId, confirmation: 'موظف سابق' }, env.ctx)

    for (const [channel, payload] of [
      [
        IPC_CHANNELS.employees.paySalary,
        {
          employeeId,
          amountMinor: moneyFromMajor(1_500),
          periodYear: 2026,
          periodMonth: 1,
          requestKey: 'db05-former-salary-blocked'
        }
      ],
      [
        IPC_CHANNELS.employees.transaction,
        {
          employeeId,
          kind: 'deduction',
          amountMinor: moneyFromMajor(100),
          periodYear: 2026,
          periodMonth: 1,
          requestKey: 'db05-former-deduction-blocked'
        }
      ],
      [
        IPC_CHANNELS.employees.transaction,
        {
          employeeId,
          kind: 'advance',
          amountMinor: moneyFromMajor(50),
          requestKey: 'db05-former-advance-blocked'
        }
      ]
    ] as const) {
      const result = await invoke(channel, payload)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('CONFLICT')
    }

    const overpayment = await invoke(IPC_CHANNELS.employees.transaction, {
      employeeId,
      kind: 'repayment',
      amountMinor: moneyFromMajor(301),
      requestKey: 'db05-former-repayment-over'
    })
    expect(overpayment.ok).toBe(false)

    const settlement = await invoke(IPC_CHANNELS.employees.transaction, {
      employeeId,
      kind: 'repayment',
      amountMinor: moneyFromMajor(300),
      requestKey: 'db05-former-repayment-success'
    })
    expect(settlement.ok).toBe(true)
    expect(
      (
        getRawConnection()
          .prepare(
            `
      SELECT active FROM employees WHERE id = ?
    `
          )
          .get(employeeId) as { active: number }
      ).active
    ).toBe(0)
  })

  it('cannot bypass the former-settlement balance rule through direct IPC', async () => {
    const employeeId = createEmployee(
      { name: 'تسوية محمية', monthlySalaryMinor: moneyFromMajor(1000) },
      env.ctx
    )
    recordEmployeeTransaction(
      { employeeId, kind: 'advance', amountMinor: moneyFromMajor(200) },
      env.ctx
    )
    deleteEmployee({ id: employeeId, confirmation: 'تسوية محمية' }, env.ctx)

    const blocked = await invoke(IPC_CHANNELS.employees.dismissFormerSettlement, { id: employeeId })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) {
      expect(blocked.error.code).toBe('CONFLICT')
      expect(blocked.error.message).toContain('سداد السلفة القائمة بالكامل')
    }

    const repaid = await invoke(IPC_CHANNELS.employees.transaction, {
      employeeId,
      kind: 'repayment',
      amountMinor: moneyFromMajor(200),
      requestKey: 'db05-former-dismiss-repayment'
    })
    expect(repaid.ok).toBe(true)
    const allowed = await invoke(IPC_CHANNELS.employees.dismissFormerSettlement, { id: employeeId })
    expect(allowed).toEqual({
      ok: true,
      data: { removedFromSettlement: true, historyPreserved: true }
    })
    expect(
      (
        getRawConnection().prepare('SELECT active FROM employees WHERE id = ?').get(employeeId) as {
          active: number
        }
      ).active
    ).toBe(0)
    expect(
      (
        getRawConnection()
          .prepare(
            "SELECT COUNT(*) AS count FROM employee_transactions WHERE employee_id = ? AND kind = 'advance'"
          )
          .get(employeeId) as { count: number }
      ).count
    ).toBe(1)
    expect(
      (
        getRawConnection()
          .prepare(
            "SELECT COUNT(*) AS count FROM employee_transactions WHERE employee_id = ? AND kind = 'repayment'"
          )
          .get(employeeId) as { count: number }
      ).count
    ).toBe(1)
  })

  it('requires employee management authority to dismiss a settled former employee', async () => {
    const employeeId = createEmployee(
      { name: 'تسوية بلا صلاحية', monthlySalaryMinor: moneyFromMajor(1000) },
      env.ctx
    )
    recordEmployeeTransaction(
      { employeeId, kind: 'advance', amountMinor: moneyFromMajor(50) },
      env.ctx
    )
    deleteEmployee({ id: employeeId, confirmation: 'تسوية بلا صلاحية' }, env.ctx)
    recordEmployeeTransaction(
      { employeeId, kind: 'repayment', amountMinor: moneyFromMajor(50) },
      env.ctx
    )

    const roleId = createRole(
      { name: 'مالية موظفين فقط', permissions: [P.employees.view, P.employees.finance] },
      env.ctx
    )
    createUser(
      { username: 'settlement-finance-only', password: 'secret789', fullName: 'مالية فقط', roleId },
      env.ctx
    )
    login('settlement-finance-only', 'secret789', windowId)

    const result = await invoke(IPC_CHANNELS.employees.dismissFormerSettlement, { id: employeeId })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN')
    expect(
      (
        getRawConnection()
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_log WHERE action = 'employees.formerSettlement.dismiss' AND entity_id = ?"
          )
          .get(String(employeeId)) as { count: number }
      ).count
    ).toBe(0)
  })
})
