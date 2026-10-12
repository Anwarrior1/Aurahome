import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { is } from '../utils/env'

export async function createMainWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#F2EFEB', // matches --bg-app — avoids a mismatched flash before the RTL app boots
    webPreferences: {
      // Built as CommonJS (.cjs) on purpose: Electron cannot load an ESM
      // preload into a sandboxed renderer, and `sandbox: true` below is
      // part of the approved security boundary. See electron.vite.config.ts.
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: is.dev
    }
  })

  win.once('ready-to-show', () => win.show())

  // No window the renderer opens is ever trusted (Step 2 security boundaries).
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}
