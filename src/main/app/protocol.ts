import { protocol, nativeImage } from 'electron'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, type Stats } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { getAssetsRoot, getInvoiceLocationQrPath } from '../files/paths'

// Must run at module load, before app.whenReady() (Electron requirement).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } }
])

type Asset = { root: () => string; parts: string[]; mime: string; kind: 'image' | 'font' | 'css' }
// These are ALL actual protocol URL producers: document templates and Cairo CSS.
// Exact URLs avoid decoding, path normalization and any caller-selected file/root.
const assets = new Map<string, Asset>([
  ['app://assets/brand/logo-full.jpeg', { root: getAssetsRoot, parts: ['brand', 'logo-full.jpeg'], mime: 'image/jpeg', kind: 'image' }],
  ['app://assets/references/qr.jpeg', { root: () => dirname(getInvoiceLocationQrPath()), parts: ['qr.jpeg'], mime: 'image/jpeg', kind: 'image' }],
  ['app://assets/fonts/fonts.css', { root: getAssetsRoot, parts: ['fonts', 'fonts.css'], mime: 'text/css; charset=utf-8', kind: 'css' }],
  ['app://assets/fonts/Cairo-Regular.ttf', { root: getAssetsRoot, parts: ['fonts', 'Cairo-Regular.ttf'], mime: 'font/ttf', kind: 'font' }],
  ['app://assets/fonts/Cairo-SemiBold.ttf', { root: getAssetsRoot, parts: ['fonts', 'Cairo-SemiBold.ttf'], mime: 'font/ttf', kind: 'font' }]
])

function checkedFile(asset: Asset): { path: string; stat: Stats } | undefined {
  const configured = asset.root()
  const parent = dirname(configured)
  // The OS-selected application/resources anchor may have a canonical alias;
  // the resource directory, root and every child must themselves be real dirs/files.
  if (lstatSync(parent).isSymbolicLink()) return undefined
  const root = join(realpathSync(parent), basename(configured))
  const rootStat = lstatSync(configured)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync(configured) !== root) return undefined
  let path = root
  let stat = rootStat
  for (const [index, part] of asset.parts.entries()) {
    path = join(path, part) // parts are fixed trusted literals, never URL input
    stat = lstatSync(path)
    if (stat.isSymbolicLink() || realpathSync(path) !== path) return undefined
    if (index < asset.parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) return undefined
  }
  return { path, stat }
}

function readAsset(asset: Asset): Buffer | undefined {
  const before = checkedFile(asset)
  if (!before) return undefined
  let fd: number | undefined
  try {
    fd = openSync(before.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd)
    const after = checkedFile(asset)
    if (!opened.isFile() || opened.nlink !== 1 || !after || after.path !== before.path ||
      opened.dev !== before.stat.dev || opened.ino !== before.stat.ino ||
      opened.dev !== after.stat.dev || opened.ino !== after.stat.ino) return undefined
    // ponytail: synchronous path checks + pinned descriptor; concurrent OS parent
    // replacement still needs filesystem ACLs (Node exposes no directory openat).
    return readFileSync(fd)
  } finally { if (fd !== undefined) closeSync(fd) }
}

function assetResponse(url: string): Response {
  try {
    const asset = assets.get(url)
    if (asset) {
      const bytes = readAsset(asset)
      if (bytes) {
        const valid = asset.kind === 'image'
          ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && !nativeImage.createFromBuffer(bytes).isEmpty()
          : asset.kind === 'font'
            ? bytes.length >= 12 && bytes.readUInt32BE(0) === 0x00010000
            : true // only the existing trusted bundled Cairo stylesheet, not arbitrary CSS
        if (valid) return new Response(new Uint8Array(bytes), {
          headers: { 'Content-Type': asset.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }
        })
      }
    }
  } catch { /* Missing, malformed or unsafe resource: no filesystem details in response. */ }
  return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
}

/** Public bundled resources only; no ERP identity or arbitrary file capability. */
export function registerAppProtocol(): void {
  protocol.handle('app', (request) => assetResponse(request.url))
}
