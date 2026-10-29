import { DataIntegrityError, ValidationError } from '../domain/errors.ts'
import { AD_BODY_MAX_LENGTH, type AdMedia, type AdType, type Competitor, type CompetitorAd, type Product } from '../domain/types.ts'
import {
  validateCanonicalHttpsUrl,
  validateCanonicalHttpsUrlArray,
  validateCanonicalText,
  validateCanonicalTextArray,
} from '../domain/validation.ts'
import { attachExactCursorTimestamp } from '../http/pagination.ts'


export function decodeProductRow(value: unknown): Product {
  const row = storedRecord(value, 'product')
  return withCursorTimestamp({
    id: storedIdentifier(row.id, 'product.id'),
    organizationId: storedIdentifier(row.organization_id, 'product.organization_id'),
    name: storedText(row.name, 'product.name', 300, false),
    markets: storedTextArray(row.markets, 'product.markets'),
    platforms: storedPlatforms(row.platforms),
    targetAudiences: storedTextArray(row.target_audiences, 'product.target_audiences'),
    uniqueSellingPoints: storedTextArray(row.unique_selling_points, 'product.unique_selling_points'),
    archivedAt: storedNullableTimestamp(row.archived_at, 'product.archived_at'),
    createdAt: storedTimestamp(row.created_at, 'product.created_at'),
  }, row, 'product')
}

export function decodeCompetitorRow(value: unknown): Competitor {
  const row = storedRecord(value, 'competitor')
  return withCursorTimestamp({
    id: storedIdentifier(row.id, 'competitor.id'),
    organizationId: storedIdentifier(row.organization_id, 'competitor.organization_id'),
    productId: storedIdentifier(row.product_id, 'competitor.product_id'),
    name: storedText(row.name, 'competitor.name', 300, false),
    metaPageUrl: storedNullableHttpsUrl(row.meta_page_url, 'competitor.meta_page_url'),
    archivedAt: storedNullableTimestamp(row.archived_at, 'competitor.archived_at'),
    createdAt: storedTimestamp(row.created_at, 'competitor.created_at'),
  }, row, 'competitor')
}

