import { ConflictError } from '../domain/errors.ts'
import type { AdCollectionContext, AdSourceProvider, CollectedAd, CollectedAdMedia } from './ad-source-provider.ts'

export const APIFY_META_ADS_ACTOR_ID = 'curious_coder~facebook-ads-library-scraper'
const APIFY_ENDPOINT = `https://api.apify.com/v2/acts/${APIFY_META_ADS_ACTOR_ID}/run-sync-get-dataset-items`
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_ACTOR_ITEMS = 130

export interface ApifyMetaAdsProviderConfig {
  apiToken: string
  facebookPageUrl: string
  limit?: number
  activeStatus?: 'all' | 'active' | 'inactive'
  countryCode?: string
  timeoutMs?: number
  maxResponseBytes?: number
}

export interface ApifyMetaAdsProviderDependencies {
  fetch?: typeof globalThis.fetch
  gate?: ApifyRequestGate
  beforeActorStart?: (signal: AbortSignal) => Promise<void>
}

export class ApifyRequestGate {
  private active = 0
  private readonly waiting: Array<{ resolve: () => void; reject: (error: Error) => void; signal: AbortSignal; onAbort: () => void }> = []

  constructor(private readonly maximum: number, private readonly maximumQueue = maximum * 2) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 10) throw new Error('Apify request concurrency is invalid')
    if (!Number.isSafeInteger(maximumQueue) || maximumQueue < 0 || maximumQueue > 100) throw new Error('Apify request queue is invalid')
  }

  async run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    await this.acquire(signal)
    try { return await abortable(task(), signal) } finally { this.release() }
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('request aborted')
    if (this.active < this.maximum) {
      this.active += 1
      return
    }
    if (this.waiting.length >= this.maximumQueue) throw new Error('request queue full')
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.waiting.indexOf(waiter)
          if (index >= 0) this.waiting.splice(index, 1)
          reject(new Error('request aborted'))
        },
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      this.waiting.push(waiter)
    })
  }

  private release(): void {
    const waiter = this.waiting.shift()
    if (waiter) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      waiter.resolve()
      return
    }
    this.active -= 1
  }
}

export class ApifyMetaAdsProvider implements AdSourceProvider {
  private readonly apiToken: string
  private readonly facebookPageUrl: string
  private readonly limit: number
  private readonly activeStatus: 'all' | 'active' | 'inactive'
  private readonly countryCode: string
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number
  private readonly fetch: typeof globalThis.fetch
  private readonly gate: ApifyRequestGate
  private readonly beforeActorStart: (signal: AbortSignal) => Promise<void>

  constructor(config: ApifyMetaAdsProviderConfig, dependencies: ApifyMetaAdsProviderDependencies = {}) {
    this.apiToken = secret(config.apiToken)
    this.facebookPageUrl = normalizeFacebookPageUrl(config.facebookPageUrl)
    this.limit = boundedInteger(config.limit ?? 100, 10, 100)
    this.activeStatus = activeStatus(config.activeStatus ?? 'all')
    this.countryCode = countryCode(config.countryCode ?? 'ALL')
    this.timeoutMs = boundedInteger(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, 120_000)
    this.maxResponseBytes = boundedInteger(config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, 1_000, 16 * 1024 * 1024)
    this.fetch = dependencies.fetch ?? globalThis.fetch
    this.gate = dependencies.gate ?? new ApifyRequestGate(1)
    this.beforeActorStart = dependencies.beforeActorStart ?? (async () => undefined)
  }

