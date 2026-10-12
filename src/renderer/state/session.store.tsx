import {
  createContext, useCallback, useContext, useEffect, useState,
  type PropsWithChildren, type ReactElement
} from 'react'
import { api, ApiError, type Session } from '@renderer/lib/api'

interface SessionContextValue {
  session: Session | undefined
  needsSetup: boolean
  ready: boolean
  login: (username: string, password: string, rememberMe?: boolean) => Promise<void>
  setup: (input: { username: string; password: string; fullName: string }) => Promise<void>
  logout: () => Promise<void>
  can: (permission: string) => boolean
}

const SessionContext = createContext<SessionContextValue | undefined>(undefined)

/**
 * Holds a DISPLAY copy of the session. The authoritative session lives
 * in main-process memory, bound to this window's webContents — the
 * renderer never sends a session id and cannot forge one. `can()` is
 * for hiding UI only; the real enforcement is the permission guard in
 * main (BR-104).
 */
export function SessionProvider({ children }: PropsWithChildren): ReactElement {
  const [session, setSession] = useState<Session | undefined>()
  const [needsSetup, setNeedsSetup] = useState(false)
  const [ready, setReady] = useState(false)

  const applyTheme = useCallback((theme: 'light' | 'dark') => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const status = await api.auth.setupStatus()
        setNeedsSetup(status.needsSetup)
        // "تذكرني": one silent attempt to resume a remembered login
        // before the login screen would otherwise show. A `null`
        // result (nothing remembered, or it no longer checks out) is
        // the normal case and just falls through to a manual login.
        if (!status.needsSetup) {
          const resumed = await api.auth.tryResume()
          if (resumed) {
            setSession(resumed.session)
            applyTheme(resumed.theme)
          }
        }
      } catch {
        setNeedsSetup(false)
      } finally {
        setReady(true)
      }
    })()
  }, [applyTheme])

  const login = useCallback(
    async (username: string, password: string, rememberMe = false) => {
      const result = await api.auth.login(username, password, rememberMe)
      setSession(result.session)
      applyTheme(result.theme)
    },
    [applyTheme]
  )

  const setup = useCallback(
    async (input: { username: string; password: string; fullName: string }) => {
      await api.auth.performSetup(input)
      setNeedsSetup(false)
      await login(input.username, input.password)
    },
    [login]
  )

  const logout = useCallback(async () => {
    try {
      await api.auth.logout()
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
    }
    setSession(undefined)
  }, [])

  const can = useCallback(
    (permission: string) =>
      Boolean(session && (session.user.isAdmin || session.permissions.includes(permission))),
    [session]
  )

  return (
    <SessionContext.Provider value={{ session, needsSetup, ready, login, setup, logout, can }}>
      {children}
    </SessionContext.Provider>
  )
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used within SessionProvider')
  return ctx
}
