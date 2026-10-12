import type { ReactElement } from 'react'
import { Outlet } from 'react-router-dom'

export function AuthLayout(): ReactElement {
  return (
    <div className="auth-layout">
      <Outlet />
    </div>
  )
}
