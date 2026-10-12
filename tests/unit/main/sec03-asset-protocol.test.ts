import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { app, protocol, nativeImage } from 'electron'
import { registerAppProtocol } from '@main/app/protocol'
import { ASSET_URLS, BAD_ASSET_URLS, JPEG, PNG, setupAssetFixtures } from '../../helpers/sec03-assets'
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>() }))
vi.mock('electron', async (original) => ({
  ...await original<typeof import('electron')>(),
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn((bytes: Buffer) => ({ isEmpty: () => !bytes.equals(JPEG) })) }
}))
const schemeRegistration = vi.mocked(protocol.registerSchemesAsPrivileged).mock.calls[0]?.[0]
let dir: string, assets: string, references: string, canary: string
let handle: (request: { url: string }) => Response
beforeEach(() => {
  dir = fs.mkdtempSync('/tmp/sec03-unit-')
  ;({ assets, references, canary } = setupAssetFixtures(dir))
  vi.spyOn(app, 'getAppPath').mockReturnValue(dir)
  vi.mocked(nativeImage.createFromBuffer).mockClear()
  registerAppProtocol()
  const call = vi.mocked(protocol.handle).mock.calls.at(-1)!
  expect(call[0]).toBe('app')
  handle = call[1] as typeof handle
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })
async function deny(url: string) {
  const read = vi.spyOn(fs, 'readFileSync')
  const result = handle({ url })
  expect(result.status).toBe(404)
  expect(result.headers.get('cache-control')).toBe('no-store')
  expect(read).not.toHaveBeenCalled()
  expect(await result.text()).toBe('Not found')
  read.mockRestore()
  expect(fs.readFileSync(canary)).toEqual(PNG)
}
describe('SEC-03 exact bundled protocol boundary', () => {
  it.each(ASSET_URLS)('serves the existing producer %s with its explicit MIME', async (url) => {
    const result = handle({ url })
    expect(result.status).toBe(200)
    expect(result.headers.get('x-content-type-options')).toBe('nosniff')
    expect(result.headers.get('cache-control')).toBe('no-store')
    const bytes = Buffer.from(await result.arrayBuffer())
    if (url.endsWith('.jpeg')) {
      expect(bytes).toEqual(JPEG)
      expect(result.headers.get('content-type')).toBe('image/jpeg')
    } else if (url.endsWith('.ttf')) {
      expect(bytes.readUInt32BE(0)).toBe(0x00010000)
      expect(result.headers.get('content-type')).toBe('font/ttf')
    } else {
      expect(bytes.toString()).toContain('@font-face')
      expect(result.headers.get('content-type')).toBe('text/css; charset=utf-8')
    }
  })
  it.each(BAD_ASSET_URLS)('rejects %j before reading any file', async (url) => { await deny(url) })
  it('denies the original encoded absolute canary route and sibling-prefix selection', async () => {
    await deny(`app://assets/..%2F..%2F${canary.replaceAll('/', '%2F')}`)
    await deny('app://assets/../assets-extra/brand/logo-full.jpeg')
  })
  it('uses missing-file 404 without leaking absolute paths', async () => {
    fs.unlinkSync(join(assets, 'brand/logo-full.jpeg'))
    await deny(ASSET_URLS[0]!)
  })
  it.each(['<html><script>fictional()</script></html>', 'SQLite format 3\0', 'plain text', '<svg onload="fictional()"/>'])('does not serve non-image content disguised as JPEG: %j', async (content) => {
    fs.writeFileSync(join(assets, 'brand/logo-full.jpeg'), content)
    const result = handle({ url: ASSET_URLS[0]! })
    expect(result.status).toBe(404)
    expect(await result.text()).toBe('Not found')
  })
  it('rejects truncated JPEG even when its prefix passes the magic check', async () => {
    fs.writeFileSync(join(assets, 'brand/logo-full.jpeg'), Buffer.from([0xff, 0xd8, 0xff]))
    const result = handle({ url: ASSET_URLS[0]! })
    expect(result.status).toBe(404)
    expect(nativeImage.createFromBuffer).toHaveBeenCalled()
  })
  it('rejects invalid font content; the CSS exception is only its fixed trusted filename', async () => {
    fs.writeFileSync(join(assets, 'fonts/Cairo-Regular.ttf'), 'fictional text')
    expect(handle({ url: ASSET_URLS[3]! }).status).toBe(404)
    await deny('app://assets/fonts/arbitrary.css')
  })
  it('all URL producers continue to use the same five literal resources', () => {
    const sources = ['src/main/reports/templates/base-document.template.ts', 'src/main/reports/templates/documents.template.ts', 'resources/assets/fonts/fonts.css'].map((p) => fs.readFileSync(p, 'utf8')).join('\n')
    const urls = new Set(sources.match(/app:\/\/assets\/[A-Za-z0-9/.-]+/g))
    expect(urls).toEqual(new Set(ASSET_URLS))
  })
  it('scheme privileges remain unchanged and registration is for app only', () => {
    expect(schemeRegistration).toEqual([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } }])
    expect(protocol.handle).toHaveBeenLastCalledWith('app', expect.any(Function))
  })
})
describe('SEC-03 descriptor and symlink containment', () => {
  it.each(['target', 'brand', 'assets', 'resources', 'references', 'qr-target'])('does not follow a symlinked %s', async (kind) => {
    let path: string, outside: string, url = ASSET_URLS[0]!
    if (kind === 'target' || kind === 'qr-target') {
      path = kind === 'target' ? join(assets, 'brand/logo-full.jpeg') : join(references, 'qr.jpeg')
      outside = canary
      fs.unlinkSync(path)
      if (kind === 'qr-target') url = ASSET_URLS[1]!
    } else {
      path = kind === 'brand' ? join(assets, 'brand') : kind === 'assets' ? assets : kind === 'resources' ? join(dir, 'resources') : references
      outside = join(dir, 'outside')
      fs.mkdirSync(outside)
      fs.renameSync(path, `${path}-original`)
      if (kind === 'references') url = ASSET_URLS[1]!
    }
    fs.symlinkSync(outside, path)
    await deny(url)
  })
  it('rejects nonregular target and hardlink alias', async () => {
    const path = join(assets, 'brand/logo-full.jpeg')
    fs.unlinkSync(path); fs.mkdirSync(path)
    await deny(ASSET_URLS[0]!)
    fs.rmdirSync(path); fs.linkSync(canary, path)
    await deny(ASSET_URLS[0]!)
  })
  it('reads the validated descriptor when the leaf is replaced after validation', async () => {
    const target = join(assets, 'brand/logo-full.jpeg')
    const realRead = fs.readFileSync
    const read = vi.spyOn(fs, 'readFileSync').mockImplementationOnce(((fd: number) => {
      expect(typeof fd).toBe('number')
      fs.renameSync(target, `${target}-original`)
      fs.symlinkSync(canary, target)
      return realRead(fd)
    }) as never)
    const result = handle({ url: ASSET_URLS[0]! })
    expect(result.status).toBe(200)
    expect(Buffer.from(await result.arrayBuffer())).toEqual(JPEG)
    expect(read).toHaveBeenCalledOnce()
    read.mockRestore()
    await deny(ASSET_URLS[0]!)
  })
})
