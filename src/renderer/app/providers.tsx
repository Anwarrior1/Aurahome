import type { PropsWithChildren, ReactElement } from 'react'
import { ThemeProvider } from '@renderer/theme/ThemeProvider'
import { SessionProvider } from '@renderer/state/session.store'
import { SelectedDateProvider } from '@renderer/state/selected-date.store'
import { ToastProvider } from '@renderer/lib/toast'

export function AppProviders({ children }: PropsWithChildren): ReactElement {
  return (
    <ThemeProvider>
      <ToastProvider>
        <SessionProvider>
          <SelectedDateProvider>{children}</SelectedDateProvider>
        </SessionProvider>
      </ToastProvider>
    </ThemeProvider>
  )
}
