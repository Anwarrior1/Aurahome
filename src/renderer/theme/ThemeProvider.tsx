import {
  createContext, useCallback, useContext, useEffect, useState,
  type PropsWithChildren, type ReactElement
} from 'react'
import { api } from '@renderer/lib/api'

type Theme = 'light' | 'dark'

const ThemeContext = createContext<{ theme: Theme; toggle: () => void } | undefined>(undefined)

const STORAGE_KEY = 'aura.theme'

/**
 * AD-4: both themes ship, light is the default, and the choice is
 * remembered per user — persisted to the user's row in the database
 * so it follows the account, with a local mirror for instant paint on
 * next launch. Printed documents always use the light/print palette.
 */
export function ThemeProvider({ children }: PropsWithChildren): ReactElement {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem(STORAGE_KEY) as Theme) ?? 'light'
    } catch {
      return 'light'
    }
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      /* private mode — the DB copy is still authoritative */
    }
  }, [theme])

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === 'light' ? 'dark' : 'light'
      void api.auth.setTheme(next).catch(() => undefined)
      return next
    })
  }, [])

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
