import { z } from 'zod'
import type { AuthSession } from '../types/user.types'

export const LoginRequestSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(200),
  /** "تذكرني" — optional, defaults to false; see auth.service.ts. */
  rememberMe: z.boolean().optional()
})
export type LoginRequest = z.infer<typeof LoginRequestSchema>

export interface LoginResponse {
  session: AuthSession
  theme: 'light' | 'dark'
}

export const SetThemeRequestSchema = z.object({ theme: z.enum(['light', 'dark']) })
export type SetThemeRequest = z.infer<typeof SetThemeRequestSchema>