  async collect(_context: Readonly<AdCollectionContext>): Promise<CollectedAd[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await this.gate.run(async () => {
        await this.beforeActorStart(controller.signal)
        if (controller.signal.aborted) throw new Error('request aborted')
        const response = await this.fetch(APIFY_ENDPOINT, {
          method: 'POST',
          redirect: 'error',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            count: this.limit,
            scrapeAdDetails: true,
            'scrapePageAds.activeStatus': this.activeStatus,
            'scrapePageAds.countryCode': this.countryCode,
            urls: [{ url: this.facebookPageUrl, method: 'GET' }],
          }),
          signal: controller.signal,
        })
        if (!response.ok) {
          cancelResponseBody(response)
          throw new Error('bad status')
        }
        const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
        if (contentType !== 'application/json') {
          cancelResponseBody(response)
          throw new Error('bad content type')
        }
        const payload = await readBoundedJson(response, this.maxResponseBytes, controller.signal)
        if (!Array.isArray(payload) || payload.length > MAX_ACTOR_ITEMS) throw new Error('bad payload')
        const items = payload.map(parseActorRecord)
        const seen = new Set<string>()
        for (const item of items) {
          if (seen.has(item.externalId)) throw new Error('duplicate ad id')
          seen.add(item.externalId)
        }
        return items
      }, controller.signal)
    } catch (error) {
      if (error instanceof ConflictError) throw error
      throw new Error('Apify provider request failed')
    } finally {
      clearTimeout(timer)
    }
  }
}

export function normalizeFacebookPageUrl(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || /[\u0000-\u0020\u007f-\u009f]/u.test(value)) {
    throw new Error('Facebook page URL is invalid')
  }
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error('Facebook page URL is invalid') }
  const hostname = parsed.hostname.toLowerCase()
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || !(hostname === 'facebook.com' || hostname.endsWith('.facebook.com'))) {
    throw new Error('Facebook page URL is invalid')
  }
  const path = parsed.pathname.replace(/\/+$/u, '') || '/'
  const segments = path.split('/').filter(Boolean)
  let pageId: string | undefined
  if (path.toLowerCase() === '/profile.php') {
    if ([...parsed.searchParams.keys()].some((key) => key !== 'id')) throw new Error('Facebook page URL is invalid')
    const candidate = parsed.searchParams.get('id')
    if (candidate && /^\d{6,}$/u.test(candidate)) pageId = candidate
  } else {
    if (parsed.search) throw new Error('Facebook page URL is invalid')
    const first = segments[0]?.toLowerCase()
    if (first === 'p' && segments[1]) pageId = segments[1].match(/-(\d{6,})$/u)?.[1]
    if (first === 'people') pageId = segments.find((segment) => /^\d{6,}$/u.test(segment))
    if (segments.length === 1 && /^\d{8,}$/u.test(segments[0] ?? '')) pageId = segments[0]
  }
  if (pageId) return `https://www.facebook.com/profile.php?id=${pageId}`
  if (parsed.search || segments.length !== 1 || !/^[A-Za-z0-9._-]{1,100}$/u.test(segments[0] ?? '')) throw new Error('Facebook page URL is invalid')
  return `https://www.facebook.com/${segments[0]}`
}

async function readBoundedJson(response: Response, maximumBytes: number, signal: AbortSignal): Promise<unknown> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)) {
    cancelResponseBody(response)
    throw new Error('response too large')
  }
  if (!response.body) throw new Error('response body missing')
  const reader = response.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => undefined) }
  if (signal.aborted) {
    cancel()
    reader.releaseLock()
    throw new Error('request aborted')
  }
  signal.addEventListener('abort', cancel, { once: true })
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal)
      if (done) break
      length += value.byteLength
      if (length > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error('response too large')
      }
      chunks.push(value)
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
  const joined = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)) as unknown
}

