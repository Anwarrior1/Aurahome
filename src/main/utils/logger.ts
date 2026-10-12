import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Minimal local file + console logger. No network transport exists or
 * will ever exist in this codebase — the application is fully offline
 * (BR-26). Logs live under %APPDATA%\AURA home\logs, one file per day.
 */
function logFilePath(): string {
  const dir = join(app.getPath('userData'), 'logs')
  mkdirSync(dir, { recursive: true })
  const date = new Date().toISOString().slice(0, 10)
  return join(dir, `${date}.log`)
}

function safeStringify(value: unknown): string {
  try {
    return value instanceof Error ? `${value.message}\n${value.stack}` : JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function write(level: 'info' | 'warn' | 'error', message: string, meta?: unknown): void {
  const line = `[${new Date().toISOString()}] [${level}] ${message}${meta ? ' ' + safeStringify(meta) : ''}\n`
  // eslint-disable-next-line no-console
  console[level === 'error' ? 'error' : 'log'](line.trim())
  try {
    appendFileSync(logFilePath(), line)
  } catch {
    // Logging must never crash the app.
  }
}

export const logger = {
  info: (message: string, meta?: unknown) => write('info', message, meta),
  warn: (message: string, meta?: unknown) => write('warn', message, meta),
  error: (message: string, meta?: unknown) => write('error', message, meta)
}
