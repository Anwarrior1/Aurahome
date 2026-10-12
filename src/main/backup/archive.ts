import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { link, open, rename, rm, stat, unlink } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { createDeflateRaw, createInflateRaw, deflateRawSync, inflateRawSync } from 'node:zlib'
import { join, dirname, basename } from 'node:path'

/** Existing on-disk format. DB-09 changes the I/O mechanism, not the format. */
const MAGIC = Buffer.from('AURABAK1', 'ascii')

/** Commercial defaults: high enough for large installations, finite before allocation/decompression. */
export const ARCHIVE_LIMITS = Object.freeze({
  // AURABAK1 stores per-entry lengths as uint32. Keep the file cap just above
  // the largest representable database entry plus bounded metadata/config.
  maxArchiveBytes: 5 * 1024 ** 3,
  maxEntries: 3,
  maxNameBytes: 128,
  maxManifestBytes: 1024 ** 2,
  maxConfigBytes: 4 * 1024 ** 2,
  maxDatabaseBytes: 0xffffffff,
  maxCompressionRatio: 10_000
})

const ALLOWED_ENTRIES = new Set(['manifest.json', 'erp.db', 'config/config.json'])

export interface ArchiveEntry { name: string; data: Buffer }
export interface ArchiveFileEntry { name: string; path?: string; data?: Buffer }
export interface ArchiveWriteHooks {
  afterHeader?: () => void
  beforeEntry?: (name: string) => void
  afterCompressedChunk?: (name: string) => void
  beforeFsync?: () => void
}
export interface ExtractedArchive {
  manifest: Buffer
  config?: Buffer
  databaseBytes: number
  databaseSha256: string
}

function entryLimit(name: string): number {
  if (name === 'manifest.json') return ARCHIVE_LIMITS.maxManifestBytes
  if (name === 'config/config.json') return ARCHIVE_LIMITS.maxConfigBytes
  if (name === 'erp.db') return ARCHIVE_LIMITS.maxDatabaseBytes
  throw new Error('النسخة الاحتياطية تحتوي على مدخل غير متوقع')
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Buffer, position: number): Promise<number> {
  let written = 0
  while (written < bytes.length) {
    const result = await handle.write(bytes, written, bytes.length - written, position + written)
    if (result.bytesWritten === 0) throw new Error('تعذر إكمال كتابة النسخة الاحتياطية')
    written += result.bytesWritten
  }
  return position + written
}

/** Incremental SHA-256 with stream backpressure; never retains file contents. */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath, { highWaterMark: 256 * 1024 })) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** Stream AURABAK1 and patch each compressed length after zlib reaches EOF. */
export async function writeArchiveStreaming(
  filePath: string, entries: ArchiveFileEntry[], hooks?: ArchiveWriteHooks
): Promise<void> {
  if (entries.length < 1 || entries.length > ARCHIVE_LIMITS.maxEntries) throw new Error('عدد مداخل النسخة الاحتياطية غير صالح')
  const names = new Set<string>()
  mkdirSync(dirname(filePath), { recursive: true })
  const handle = await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    let position = await writeAll(handle, MAGIC, 0)
    const count = Buffer.alloc(4); count.writeUInt32LE(entries.length)
    position = await writeAll(handle, count, position)
    hooks?.afterHeader?.()
    for (const entry of entries) {
      if (!ALLOWED_ENTRIES.has(entry.name) || names.has(entry.name) || (entry.path === undefined) === (entry.data === undefined)) {
        throw new Error('مدخل النسخة الاحتياطية غير صالح أو مكرر')
      }
      names.add(entry.name)
      hooks?.beforeEntry?.(entry.name)
      const name = Buffer.from(entry.name, 'utf8')
      const rawLength = entry.path ? (await stat(entry.path)).size : (entry.data as Buffer).length
      if (!Number.isSafeInteger(rawLength) || rawLength < 0 || rawLength > entryLimit(entry.name) || rawLength > 0xffffffff) {
        throw new Error('حجم مدخل النسخة الاحتياطية يتجاوز الحد المسموح')
      }
      const header = Buffer.alloc(4 + name.length + 8)
      header.writeUInt32LE(name.length); name.copy(header, 4)
      header.writeUInt32LE(rawLength, 4 + name.length)
      const compressedLengthOffset = position + 8 + name.length
      position = await writeAll(handle, header, position)
      const source = entry.path ? createReadStream(entry.path, { highWaterMark: 256 * 1024 }) : Readable.from(entry.data as Buffer)
      const compressed = source.pipe(createDeflateRaw({ level: 6, chunkSize: 256 * 1024 }))
      const compressedStart = position
      for await (const chunk of compressed) {
        hooks?.afterCompressedChunk?.(entry.name)
        position = await writeAll(handle, chunk as Buffer, position)
        if (position > ARCHIVE_LIMITS.maxArchiveBytes) throw new Error('حجم النسخة الاحتياطية يتجاوز الحد المسموح')
      }
      const compressedLength = position - compressedStart
      if (compressedLength < 1 || compressedLength > 0xffffffff) throw new Error('حجم المدخل المضغوط يتجاوز صيغة AURABAK1')
      const encodedLength = Buffer.alloc(4); encodedLength.writeUInt32LE(compressedLength)
      await writeAll(handle, encodedLength, compressedLengthOffset)
    }
    hooks?.beforeFsync?.()
    await handle.sync()
  } finally { await handle.close() }
}

