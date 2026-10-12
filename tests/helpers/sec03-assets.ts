import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

/** Harmless 2 × 2 fictional color JPEG; distinct external PNG canary. */
export const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDhKKKK7zzD/9k=', 'base64')
export const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex')
export const ASSET_URLS = [
  'app://assets/brand/logo-full.jpeg', 'app://assets/references/qr.jpeg',
  'app://assets/fonts/fonts.css', 'app://assets/fonts/Cairo-Regular.ttf', 'app://assets/fonts/Cairo-SemiBold.ttf'
]
export const BAD_ASSET_URLS = [
  'app://assets/../external.png', 'app://assets/../../external.png',
  'app://assets/brand/../../external.png', 'app://assets/..%2F..%2Fexternal.png',
  'app://assets/%2e%2e%2fexternal.png', 'app://assets/%252e%252e%252fexternal.png',
  'app://assets/..%5C..%5Cexternal.png', 'app://assets/..\\external.png',
  'app://assets/..\\../external.png', 'app://assets//absolute.png',
  'app://assets/C:/external.png', 'app://assets/C:%5Cexternal.png',
  'app://assets/\\\\server\\share\\external.png', 'app://assets/%2F%2Fserver/share/external.png',
  'app://assets/brand%2Flogo-full.jpeg', 'app://assets/brand%5Clogo-full.jpeg',
  'app://assets/brand/%6cogo-full.jpeg', 'app://assets/brand/logo-full.jpeg?path=../../external.png',
  'app://assets/brand/logo-full.jpeg#../../external.png',
  'app://other/brand/logo-full.jpeg', 'app://assets.evil/brand/logo-full.jpeg',
  'app://assets-extra/brand/logo-full.jpeg', 'app://assets@other/brand/logo-full.jpeg',
  'app://user:password@assets/brand/logo-full.jpeg', 'app://assets:123/brand/logo-full.jpeg',
  'app://assets', 'app://assets/', 'app://assets/brand/', '',
  'app://assets/%00.jpeg', 'app://assets/brand/logo-full.jpeg\0',
  'app://assets/%', 'app://assets/%GG.jpeg', 'app://assets/%C0%AFexternal.png',
  'app://assets/ｂrand/logo-full.jpeg', 'app://assets/brand/logo-full.jpeg/',
  'app://assets/brand/logo-full.jpeg/..', 'app://assets/brand/logo-full.svg',
  'app://assets/erp.db', 'app://assets/external.txt', 'app://assets/script.js',
  'app://assets/page.html', 'app://assets/fonts/other.css',
  'file:///external.png', 'https://assets/brand/logo-full.jpeg'
]
export function setupAssetFixtures(appRoot: string) {
  const assets = join(appRoot, 'resources/assets'), references = join(appRoot, 'references')
  for (const path of [join(assets, 'brand'), join(assets, 'fonts'), references, join(appRoot, 'resources/assets-extra/brand')]) mkdirSync(path, { recursive: true })
  writeFileSync(join(assets, 'brand/logo-full.jpeg'), JPEG)
  writeFileSync(join(references, 'qr.jpeg'), JPEG)
  for (const name of ['fonts.css', 'Cairo-Regular.ttf', 'Cairo-SemiBold.ttf']) copyFileSync(join(process.cwd(), 'resources/assets/fonts', name), join(assets, 'fonts', name))
  const canary = join(appRoot, 'external.png')
  writeFileSync(canary, PNG)
  writeFileSync(join(appRoot, 'resources/assets-extra/brand/logo-full.jpeg'), PNG)
  return { assets, references, canary }
}