export function decodeAdRow(value: unknown): CompetitorAd {
  const row = storedRecord(value, 'ad')
  if (row.platform !== 'meta') throw integrity('ad.platform')
  if (typeof row.is_active !== 'boolean') throw integrity('ad.is_active')
  if (typeof row.provider_name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(row.provider_name)) throw integrity('ad.provider_name')
  const impressionsLowerBound = storedNullableNonNegativeNumber(row.impressions_lower_bound, 'ad.impressions_lower_bound')
  const impressionsUpperBound = storedNullableNonNegativeNumber(row.impressions_upper_bound, 'ad.impressions_upper_bound')
  const spendLowerBound = storedNullableNonNegativeNumber(row.spend_lower_bound, 'ad.spend_lower_bound')
  const spendUpperBound = storedNullableNonNegativeNumber(row.spend_upper_bound, 'ad.spend_upper_bound')
  if (impressionsLowerBound !== null && impressionsUpperBound !== null && impressionsLowerBound > impressionsUpperBound) throw integrity('ad.impressions')
  if (spendLowerBound !== null && spendUpperBound !== null && spendLowerBound > spendUpperBound) throw integrity('ad.spend')
  const mirrors = storedMediaMirrors(row.media_mirrors)
  if (row.bookmarked !== undefined && typeof row.bookmarked !== 'boolean') throw integrity('ad.bookmarked')
  const mediaUrls = storedHttpsUrlArray(row.media_urls, 'ad.media_urls')
  const mirroredMediaUrls = mediaUrls.map((_url, position) => mirrorReference(mirrors.get(`legacy:${position}`)))
  return withCursorTimestamp({
    id: storedIdentifier(row.id, 'ad.id'),
    organizationId: storedIdentifier(row.organization_id, 'ad.organization_id'),
    productId: storedIdentifier(row.product_id, 'ad.product_id'),
    competitorId: storedIdentifier(row.competitor_id, 'ad.competitor_id'),
    providerName: storedIdentifier(row.provider_name, 'ad.provider_name', 64),
    platform: row.platform,
    externalId: storedIdentifier(row.external_id, 'ad.external_id'),
    pageId: storedOptionalNullableText(row.page_id, 'ad.page_id', 256),
    advertiserName: storedText(row.advertiser_name, 'ad.advertiser_name', 500, false),
    body: storedText(row.body, 'ad.body', AD_BODY_MAX_LENGTH, true),
    headline: storedOptionalNullableText(row.headline, 'ad.headline', 500),
    description: storedOptionalNullableText(row.description, 'ad.description', 2_000),
    callToAction: storedNullableText(row.call_to_action, 'ad.call_to_action', 100),
    displayFormat: storedOptionalNullableText(row.display_format, 'ad.display_format', 100),
    adType: storedAdType(row.ad_type),
    startedAt: storedTimestamp(row.started_at, 'ad.started_at'),
    endedAt: storedOptionalNullableTimestamp(row.ended_at, 'ad.ended_at'),
    isActive: row.is_active,
    publisherPlatforms: row.publisher_platforms === undefined || row.publisher_platforms === null
      ? null
      : storedTextArray(row.publisher_platforms, 'ad.publisher_platforms', 20, 100),
    impressionsLowerBound,
    impressionsUpperBound,
    spendLowerBound,
    spendUpperBound,
    currency: storedCurrency(row.currency),
    media: storedMedia(row.media, mirrors),
    mediaUrls,
    ...(mirroredMediaUrls.some((reference) => reference !== null) ? { mirroredMediaUrls } : {}),
    sourceUrl: storedHttpsUrl(row.source_url, 'ad.source_url'),
    firstSeenAt: storedTimestamp(row.first_seen_at, 'ad.first_seen_at'),
    lastSeenAt: storedTimestamp(row.last_seen_at, 'ad.last_seen_at'),
    ...(typeof row.bookmarked === 'boolean' ? { bookmarked: row.bookmarked } : {}),
  }, row, 'ad')
}

export function storedTimestamp(value: unknown, field: string): string {
  const date = value instanceof Date ? value : typeof value === 'string' && value.trim() === value ? new Date(value) : undefined
  if (!date || !Number.isFinite(date.valueOf())) throw integrity(field)
  return date.toISOString()
}

function storedNullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : storedTimestamp(value, field)
}

function storedOptionalNullableTimestamp(value: unknown, field: string): string | null {
  return value === undefined || value === null ? null : storedTimestamp(value, field)
}

function storedRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw integrity(field)
  return value as Record<string, unknown>
}

export function storedIdentifier(value: unknown, field: string, max = 256): string {
  const result = storedText(value, field, max, false)
  if (result.trim() !== result) throw integrity(field)
  return result
}

function storedText(value: unknown, field: string, max: number, allowEmpty: boolean): string {
  return asStored(field, () => validateCanonicalText(value, field, { maxLength: max, allowEmpty }))
}

function storedNullableText(value: unknown, field: string, max: number): string | null {
  return value === null ? null : storedText(value, field, max, false)
}

function storedOptionalNullableText(value: unknown, field: string, max: number): string | null {
  return value === undefined || value === null ? null : storedText(value, field, max, false)
}

function storedAdType(value: unknown): AdType | null {
  if (value === undefined || value === null) return null
  if (value !== 'image' && value !== 'video' && value !== 'carousel' && value !== 'text') throw integrity('ad.ad_type')
  return value
}

function storedNullableNonNegativeNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value) ? Number(value) : Number.NaN
  if (!Number.isFinite(parsed) || parsed < 0) throw integrity(field)
  return parsed
}

function storedCurrency(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !/^[A-Z]{3}$/u.test(value)) throw integrity('ad.currency')
  return value
}

