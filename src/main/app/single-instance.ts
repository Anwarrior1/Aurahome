import { app, BrowserWindow } from 'electron'

/** One offline PC, one running copy — a second launch focuses the
 * existing window instead of opening a second instance against the
 * same SQLite file. */
export function acquireSingleInstanceLock(): boolean {
  const gotLock = app.requestSingleInstanceLock()
  if (gotLock) {
    app.on('second-instance', () => {
      const [win] = BrowserWindow.getAllWindows()
      if (win) {
        if (win.isMinimized()) win.restore()
        win.focus()
      }
    })
  }
  return gotLock
}
