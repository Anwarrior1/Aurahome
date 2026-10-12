import { createHash } from 'node:crypto'

/** Opaque optimistic-lock token; no financial values are exposed to the renderer. */
export function stateToken(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
