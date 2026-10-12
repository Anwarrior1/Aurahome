import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto'

const KEY_LENGTH = 64
const SCRYPT_COST = 16384 // N — memory/CPU cost factor

/**
 * Format: scrypt$<saltHex>$<hashHex>. No plaintext password is ever
 * stored, logged, or transmitted anywhere — this application has no
 * network path at all (BR-26).
 */
export function hashPassword(plainPassword: string): string {
  const salt = randomBytes(16)
  const derived = scryptSync(plainPassword, salt, KEY_LENGTH, { N: SCRYPT_COST })
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
}

export function verifyPassword(plainPassword: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$')
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(hashHex, 'hex')
  const actual = scryptSync(plainPassword, salt, expected.length, { N: SCRYPT_COST })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
