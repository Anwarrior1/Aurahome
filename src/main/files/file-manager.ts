import { copyFileSync, existsSync } from 'node:fs'

/**
 * Small, deliberately generic helpers. Anything path-sensitive (which
 * root a business file belongs under) stays in paths.ts or the
 * calling service — this module never decides where a file belongs.
 */
export function copyFileIfMissing(source: string, destination: string): void {
  if (!existsSync(destination)) {
    copyFileSync(source, destination)
  }
}