function cancelResponseBody(response: Response): void {
  if (response.body && !response.body.locked) void response.body.cancel().catch(() => undefined)
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('request aborted')
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('request aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

function parseActorRecord(value: unknown): CollectedAd {
  const record = object(value)
  const snapshot = object(record.snapshot)
  const bodyRecord = optionalObject(snapshot.body)
  const body = boundedText(bodyRecord?.text ?? firstCardText(snapshot.cards, 'body') ?? '', 20_000, true)
  const media = collectMedia(snapshot)
  const mediaUrls = collectMediaUrls(snapshot)
  if (body.length === 0 && mediaUrls.length === 0) throw new Error('missing creative')
  const externalId = boundedText(record.ad_archive_id, 256)
  const sourceUrl = record.ad_library_url === undefined
    ? `https://www.facebook.com/ads/library/?id=${encodeURIComponent(externalId)}`
    : httpsUrl(record.ad_library_url)
  if (typeof record.is_active !== 'boolean') throw new Error('bad active status')
  const impressions = optionalObject(record.impressions)
  const spend = optionalObject(record.spend)
  const startedAt = actorTimestamp(record.start_date, record.start_date_formatted)
  const endedAt = optionalActorTimestamp(record.end_date, record.end_date_formatted)
  if (endedAt !== null && endedAt < startedAt) throw new Error('bad timestamp order')
  return {
    platform: 'meta',
    externalId,
    pageId: optionalText(record.page_id, 256),
    advertiserName: boundedText(record.page_name, 500),
    body,
    headline: optionalText(snapshot.title ?? firstCardText(snapshot.cards, 'title'), 500),
    description: optionalText(snapshot.link_description ?? firstCardText(snapshot.cards, 'link_description'), 2_000),
    callToAction: snapshot.cta_text === undefined || snapshot.cta_text === null ? null : boundedText(snapshot.cta_text, 100),
    displayFormat: optionalText(snapshot.display_format, 100),
    adType: adType(snapshot, media),
    startedAt,
    endedAt,
    isActive: record.is_active,
    publisherPlatforms: optionalTextArray(record.publisher_platform, 20, 100),
    impressionsLowerBound: optionalNonNegativeNumber(impressions?.lower_bound),
    impressionsUpperBound: optionalNonNegativeNumber(impressions?.upper_bound),
    spendLowerBound: optionalNonNegativeNumber(spend?.lower_bound),
    spendUpperBound: optionalNonNegativeNumber(spend?.upper_bound),
    currency: optionalCurrency(spend?.currency ?? record.currency),
    media,
    mediaUrls,
    sourceUrl,
  }
}

function collectMedia(snapshot: Record<string, unknown>): CollectedAdMedia[] {
  const media: CollectedAdMedia[] = []
  const append = (kind: 'image' | 'video', source: unknown, poster: unknown, cardIndex: number | null) => {
    if (source === undefined || source === null) return
    const sourceUrl = httpsUrl(source)
    if (media.some((item) => item.sourceUrl === sourceUrl && item.cardIndex === cardIndex && item.kind === kind)) return
    media.push({
      kind,
      sourceUrl,
      posterUrl: poster === undefined || poster === null ? null : httpsUrl(poster),
      cardIndex,
      order: media.length,
    })
    if (media.length > 50) throw new Error('too many media items')
  }
  for (const image of optionalObjectArray(snapshot.images, 50)) {
    append('image', image.original_image_url ?? image.resized_image_url ?? image.url, null, null)
  }
  for (const video of optionalObjectArray(snapshot.videos, 50)) {
    append('video', video.video_hd_url ?? video.video_sd_url, video.video_preview_image_url, null)
  }
  optionalObjectArray(snapshot.cards, 50).forEach((card, index) => {
    const videoUrl = card.video_hd_url ?? card.video_sd_url
    if (videoUrl !== undefined && videoUrl !== null) append('video', videoUrl, card.video_preview_image_url, index)
    else append('image', card.original_image_url ?? card.resized_image_url, null, index)
  })
  return media
}

function adType(snapshot: Record<string, unknown>, media: readonly CollectedAdMedia[]): 'image' | 'video' | 'carousel' | 'text' {
  const format = typeof snapshot.display_format === 'string' ? snapshot.display_format.toLowerCase() : ''
  if (format.includes('carousel') || optionalObjectArray(snapshot.cards, 50).length > 1) return 'carousel'
  if (media.some((item) => item.kind === 'video') || format.includes('video')) return 'video'
  if (media.some((item) => item.kind === 'image') || format.includes('image')) return 'image'
  return 'text'
}

function collectMediaUrls(snapshot: Record<string, unknown>): string[] {
  const candidates: unknown[] = []
  for (const image of optionalObjectArray(snapshot.images, 50)) candidates.push(image.original_image_url, image.resized_image_url, image.url)
  for (const video of optionalObjectArray(snapshot.videos, 50)) candidates.push(video.video_hd_url, video.video_sd_url, video.video_preview_image_url)
  for (const card of optionalObjectArray(snapshot.cards, 50)) candidates.push(card.original_image_url, card.resized_image_url, card.video_hd_url, card.video_sd_url, card.video_preview_image_url)
  const urls: string[] = []
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue
    const url = httpsUrl(candidate)
    if (!urls.includes(url)) urls.push(url)
    if (urls.length > 50) throw new Error('too many media urls')
  }
  return urls
}

function firstCardText(value: unknown, key: string): unknown {
  return optionalObjectArray(value, 50)[0]?.[key]
}

function actorTimestamp(epochValue: unknown, formattedValue: unknown): string {
  let date: Date
  if (typeof epochValue === 'number' && Number.isSafeInteger(epochValue) && epochValue >= 0) date = new Date(epochValue * 1_000)
  else if (typeof formattedValue === 'string') date = new Date(formattedValue)
  else throw new Error('bad timestamp')
  if (!Number.isFinite(date.getTime())) throw new Error('bad timestamp')
  return date.toISOString()
}

function optionalActorTimestamp(epochValue: unknown, formattedValue: unknown): string | null {
  if ((epochValue === undefined || epochValue === null) && (formattedValue === undefined || formattedValue === null)) return null
  return actorTimestamp(epochValue, formattedValue)
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('bad object')
  return value as Record<string, unknown>
}
function optionalObject(value: unknown): Record<string, unknown> | undefined { return value === undefined || value === null ? undefined : object(value) }
function optionalObjectArray(value: unknown, maximum: number): Array<Record<string, unknown>> {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > maximum) throw new Error('bad array')
  return value.map(object)
}
function boundedText(value: unknown, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value !== value.trim() || [...value].length > maximum || (!allowEmpty && value.length === 0) || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error('bad text')
  return value
}
function optionalText(value: unknown, maximum: number): string | null {
  return value === undefined || value === null ? null : boundedText(value, maximum)
}
function optionalTextArray(value: unknown, maximum: number, maximumItemLength: number): string[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.length > maximum) throw new Error('bad array')
  const result = value.map((item) => boundedText(item, maximumItemLength))
  if (new Set(result).size !== result.length) throw new Error('duplicate array item')
  return result
}
function optionalNonNegativeNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const result = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value) ? Number(value) : Number.NaN
  if (!Number.isFinite(result) || result < 0) throw new Error('bad number')
  return result
}
function optionalCurrency(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !/^[A-Z]{3}$/u.test(value)) throw new Error('bad currency')
  return value
}
function httpsUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048 || value !== value.trim() || /[\u0000-\u0020\u007f-\u009f]/u.test(value)) throw new Error('bad url')
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error('bad url') }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.hash) throw new Error('bad url')
  return value
}
function secret(value: unknown): string {
  if (typeof value !== 'string' || value.length < 10 || value.length > 4_096 || /[\s\p{Cc}\p{Cf}]/u.test(value)) throw new Error('Apify provider configuration is invalid')
  return value
}
function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error('Apify provider configuration is invalid')
  return value as number
}
function activeStatus(value: unknown): 'all' | 'active' | 'inactive' {
  if (value !== 'all' && value !== 'active' && value !== 'inactive') throw new Error('Apify provider configuration is invalid')
  return value
}
function countryCode(value: unknown): string {
  if (typeof value !== 'string' || (value !== 'ALL' && !/^[A-Z]{2}$/u.test(value))) throw new Error('Apify provider configuration is invalid')
  return value
}
