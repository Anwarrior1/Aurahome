import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from '@main/auth/password'

describe('password hashing (scrypt, BR-54)', () => {
  it('verifies a correct password and rejects an incorrect one', () => {
    const stored = hashPassword('كلمة-مرور-قوية')
    expect(verifyPassword('كلمة-مرور-قوية', stored)).toBe(true)
    expect(verifyPassword('wrong', stored)).toBe(false)
  })

  it('never stores the plaintext password', () => {
    const stored = hashPassword('secret123')
    expect(stored).not.toContain('secret123')
  })
})
