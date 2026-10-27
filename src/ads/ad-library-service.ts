import type { AdCollectionContext, AdSourceProvider, CollectedAd } from '../ad-ingestion/ad-source-provider.ts'
import { AD_BODY_MAX_LENGTH, type Competitor, type CompetitorAd, type Product } from '../domain/types.ts'
import { validateIdentifier } from '../domain/identifiers.ts'
import { validatePageLimit } from '../domain/page-limit.ts'
import {
  validateCanonicalHttpsUrl,
  validateCanonicalHttpsUrlArray,
  validateCanonicalText,
  validateCanonicalTextArray,
} from '../domain/validation.ts'

export interface AdRepository {
  /** Atomically validates uniqueness and saves the complete batch. */
  saveBatch(ads: readonly CompetitorAd[]): void
  findByProviderKey(organizationId: string, providerName: string, platform: string, externalId: string): CompetitorAd | undefined
  listForCompetitor(organizationId: string, competitorId: string, limit: number): CompetitorAd[]
  findById(organizationId: string, id: string): CompetitorAd | undefined
}

type ExpandedCollectedAdFields = 'pageId' | 'headline' | 'description' | 'displayFormat' | 'adType' | 'endedAt'
  | 'publisherPlatforms' | 'impressionsLowerBound' | 'impressionsUpperBound' | 'spendLowerBound'
  | 'spendUpperBound' | 'currency' | 'media'
type ValidatedCollectedAd = CollectedAd & Required<Pick<CollectedAd, ExpandedCollectedAdFields>>

interface ProductLookup {
  findById(id: string): Product | undefined
}

interface CompetitorLookup {
  findById(id: string): Competitor | undefined
}

export class AdLibraryService {
  constructor(
    private readonly repository: AdRepository,
    private readonly products: ProductLookup,
    private readonly competitors: CompetitorLookup,
    private readonly now: () => Date,
    private readonly createId: () => string,
    private readonly providers: ReadonlyMap<string, AdSourceProvider>,
  ) {}

  async collect(providerNameInput: string, contextInput: AdCollectionContext): Promise<{ inserted: number; duplicates: number }> {
    const providerName = validateProviderName(providerNameInput)
    const provider = this.providers.get(providerName)
    if (!provider) throw new Error('Ad source provider is not registered')

    const context: Readonly<AdCollectionContext> = Object.freeze({
      organizationId: validateIdentifier(contextInput.organizationId, 'Organization ID'),
      productId: validateIdentifier(contextInput.productId, 'Product ID'),
      competitorId: validateIdentifier(contextInput.competitorId, 'Competitor ID'),
    })
    const product = this.products.findById(context.productId)
    const competitor = this.competitors.findById(context.competitorId)
    if (!product || product.organizationId !== context.organizationId) throw new Error('Product does not belong to organization')
    if (!competitor || competitor.organizationId !== context.organizationId || competitor.productId !== product.id) {
      throw new Error('Competitor does not belong to product')
    }

    const collected: unknown = await provider.collect(context)
    if (!Array.isArray(collected) || collected.length > 1_000) throw new Error('Provider returned an invalid ad batch')
    const items = collected.map(validateCollectedAd)
    const batchKeys: Array<Pick<CollectedAd, 'platform' | 'externalId'>> = []
    for (const item of items) {
      if (batchKeys.some((key) => key.platform === item.platform && key.externalId === item.externalId)) {
        throw new Error('Provider returned duplicate ad IDs in one batch')
      }
      batchKeys.push({ platform: item.platform, externalId: item.externalId })
    }

    let inserted = 0
    let duplicates = 0
    const seenAt = this.now().toISOString()
    const pending: CompetitorAd[] = []

    for (const item of items) {
      const existing = this.repository.findByProviderKey(
        context.organizationId,
        providerName,
        item.platform,
        item.externalId,
      )
      if (existing) {
        if (existing.productId !== product.id || existing.competitorId !== competitor.id) {
          throw new Error('Provider ad ID already belongs to another product or competitor')
        }
        pending.push({
          ...existing,
          advertiserName: item.advertiserName,
          body: item.body,
          pageId: item.pageId,
          headline: item.headline,
          description: item.description,
          callToAction: item.callToAction,
          displayFormat: item.displayFormat,
          adType: item.adType,
          startedAt: item.startedAt,
          endedAt: item.endedAt,
          isActive: item.isActive,
          publisherPlatforms: item.publisherPlatforms === null ? null : [...item.publisherPlatforms],
          impressionsLowerBound: item.impressionsLowerBound,
          impressionsUpperBound: item.impressionsUpperBound,
          spendLowerBound: item.spendLowerBound,
          spendUpperBound: item.spendUpperBound,
          currency: item.currency,
          media: item.media === null ? null : structuredClone(item.media),
          mediaUrls: [...item.mediaUrls],
          sourceUrl: item.sourceUrl,
          lastSeenAt: seenAt,
        })
        duplicates += 1
        continue
      }
      pending.push({
        id: validateIdentifier(this.createId(), 'Generated ID'),
        organizationId: context.organizationId,
        productId: product.id,
        competitorId: competitor.id,
        providerName,
        platform: item.platform,
        externalId: item.externalId,
        pageId: item.pageId,
        advertiserName: item.advertiserName,
        body: item.body,
        headline: item.headline,
        description: item.description,
        callToAction: item.callToAction,
        displayFormat: item.displayFormat,
        adType: item.adType,
        startedAt: item.startedAt,
        endedAt: item.endedAt,
        isActive: item.isActive,
        publisherPlatforms: item.publisherPlatforms === null ? null : [...item.publisherPlatforms],
        impressionsLowerBound: item.impressionsLowerBound,
        impressionsUpperBound: item.impressionsUpperBound,
        spendLowerBound: item.spendLowerBound,
        spendUpperBound: item.spendUpperBound,
        currency: item.currency,
        media: item.media === null ? null : structuredClone(item.media),
        mediaUrls: [...item.mediaUrls],
        sourceUrl: item.sourceUrl,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      })
      inserted += 1
    }

    this.repository.saveBatch(pending)
    return { inserted, duplicates }
  }

