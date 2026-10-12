import { dialog, type BrowserWindow } from 'electron'
import { backupFileName } from '../backup/archive'

/**
 * The renderer can never name a filesystem path directly (Step 2 §4)
 * — it asks main to open a native OS dialog, and main hands back only
 * the path the user actually chose.
 */
export async function pickBackupDestinationFile(win: BrowserWindow): Promise<string | undefined> {
  const result = await dialog.showSaveDialog(win, {
    title: 'حفظ النسخة الاحتياطية',
    defaultPath: backupFileName(),
    filters: [{ name: 'AURA home Backup', extensions: ['aurabak'] }]
  })
  return result.canceled ? undefined : result.filePath
}

export async function pickBackupFileToRestore(win: BrowserWindow): Promise<string | undefined> {
  const result = await dialog.showOpenDialog(win, {
    title: 'اختر ملف النسخة الاحتياطية',
    filters: [{ name: 'AURA home Backup', extensions: ['aurabak'] }],
    properties: ['openFile']
  })
  return result.canceled ? undefined : result.filePaths[0]
}

/**
 * Only the path the user chose through this native dialog is ever
 * handed back — the extension filter is a UI convenience only, never
 * the actual security boundary; the real type check is the magic-byte
 * sniff in profile.service.ts once the file is actually read.
 */
export async function pickProfileImage(win: BrowserWindow): Promise<string | undefined> {
  const result = await dialog.showOpenDialog(win, {
    title: 'اختر صورة الملف الشخصي',
    filters: [{ name: 'صورة', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    properties: ['openFile']
  })
  return result.canceled ? undefined : result.filePaths[0]
}
