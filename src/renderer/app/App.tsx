import type { ReactElement } from 'react'
import { AppProviders } from './providers'
import { AppRouter } from '@renderer/routes/router'

export function App(): ReactElement {
  return (
    <AppProviders>
      <AppRouter />
    </AppProviders>
  )
}
