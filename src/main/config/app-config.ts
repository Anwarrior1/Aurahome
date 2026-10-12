import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigRoot } from '../files/paths'

/**
 * Non-secret local settings only — theme and printer
 * defaults. Credentials never live here: passwords are scrypt-hashed
 * rows in the database (src/main/auth/password.ts), not config JSON.
 */
export interface AppConfig {
  theme: 'light' | 'dark'
  printer: { defaultPrinterName?: string }
}

const DEFAULT_CONFIG: AppConfig = {
  theme: 'light', // AD-4
  printer: {}
}

function configFilePath(): string {
  return join(getConfigRoot(), 'config.json')
}

export function loadConfig(): AppConfig {
  const path = configFilePath()
  if (!existsSync(path)) return DEFAULT_CONFIG
  try {
    const stored = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AppConfig>
    return {
      theme: stored.theme === 'dark' ? 'dark' : 'light',
      printer: stored.printer ?? {}
    }
  } catch {
    return DEFAULT_CONFIG
  }
}

export function saveConfig(config: AppConfig): void {
  writeFileSync(configFilePath(), JSON.stringify(config, null, 2), 'utf-8')
}
