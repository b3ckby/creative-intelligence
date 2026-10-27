import type { AdCollectionContext, AdSourceProvider, CollectedAd } from '../ad-ingestion/ad-source-provider.ts'
import { AD_BODY_MAX_LENGTH, type Competitor, type CompetitorAd, type Product } from '../domain/types.ts'
import { validateIdentifier } from '../domain/identifiers.ts'
import { validatePageLimit } from '../domain/page-limit.ts'
import {
  validateCanonicalHttpsUrl,
  validateCanonicalHttpsUrlArray,
  validateCanonicalText,
} from '../domain/validation.ts'

export interface AdRepository {
  /** Atomically validates uniqueness and saves the complete batch. */
  saveBatch(ads: readonly CompetitorAd[]): void
  findByProviderKey(organizationId: string, providerName: string, platform: string, externalId: string): CompetitorAd | undefined
  listForCompetitor(organizationId: string, competitorId: string, limit: number): CompetitorAd[]
  findById(organizationId: string, id: string): CompetitorAd | undefined
}

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
          callToAction: item.callToAction,
          startedAt: item.startedAt,
          isActive: item.isActive,
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
        advertiserName: item.advertiserName,
        body: item.body,
        callToAction: item.callToAction,
        startedAt: item.startedAt,
        isActive: item.isActive,
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

export function validateCollectedAd(value: unknown): CollectedAd {
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

  return {
    platform: 'meta',
    externalId,
    advertiserName,
    body,
    callToAction,
    startedAt: startedAt.toISOString(),
    isActive: value.isActive,
    mediaUrls,
    sourceUrl,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
