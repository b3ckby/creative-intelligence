import type { AdPlatform } from '../domain/types.ts'

export interface AdCollectionContext {
  readonly organizationId: string
  readonly productId: string
  readonly competitorId: string
}

export interface CollectedAd {
  platform: AdPlatform
  externalId: string
  advertiserName: string
  body: string
  callToAction: string | null
  startedAt: string
  isActive: boolean
  mediaUrls: string[]
  sourceUrl: string
}

export interface AdSourceProvider {
  collect(context: Readonly<AdCollectionContext>): Promise<CollectedAd[]>
}