function storedMedia(value: unknown, mirrors: ReadonlyMap<string, string>): AdMedia[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.length > 50) throw integrity('ad.media')
  return value.map((item, index) => {
    const media = storedRecord(item, 'ad.media')
    if ((media.kind !== 'image' && media.kind !== 'video') || media.order !== index) throw integrity('ad.media')
    if (media.cardIndex !== null && (!Number.isSafeInteger(media.cardIndex) || (media.cardIndex as number) < 0 || (media.cardIndex as number) > 49)) throw integrity('ad.media')
    const mirroredUrl = mirrorReference(mirrors.get(`structured_source:${index}`))
    const mirroredPosterUrl = mirrorReference(mirrors.get(`structured_poster:${index}`))
    return {
      kind: media.kind,
      sourceUrl: storedHttpsUrl(media.sourceUrl, 'ad.media.sourceUrl'),
      ...(mirroredUrl ? { mirroredUrl } : {}),
      posterUrl: media.posterUrl === null ? null : storedHttpsUrl(media.posterUrl, 'ad.media.posterUrl'),
      ...(mirroredPosterUrl ? { mirroredPosterUrl } : {}),
      cardIndex: media.cardIndex as number | null,
      order: index,
    }
  })
}

function storedMediaMirrors(value: unknown): Map<string, string> {
  const result = new Map<string, string>()
  if (value === undefined || value === null) return result
  if (!Array.isArray(value) || value.length > 150) throw integrity('ad.media_mirrors')
  for (const item of value) {
    const mirror = storedRecord(item, 'ad.media_mirrors')
    const keys = Object.keys(mirror)
    if (keys.length !== 3 || !keys.includes('slotKind') || !keys.includes('position') || !keys.includes('checksum')) throw integrity('ad.media_mirrors')
    if (mirror.slotKind !== 'structured_source' && mirror.slotKind !== 'structured_poster' && mirror.slotKind !== 'legacy') throw integrity('ad.media_mirrors')
    if (!Number.isSafeInteger(mirror.position) || (mirror.position as number) < 0 || (mirror.position as number) > 49) throw integrity('ad.media_mirrors')
    if (typeof mirror.checksum !== 'string' || !/^[a-f0-9]{64}$/u.test(mirror.checksum)) throw integrity('ad.media_mirrors')
    const key = `${mirror.slotKind}:${mirror.position as number}`
    if (result.has(key)) throw integrity('ad.media_mirrors')
    result.set(key, mirror.checksum)
  }
  return result
}

function mirrorReference(checksum: string | undefined): string | null {
  return checksum ? `/media/sha256/${checksum}` : null
}

function storedTextArray(value: unknown, field: string, maxItems = 100, maxItemLength = 500): string[] {
  return asStored(field, () => validateCanonicalTextArray(value, field, { maxItems, maxLength: maxItemLength }))
}

function storedPlatforms(value: unknown): Product['platforms'] {
  const values = storedTextArray(value, 'product.platforms')
  if (values.some((item) => item !== 'ios' && item !== 'android' && item !== 'web')) throw integrity('product.platforms')
  return values as Product['platforms']
}

function withCursorTimestamp<T extends object>(value: T, row: Record<string, unknown>, entity: string): T {
  if (row.cursor_created_at === undefined) return value
  if (typeof row.cursor_created_at !== 'string') throw integrity(`${entity}.cursor_created_at`)
  return attachExactCursorTimestamp(value, row.cursor_created_at)
}

function storedHttpsUrl(value: unknown, field: string): string {
  return asStored(field, () => validateCanonicalHttpsUrl(value, field))
}

function storedNullableHttpsUrl(value: unknown, field: string): string | null {
  return value === null ? null : storedHttpsUrl(value, field)
}

function storedHttpsUrlArray(value: unknown, field: string): string[] {
  return asStored(field, () => validateCanonicalHttpsUrlArray(value, field))
}

function asStored<T>(field: string, validate: () => T): T {
  try {
    return validate()
  } catch (error) {
    if (error instanceof ValidationError) throw integrity(field)
    throw error
  }
}

function integrity(field: string): DataIntegrityError {
  return new DataIntegrityError(`Stored ${field} failed data-integrity validation`)
}
