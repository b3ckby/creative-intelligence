import { DataIntegrityError, ValidationError } from '../domain/errors.ts'
import { AD_BODY_MAX_LENGTH, type Competitor, type CompetitorAd, type Product } from '../domain/types.ts'
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
  return withCursorTimestamp({
    id: storedIdentifier(row.id, 'ad.id'),
    organizationId: storedIdentifier(row.organization_id, 'ad.organization_id'),
    productId: storedIdentifier(row.product_id, 'ad.product_id'),
    competitorId: storedIdentifier(row.competitor_id, 'ad.competitor_id'),
    providerName: storedIdentifier(row.provider_name, 'ad.provider_name', 64),
    platform: row.platform,
    externalId: storedIdentifier(row.external_id, 'ad.external_id'),
    advertiserName: storedText(row.advertiser_name, 'ad.advertiser_name', 500, false),
    body: storedText(row.body, 'ad.body', AD_BODY_MAX_LENGTH, true),
    callToAction: storedNullableText(row.call_to_action, 'ad.call_to_action', 100),
    startedAt: storedTimestamp(row.started_at, 'ad.started_at'),
    isActive: row.is_active,
    mediaUrls: storedHttpsUrlArray(row.media_urls, 'ad.media_urls'),
    sourceUrl: storedHttpsUrl(row.source_url, 'ad.source_url'),
    firstSeenAt: storedTimestamp(row.first_seen_at, 'ad.first_seen_at'),
    lastSeenAt: storedTimestamp(row.last_seen_at, 'ad.last_seen_at'),
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