async function readExact(handle: Awaited<ReturnType<typeof open>>, length: number, position: number): Promise<Buffer> {
  const result = Buffer.alloc(length); let offset = 0
  while (offset < length) {
    const read = await handle.read(result, offset, length - offset, position + offset)
    if (read.bytesRead === 0) throw new Error('النسخة الاحتياطية مبتورة')
    offset += read.bytesRead
  }
  return result
}

async function inflateEntry(
  archivePath: string, start: number, compressedLength: number, rawLength: number, outputPath?: string
): Promise<{ bytes?: Buffer; sha256: string }> {
  if (compressedLength === 0) throw new Error('مدخل النسخة الاحتياطية المضغوط فارغ')
  const hash = createHash('sha256'); const chunks: Buffer[] = []; let actual = 0
  const source = createReadStream(archivePath, { start, end: start + compressedLength - 1, highWaterMark: 256 * 1024 })
  const inflated = source.pipe(createInflateRaw({ chunkSize: 256 * 1024 }))
  const output = outputPath ? await open(outputPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600) : undefined
  try {
    for await (const value of inflated) {
      const chunk = value as Buffer; actual += chunk.length
      if (actual > rawLength) throw new Error('الحجم الفعلي لمدخل النسخة الاحتياطية غير صالح')
      hash.update(chunk)
      if (output) await writeAll(output, chunk, actual - chunk.length)
      else chunks.push(chunk)
    }
    if (actual !== rawLength) throw new Error('النسخة الاحتياطية تالفة أو مبتورة')
    if (output) await output.sync()
    return { bytes: output ? undefined : Buffer.concat(chunks, actual), sha256: hash.digest('hex') }
  } finally { await output?.close() }
}

