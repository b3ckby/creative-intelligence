import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { access, link, lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, normalize, resolve } from 'node:path'

import type { SupportedMediaType } from './safe-media-fetcher.ts'

export interface StoredMedia {
  checksum: string
  byteSize: number
  mediaType: SupportedMediaType
  reference: string
}

export interface MediaStore {
  put(bytes: Buffer, mediaType: SupportedMediaType): Promise<StoredMedia>
  read(checksum: string): Promise<{ bytes: Buffer; byteSize: number; mediaType: SupportedMediaType }>
}

const mediaTypes = new Set<SupportedMediaType>(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm'])

export class LocalContentAddressedMediaStore implements MediaStore {
  private readonly root: string

  constructor(root: string) {
    if (!isAbsolute(root) || normalize(root) !== root || root.length > 4096) throw new Error('Invalid media storage root')
    this.root = resolve(root)
  }

  async ready(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const [actual, info] = await Promise.all([realpath(this.root), lstat(this.root)])
    if (actual !== this.root || !info.isDirectory() || info.isSymbolicLink()) throw new Error('Media storage root is unsafe')
    const probe = join(this.root, `.write-probe-${randomBytes(12).toString('hex')}`)
    const handle = await open(probe, 'wx', 0o600)
    await handle.close()
    await rm(probe, { force: true })
  }

  async put(bytes: Buffer, mediaType: SupportedMediaType): Promise<StoredMedia> {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 100 * 1024 * 1024 || !mediaTypes.has(mediaType)) throw new Error('Invalid media object')
    const checksum = createHash('sha256').update(bytes).digest('hex')
    const { data, metadata, directory } = paths(this.root, checksum)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await atomicCreate(data, bytes)
    const metadataValue = Buffer.from(JSON.stringify({ mediaType, byteSize: bytes.length }), 'utf8')
    try {
      await atomicCreate(metadata, metadataValue)
    } catch (error) {
      const existing = await readMetadata(metadata).catch(() => undefined)
      if (!existing || existing.mediaType !== mediaType || existing.byteSize !== bytes.length) throw new Error('Media metadata conflict')
      if (!(error instanceof Error)) throw error
    }
    const existing = await readMetadata(metadata)
    if (existing.mediaType !== mediaType || existing.byteSize !== bytes.length) throw new Error('Media metadata conflict')
    return { checksum, byteSize: bytes.length, mediaType, reference: `/media/sha256/${checksum}` }
  }

  async read(checksum: string): Promise<{ bytes: Buffer; byteSize: number; mediaType: SupportedMediaType }> {
    validateChecksum(checksum)
    const { data, metadata } = paths(this.root, checksum)
    const [bytes, stored] = await Promise.all([readFile(data), readMetadata(metadata)])
    if (bytes.length !== stored.byteSize || createHash('sha256').update(bytes).digest('hex') !== checksum) throw new Error('Stored media failed integrity validation')
    return { bytes, mediaType: stored.mediaType, byteSize: stored.byteSize }
  }
}

async function atomicCreate(destination: string, value: Buffer): Promise<void> {
  try {
    await access(destination, constants.F_OK)
    const existing = await readFile(destination)
    if (!existing.equals(value)) throw new Error('Media object conflict')
    return
  } catch (error) {
    if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) throw error
  }
  const temporary = `${destination}.tmp-${randomBytes(12).toString('hex')}`
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(value)
    await handle.sync()
    await handle.close()
    handle = undefined
    try { await link(temporary, destination) } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      const existing = await readFile(destination)
      if (!existing.equals(value)) throw new Error('Media object conflict')
    }
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function readMetadata(path: string): Promise<{ mediaType: SupportedMediaType; byteSize: number }> {
  let value: unknown
  try { value = JSON.parse(await readFile(path, 'utf8')) } catch { throw new Error('Stored media metadata is invalid') }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Stored media metadata is invalid')
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 2 || !mediaTypes.has(record.mediaType as SupportedMediaType)
    || !Number.isSafeInteger(record.byteSize) || (record.byteSize as number) < 1 || (record.byteSize as number) > 100 * 1024 * 1024) {
    throw new Error('Stored media metadata is invalid')
  }
  return { mediaType: record.mediaType as SupportedMediaType, byteSize: record.byteSize as number }
}

function paths(root: string, checksum: string): { data: string; metadata: string; directory: string } {
  validateChecksum(checksum)
  const directory = join(root, 'sha256', checksum.slice(0, 2))
  return { directory, data: join(directory, checksum), metadata: join(directory, `${checksum}.json`) }
}

function validateChecksum(checksum: string): void {
  if (!/^[a-f0-9]{64}$/u.test(checksum)) throw new Error('Invalid media checksum')
}