  listForCompetitor(organizationIdInput: string, competitorIdInput: string, limitInput: number): CompetitorAd[] {
    const limit = validatePageLimit(limitInput)
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const competitorId = validateIdentifier(competitorIdInput, 'Competitor ID')
    return this.repository.listForCompetitor(organizationId, competitorId, limit)
  }

  findById(organizationId: string, id: string): CompetitorAd | undefined {
    return this.repository.findById(organizationId, id)
  }
}

function validateProviderName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw new Error('Provider name is invalid')
  }
  return value
}

export function validateCollectedAd(value: unknown): ValidatedCollectedAd {
  if (!isRecord(value)) throw new Error('Provider returned an invalid ad')
  if (value.platform !== 'meta') throw new Error('Provider ad platform is invalid')

  const externalId = validateIdentifier(value.externalId, 'Provider ad externalId')
  const advertiserName = validateCanonicalText(value.advertiserName, 'Provider ad advertiserName', { maxLength: 500 })
  const body = validateCanonicalText(value.body, 'Provider ad body', { maxLength: AD_BODY_MAX_LENGTH, allowEmpty: true })
  const callToAction = value.callToAction === null
    ? null
    : validateCanonicalText(value.callToAction, 'Provider ad callToAction', { maxLength: 100 })
  const sourceUrl = validateCanonicalHttpsUrl(value.sourceUrl, 'Provider ad sourceUrl')
  const startedAtValue = validateCanonicalText(value.startedAt, 'Provider ad startedAt', { maxLength: 100 })
  const startedAt = new Date(startedAtValue)
  if (Number.isNaN(startedAt.valueOf())) throw new Error('Provider ad startedAt is invalid')
  if (typeof value.isActive !== 'boolean') throw new Error('Provider ad isActive is invalid')
  const mediaUrls = validateCanonicalHttpsUrlArray(value.mediaUrls, 'Provider ad mediaUrls')
  if (!body && mediaUrls.length === 0) throw new Error('Provider ad body or media is required')
  const pageId = nullableText(value.pageId, 'Provider ad pageId', 256)
  const headline = nullableText(value.headline, 'Provider ad headline', 500)
  const description = nullableText(value.description, 'Provider ad description', 2_000)
  const displayFormat = nullableText(value.displayFormat, 'Provider ad displayFormat', 100)
  const endedAt = nullableTimestamp(value.endedAt, 'Provider ad endedAt')
  const publisherPlatforms = value.publisherPlatforms === undefined || value.publisherPlatforms === null
    ? null
    : validateCanonicalTextArray(value.publisherPlatforms, 'Provider ad publisherPlatforms', { maxItems: 20, maxLength: 100 })
  const impressionsLowerBound = nullableNonNegativeNumber(value.impressionsLowerBound, 'Provider ad impressionsLowerBound')
  const impressionsUpperBound = nullableNonNegativeNumber(value.impressionsUpperBound, 'Provider ad impressionsUpperBound')
  const spendLowerBound = nullableNonNegativeNumber(value.spendLowerBound, 'Provider ad spendLowerBound')
  const spendUpperBound = nullableNonNegativeNumber(value.spendUpperBound, 'Provider ad spendUpperBound')
  ensureOrderedBounds(impressionsLowerBound, impressionsUpperBound, 'Provider ad impressions')
  ensureOrderedBounds(spendLowerBound, spendUpperBound, 'Provider ad spend')
  const currency = nullableCurrency(value.currency)
  const media = validateMedia(value.media)
  const adType = validateAdType(value.adType, media, mediaUrls)

  return {
    platform: 'meta',
    externalId,
    pageId,
    advertiserName,
    body,
    headline,
    description,
    callToAction,
    displayFormat,
    adType,
    startedAt: startedAt.toISOString(),
    endedAt,
    isActive: value.isActive,
    publisherPlatforms,
    impressionsLowerBound,
    impressionsUpperBound,
    spendLowerBound,
    spendUpperBound,
    currency,
    media,
    mediaUrls,
    sourceUrl,
  }
}

