// Run after npm run build: node tests/electron/bdr01-startup-hold.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.cwd()
const dir = mkdtempSync('/tmp/aura-bdr01-electron-')
mkdirSync(join(dir, 'recovery'))
writeFileSync(join(dir, 'recovery', 'hold.json'), JSON.stringify({ version: 1, operationId: 'fictional-case' }))
writeFileSync(join(dir, 'recovery', 'journal.json'), JSON.stringify({
  version: 1, operationId: 'fictional-case', state: 'review_pending',
  archiveSha256: 'a'.repeat(64), financialReviewApproved: false
}))
const wrapper = join(dir, 'entry.cjs')
writeFileSync(wrapper, `const {app,dialog,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(dir)});app.setPath('sessionData',${JSON.stringify(dir)});
app.getAppPath=()=>${JSON.stringify(root)};
dialog.showErrorBox=(title,message)=>{console.log('BDR01_ERROR',message)};
app.on('before-quit',()=>console.log('BDR01_WINDOWS',BrowserWindow.getAllWindows().length));
import(require('node:url').pathToFileURL(${JSON.stringify(root + '/out/main/index.js')}).href);`)
const electron = fileURLToPath(new URL('../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', import.meta.url))
const child = spawn(electron, [wrapper], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk.toString() })
const result = await Promise.race([
  new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal }))),
  new Promise((resolve) => setTimeout(() => { child.kill('SIGKILL'); resolve({ timeout: true }) }, 20000))
])
console.log(JSON.stringify({ result, output, electron, wrapper }))
assert.equal('timeout' in result, false, output)
assert.match(output, /BDR01_ERROR.*الاستعادة غير مكتملة/)
assert.match(output, /BDR01_WINDOWS 0/)
assert.equal(existsSync(join(dir, 'data')), false)
console.log(JSON.stringify({ result, windows: 0, dataDirectoryCreated: false, fixture: dir }))
