import type { AdPlatform } from '../domain/types.ts'

export interface AdCollectionContext {
  readonly organizationId: string
  readonly productId: string
  readonly competitorId: string
}

export interface CollectedAd {
  platform: AdPlatform
  externalId: string
  pageId?: string | null
  advertiserName: string
  body: string
  headline?: string | null
  description?: string | null
  callToAction: string | null
  displayFormat?: string | null
  adType?: 'image' | 'video' | 'carousel' | 'text' | null
  startedAt: string
  endedAt?: string | null
  isActive: boolean
  publisherPlatforms?: string[] | null
  impressionsLowerBound?: number | null
  impressionsUpperBound?: number | null
  spendLowerBound?: number | null
  spendUpperBound?: number | null
  currency?: string | null
  media?: CollectedAdMedia[] | null
  mediaUrls: string[]
  sourceUrl: string
}

export interface CollectedAdMedia {
  kind: 'image' | 'video'
  sourceUrl: string
  posterUrl: string | null
  cardIndex: number | null
  order: number
}

export interface AdCollectionSnapshot {
  readonly items: CollectedAd[]
  readonly completeness: 'complete' | 'partial'
  /** Canonical bounded identity for every upstream population filter. */
  readonly scopeKey?: string
}

export interface AdSourceProvider {
  /** Backwards-compatible partial collection API. */
  collect(context: Readonly<AdCollectionContext>): Promise<CollectedAd[]>
  /** Providers may explicitly attest that a bounded collection completed. */
  collectSnapshot?(context: Readonly<AdCollectionContext>): Promise<AdCollectionSnapshot>
}