function nullableText(value: unknown, field: string, maxLength: number): string | null {
  return value === undefined || value === null ? null : validateCanonicalText(value, field, { maxLength })
}

function nullableTimestamp(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  const text = validateCanonicalText(value, field, { maxLength: 100 })
  const date = new Date(text)
  if (Number.isNaN(date.valueOf())) throw new Error(`${field} is invalid`)
  return date.toISOString()
}

function nullableNonNegativeNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${field} is invalid`)
  return value
}

function ensureOrderedBounds(lower: number | null, upper: number | null, field: string): void {
  if (lower !== null && upper !== null && lower > upper) throw new Error(`${field} bounds are invalid`)
}

function nullableCurrency(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !/^[A-Z]{3}$/u.test(value)) throw new Error('Provider ad currency is invalid')
  return value
}

function validateMedia(value: unknown): NonNullable<CollectedAd['media']> | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.length > 50) throw new Error('Provider ad media is invalid')
  return value.map((item, index) => {
    if (!isRecord(item) || (item.kind !== 'image' && item.kind !== 'video') || item.order !== index) throw new Error('Provider ad media is invalid')
    if (item.cardIndex !== null && (!Number.isSafeInteger(item.cardIndex) || (item.cardIndex as number) < 0 || (item.cardIndex as number) > 49)) {
      throw new Error('Provider ad media is invalid')
    }
    return {
      kind: item.kind,
      sourceUrl: validateCanonicalHttpsUrl(item.sourceUrl, 'Provider ad media sourceUrl'),
      posterUrl: item.posterUrl === null ? null : validateCanonicalHttpsUrl(item.posterUrl, 'Provider ad media posterUrl'),
      cardIndex: item.cardIndex as number | null,
      order: index,
    }
  })
}

function validateAdType(value: unknown, _media: NonNullable<CollectedAd['media']> | null, _mediaUrls: readonly string[]): NonNullable<CollectedAd['adType']> | null {
  if (value !== undefined && value !== null) {
    if (value !== 'image' && value !== 'video' && value !== 'carousel' && value !== 'text') throw new Error('Provider ad adType is invalid')
    return value
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
