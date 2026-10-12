export interface SessionUser {
  id: number
  username: string
  fullName: string
  roleId: number
  roleName: string
  /** The one full-access account that BR-55 guarantees can never be
   * locked out — bypasses the granted-permission list entirely. */
  isAdmin: boolean
}

export interface AuthSession {
  sessionId: string
  user: SessionUser
  /** Permission keys granted to this session's role (BR-55/BR-104). */
  permissions: string[]
  issuedAt: string
}