/** Parse headers before inflation, enforce resource bounds, and stage the DB to disk. */
export async function extractArchiveBounded(archivePath: string, databaseOutputPath: string): Promise<ExtractedArchive> {
  const archiveStat = await stat(archivePath)
  if (!archiveStat.isFile() || archiveStat.size < MAGIC.length + 4 || archiveStat.size > ARCHIVE_LIMITS.maxArchiveBytes) {
    throw new Error('حجم ملف النسخة الاحتياطية غير صالح')
  }
  const handle = await open(archivePath, 'r')
  const descriptors: Array<{ name: string; raw: number; compressed: number; start: number }> = []
  try {
    const prefix = await readExact(handle, MAGIC.length + 4, 0)
    if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('صيغة ملف النسخة الاحتياطية غير صحيحة')
    const count = prefix.readUInt32LE(MAGIC.length)
    if (count < 1 || count > ARCHIVE_LIMITS.maxEntries) throw new Error('عدد مداخل النسخة الاحتياطية غير صالح')
    let position = MAGIC.length + 4; const names = new Set<string>()
    for (let index = 0; index < count; index += 1) {
      const nameLength = (await readExact(handle, 4, position)).readUInt32LE(); position += 4
      if (nameLength < 1 || nameLength > ARCHIVE_LIMITS.maxNameBytes || position + nameLength + 8 > archiveStat.size) throw new Error('اسم مدخل النسخة الاحتياطية غير صالح')
      const metadata = await readExact(handle, nameLength + 8, position)
      const name = metadata.subarray(0, nameLength).toString('utf8')
      const raw = metadata.readUInt32LE(nameLength); const compressed = metadata.readUInt32LE(nameLength + 4)
      position += nameLength + 8
      if (!ALLOWED_ENTRIES.has(name) || names.has(name)) throw new Error('النسخة الاحتياطية تحتوي على مدخل غير متوقع أو مكرر')
      if (raw > entryLimit(name) || compressed < 1 || position + compressed > archiveStat.size) throw new Error('حجم مدخل النسخة الاحتياطية غير صالح')
      if (raw > compressed * ARCHIVE_LIMITS.maxCompressionRatio + 1024 ** 2) throw new Error('نسبة ضغط النسخة الاحتياطية غير آمنة')
      names.add(name); descriptors.push({ name, raw, compressed, start: position }); position += compressed
    }
    if (position !== archiveStat.size) throw new Error('النسخة الاحتياطية تحتوي على بيانات زائدة')
  } finally { await handle.close() }
  const manifestDescriptor = descriptors.find((entry) => entry.name === 'manifest.json')
  const databaseDescriptor = descriptors.find((entry) => entry.name === 'erp.db')
  if (!manifestDescriptor || !databaseDescriptor) throw new Error('الملف لا يحتوي على نسخة قاعدة بيانات صالحة')
  try {
    const manifest = await inflateEntry(archivePath, manifestDescriptor.start, manifestDescriptor.compressed, manifestDescriptor.raw)
    const database = await inflateEntry(archivePath, databaseDescriptor.start, databaseDescriptor.compressed, databaseDescriptor.raw, databaseOutputPath)
    const configDescriptor = descriptors.find((entry) => entry.name === 'config/config.json')
    const config = configDescriptor ? await inflateEntry(archivePath, configDescriptor.start, configDescriptor.compressed, configDescriptor.raw) : undefined
    return { manifest: manifest.bytes as Buffer, config: config?.bytes, databaseBytes: databaseDescriptor.raw, databaseSha256: database.sha256 }
  } catch (error) {
    await rm(databaseOutputPath, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Atomic no-replace publication. A completed name is never overwritten. */
export async function publishArchive(stagingPath: string, finalPath: string): Promise<void> {
  // Hard-link publication is atomic and has no replace semantics. The staging
  // file is adjacent, so supported production filesystems keep this on-volume.
  try {
    await link(stagingPath, finalPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(code ?? '') || existsSync(finalPath)) throw error
    // FAT/exFAT may not support hard links. The app-wide single-instance lock
    // and the immediately preceding no-existing-target check make adjacent
    // rename the compatible atomic fallback.
    await rename(stagingPath, finalPath)
  }
  const directory = await open(dirname(finalPath), 'r')
  try { await directory.sync() } catch (error) {
    if (process.platform !== 'win32') {
      await unlink(finalPath).catch(() => undefined)
      throw error
    }
  }
  finally { await directory.close() }
  await unlink(stagingPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
}

export function backupStagingPath(finalPath: string): string {
  return join(dirname(finalPath), `.${basename(finalPath)}.${randomUUID()}.aurabak-incomplete`)
}

/** Legacy in-memory helpers retained for small compatibility fixtures. */
export function writeArchive(filePath: string, entries: ArchiveEntry[]): void {
  const chunks: Buffer[] = [MAGIC]; const count = Buffer.alloc(4); count.writeUInt32LE(entries.length); chunks.push(count)
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8'); const compressed = deflateRawSync(entry.data)
    const head = Buffer.alloc(4 + name.length + 8); head.writeUInt32LE(name.length); name.copy(head, 4)
    head.writeUInt32LE(entry.data.length, 4 + name.length); head.writeUInt32LE(compressed.length, 8 + name.length); chunks.push(head, compressed)
  }
  mkdirSync(dirname(filePath), { recursive: true }); writeFileSync(filePath, Buffer.concat(chunks))
}

export function readArchive(filePath: string): Map<string, Buffer> {
  if (!existsSync(filePath)) throw new Error('ملف النسخة الاحتياطية غير موجود')
  if (statSync(filePath).size > 512 * 1024 ** 2) throw new Error('استخدم قارئ الأرشيف المتدفق للملفات الكبيرة')
  const buffer = readFileSync(filePath)
  if (buffer.length < MAGIC.length + 4 || !buffer.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('صيغة ملف النسخة الاحتياطية غير صحيحة')
  const entries = new Map<string, Buffer>(); let offset = MAGIC.length; const count = buffer.readUInt32LE(offset); offset += 4
  if (count < 1 || count > ARCHIVE_LIMITS.maxEntries) throw new Error('عدد مداخل النسخة الاحتياطية غير صالح')
  for (let index = 0; index < count; index += 1) {
    if (offset + 4 > buffer.length) throw new Error('النسخة الاحتياطية مبتورة')
    const nameLen = buffer.readUInt32LE(offset); offset += 4
    if (nameLen < 1 || nameLen > ARCHIVE_LIMITS.maxNameBytes || offset + nameLen + 8 > buffer.length) throw new Error('اسم مدخل النسخة الاحتياطية غير صالح')
    const name = buffer.subarray(offset, offset + nameLen).toString('utf8'); offset += nameLen
    if (!ALLOWED_ENTRIES.has(name) || entries.has(name)) throw new Error('النسخة الاحتياطية تحتوي على مدخل غير متوقع أو مكرر')
    const rawLen = buffer.readUInt32LE(offset); offset += 4; const compLen = buffer.readUInt32LE(offset); offset += 4
    if (rawLen > entryLimit(name) || compLen < 1 || offset + compLen > buffer.length) throw new Error('النسخة الاحتياطية مبتورة')
    const data = inflateRawSync(buffer.subarray(offset, offset + compLen), { maxOutputLength: Math.min(entryLimit(name), 512 * 1024 ** 2) }); offset += compLen
    if (data.length !== rawLen) throw new Error('النسخة الاحتياطية تالفة'); entries.set(name, data)
  }
  if (offset !== buffer.length) throw new Error('النسخة الاحتياطية تحتوي على بيانات زائدة')
  return entries
}

export function sha256(data: Buffer): string { return createHash('sha256').update(data).digest('hex') }
export function backupFileName(): string {
  const now = new Date(); const pad = (value: number): string => String(value).padStart(2, '0')
  return `AURA-ERP-Backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.aurabak`
}
export function joinBackupPath(directory: string, fileName: string): string { return join(directory, fileName) }
