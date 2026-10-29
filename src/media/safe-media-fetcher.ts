import { createHash } from 'node:crypto'
import { promises as dns } from 'node:dns'
import { isIP } from 'node:net'
import { request as httpsRequest } from 'node:https'

export type MediaKind = 'image' | 'video' | 'unknown'
export type MediaFetchErrorCategory = 'network' | 'redirect' | 'address' | 'http' | 'size' | 'mime'

export class MediaFetchError extends Error {
  constructor(public readonly category: MediaFetchErrorCategory, public readonly terminal = category !== 'network' && category !== 'http') {
    super('Media fetch failed')
    this.name = 'MediaFetchError'
  }
}

export interface MediaHttpResponse {
  status: number
  headers: Readonly<Record<string, string | undefined>>
  body: AsyncIterable<Uint8Array>
  cancel?: () => void
}

export interface SafeMediaFetcherDependencies {
  resolve(hostname: string): Promise<string[]>
  request(url: URL, address: string, signal: AbortSignal): Promise<MediaHttpResponse>
}

export interface FetchedMedia {
  bytes: Buffer
  checksum: string
  mediaType: SupportedMediaType
}

export type SupportedMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'video/mp4' | 'video/webm'

const supported = new Set<SupportedMediaType>(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm'])

export class SafeMediaFetcher {
  private readonly options: { maxRedirects: number; maxBytes: number; timeoutMs: number }

  constructor(
    private readonly dependencies: SafeMediaFetcherDependencies = defaultDependencies,
    options: Partial<{ maxRedirects: number; maxBytes: number; timeoutMs: number }> = {},
  ) {
    this.options = {
      maxRedirects: bounded(options.maxRedirects ?? 3, 0, 5),
      maxBytes: bounded(options.maxBytes ?? 25 * 1024 * 1024, 1, 100 * 1024 * 1024),
      timeoutMs: bounded(options.timeoutMs ?? 15_000, 100, 120_000),
    }
  }

  async fetch(source: string, expectedKind: MediaKind): Promise<FetchedMedia> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs)
    timeout.unref?.()
    try {
      let current = safeUrl(source)
      for (let redirects = 0; ; redirects += 1) {
        const addresses = await this.resolveSafe(current.hostname)
        let response: MediaHttpResponse
        try {
          response = await this.dependencies.request(current, addresses[0]!, controller.signal)
        } catch (error) {
          if (error instanceof MediaFetchError) throw error
          throw new MediaFetchError('network', false)
        }
        if (isRedirect(response.status)) {
          response.cancel?.()
          if (redirects >= this.options.maxRedirects) throw new MediaFetchError('redirect')
          const location = response.headers.location
          if (!location) throw new MediaFetchError('redirect')
          try { current = safeUrl(new URL(location, current).href) } catch { throw new MediaFetchError('redirect') }
          continue
        }
        if (response.status < 200 || response.status > 299) {
          response.cancel?.()
          throw new MediaFetchError('http', response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429)
        }
        try {
          return await consume(response, expectedKind, this.options.maxBytes)
        } catch (error) {
          response.cancel?.()
          throw error
        }
      }
    } catch (error) {
      if (error instanceof MediaFetchError) throw error
      throw new MediaFetchError(controller.signal.aborted ? 'network' : 'address', false)
    } finally {
      clearTimeout(timeout)
    }
  }

  private async resolveSafe(hostname: string): Promise<string[]> {
    let addresses: string[]
    try { addresses = await this.dependencies.resolve(hostname) } catch { throw new MediaFetchError('address', false) }
    if (addresses.length === 0 || addresses.length > 16 || addresses.some((address) => !isPublicAddress(address))) throw new MediaFetchError('address')
    return [...new Set(addresses)]
  }
}

function safeUrl(source: string): URL {
  let url: URL
  try { url = new URL(source) } catch { throw new MediaFetchError('address') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || isIP(url.hostname) !== 0) {
    throw new MediaFetchError('address')
  }
  if (!url.hostname.includes('.') || url.hostname.length > 253 || url.href.length > 2048) throw new MediaFetchError('address')
  return url
}

async function consume(response: MediaHttpResponse, expectedKind: MediaKind, maxBytes: number): Promise<FetchedMedia> {
  const declared = response.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (!declared || !supported.has(declared as SupportedMediaType)) throw new MediaFetchError('mime')
  const chunks: Buffer[] = []
  let size = 0
  for await (const value of response.body) {
    const chunk = Buffer.from(value)
    size += chunk.length
    if (size > maxBytes) throw new MediaFetchError('size')
    chunks.push(chunk)
  }
  if (size === 0) throw new MediaFetchError('size')
  const bytes = Buffer.concat(chunks, size)
  const sniffed = sniff(bytes)
  if (sniffed !== declared || (expectedKind !== 'unknown' && !sniffed.startsWith(`${expectedKind}/`))) throw new MediaFetchError('mime')
  return { bytes, checksum: createHash('sha256').update(bytes).digest('hex'), mediaType: sniffed }
}

function sniff(bytes: Buffer): SupportedMediaType | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4'
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm'
  return undefined
}

function isRedirect(status: number): boolean { return status === 301 || status === 302 || status === 303 || status === 307 || status === 308 }

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const parts = address.split('.').map(Number)
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
    const value = (((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 + parts[3]!) >>> 0
    const inRange = (base: number, bits: number) => bits === 0 || (value >>> (32 - bits)) === (base >>> (32 - bits))
    const blocked: Array<[number, number]> = [
      [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12],
      [0xc0000000, 24], [0xc0000200, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24],
      [0xe0000000, 4], [0xf0000000, 4], [0xffffffff, 32],
    ]
    return !blocked.some(([base, bits]) => inRange(base, bits))
  }
  if (family === 6) {
    const normalized = address.toLowerCase()
    const secondHextet = normalized.startsWith('2001:') ? Number.parseInt(normalized.split(':')[1] || '0', 16) : Number.NaN
    const documentation3fff = normalized.startsWith('3fff:') && Number.parseInt(normalized.split(':')[1] || '0', 16) <= 0x0fff
    if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized)
      || normalized.startsWith('ff') || normalized.startsWith('2001:db8:') || normalized === '2001:db8::'
      || (Number.isFinite(secondHextet) && secondHextet <= 0x01ff) || normalized.startsWith('2002:') || documentation3fff) return false
    if (normalized.startsWith('::ffff:')) return isPublicAddress(normalized.slice(7))
    return normalized.startsWith('2') || normalized.startsWith('3')
  }
  return false
}

function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('Invalid media fetch configuration')
  return value
}

const defaultDependencies: SafeMediaFetcherDependencies = {
  async resolve(hostname) {
    const [v4, v6] = await Promise.all([
      dns.resolve4(hostname).catch(() => []),
      dns.resolve6(hostname).catch(() => []),
    ])
    return [...v4, ...v6]
  },
  request(url, address, signal) {
    return new Promise((resolve, reject) => {
      const request = httpsRequest(url, {
        method: 'GET', signal, headers: { Accept: 'image/*,video/*', 'User-Agent': 'creative-intelligence-media-mirror/1' },
        lookup: (_hostname, _options, callback) => callback(null, address, isIP(address)),
      }, (incoming) => {
        const headers: Record<string, string | undefined> = {}
        for (const [name, value] of Object.entries(incoming.headers)) headers[name] = Array.isArray(value) ? value[0] : value
        resolve({ status: incoming.statusCode ?? 0, headers, body: incoming, cancel: () => incoming.destroy() })
      })
      request.on('error', reject)
      request.end()
    })
  },
}
