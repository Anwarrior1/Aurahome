/**
 * Minimal stand-in for the 'electron' module so main-process code that
 * only touches a few Electron APIs (app.getPath, app.getVersion) can
 * be unit-tested outside a real Electron runtime. Wired in via the
 * "electron" alias in vitest.config.ts. Extend as Step 4 needs more of
 * the surface mocked.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const BrowserWindow = {
  fromId: () => undefined,
  getAllWindows: () => []
}

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined })
}
export const shell = { openPath: async (_path: string) => '' }

const paths = new Map<string, string>()

export const app = {
  getPath: (name: string) => paths.get(name) ?? join(tmpdir(), 'aura-home-erp-test', String(process.pid), name),
  setPath: (name: string, path: string) => { paths.set(name, path) },
  getVersion: () => '0.0.0-test',
  isPackaged: false,
  getAppPath: () => process.cwd()
}

export const ipcMain = { handle: (_channel: string, _fn: unknown): void => {} }
export const contextBridge = { exposeInMainWorld: () => {} }
export const ipcRenderer = {
  invoke: async () => ({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'mock' } })
}

/**
 * A real OS keychain isn't available in the test environment, so this
 * is a plain reversible stand-in (NOT real encryption) — good enough
 * to exercise the "remember me" round-trip (main/auth/remember-file.ts)
 * without depending on a real secret store being present in CI.
 */
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plainText: string) => Buffer.from(plainText, 'utf8'),
  decryptString: (encrypted: Buffer) => encrypted.toString('utf8')
}
