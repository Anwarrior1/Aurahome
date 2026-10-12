import type { IpcResult } from '@shared/types/ipc.types'

/**
 * Thin typed wrapper over the preload bridge. It unwraps the
 * normalized IpcResult envelope and turns a failure into a thrown
 * ApiError carrying the Arabic, user-safe message that main produced
 * — the renderer never sees a stack trace or SQL error.
 */
export class ApiError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'ApiError'
  }
}

type Group = keyof Window['erp']

export async function call<T = unknown>(
  group: Group,
  method: string,
  payload?: unknown
): Promise<T> {
  const groupApi = window.erp[group] as Record<string, (p?: unknown) => Promise<IpcResult<T>>>
  const fn = groupApi?.[method]
  if (!fn) throw new ApiError('INTERNAL_ERROR', 'عملية غير معروفة')
  const result = await fn(payload)
  if (!result.ok) throw new ApiError(result.error.code, result.error.message)
  return result.data
}

/**
 * Durable-retry caller boundary for externally initiated financial creates.
 * The key is generated once for a pending logical intent, survives a renderer
 * or application restart in localStorage, and is removed only after main
 * confirms success. A fresh action after success therefore receives a new key.
 */
export async function financialCall<T = unknown>(
  group: Group,
  method: string,
  payload: Record<string, unknown>,
  intentSlot = `${String(group)}.${method}`
): Promise<T> {
  const storageKey = `aura.financialRequest.${intentSlot}`
  const requestKey = localStorage.getItem(storageKey) ?? crypto.randomUUID()
  localStorage.setItem(storageKey, requestKey)
  const result = await call<T>(group, method, { ...payload, requestKey })
  localStorage.removeItem(storageKey)
  return result
}

export const api = {
  auth: {
    login: (username: string, password: string, rememberMe = false) =>
      call<{ session: Session; theme: 'light' | 'dark' }>('auth', 'login', {
        username,
        password,
        rememberMe
      }),
    logout: () => call('auth', 'logout'),
    /** "تذكرني" — resumes a remembered login, if any (see auth.service.ts).
     *  A `null` data payload is the normal "nothing remembered" outcome. */
    tryResume: () =>
      call<{ session: Session; theme: 'light' | 'dark' } | null>('auth', 'tryResume'),
    setupStatus: () => call<{ needsSetup: boolean }>('auth', 'setupStatus'),
    performSetup: (payload: { username: string; password: string; fullName: string }) =>
      call('auth', 'performSetup', payload),
    setTheme: (theme: 'light' | 'dark') => call('auth', 'setTheme', { theme })
  },
  get: <T = unknown>(group: Group, method: string, payload?: unknown) =>
    call<T>(group, method, payload)
}

export interface Session {
  sessionId: string
  user: {
    id: number
    username: string
    fullName: string
    roleId: number
    roleName: string
    isAdmin: boolean
  }
  permissions: string[]
  issuedAt: string
}
