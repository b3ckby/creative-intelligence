export type Platform = 'ios' | 'android' | 'web'
export type AdPlatform = 'meta'

/** Canonical maximum accepted at every ad ingestion and persistence boundary. */
export const AD_BODY_MAX_LENGTH = 20_000

export interface Product {
  id: string
  organizationId: string
  name: string
  markets: string[]
  platforms: Platform[]
  targetAudiences: string[]
  uniqueSellingPoints: string[]
  archivedAt: string | null
  createdAt: string
}

export interface Competitor {
  id: string
  organizationId: string
  productId: string
  name: string
  metaPageUrl: string | null
  archivedAt: string | null
  createdAt: string
}

export interface CompetitorAd {
  id: string
  organizationId: string
  productId: string
  competitorId: string
  providerName: string
  platform: AdPlatform
  externalId: string
  advertiserName: string
  body: string
  callToAction: string | null
  startedAt: string
  isActive: boolean
  mediaUrls: string[]
  sourceUrl: string
  firstSeenAt: string
  lastSeenAt: string
}

export type BriefStatus = 'draft' | 'triage' | 'approved' | 'production' | 'review' | 'completed' | 'archived'

export interface BriefDimensions {
  audience: string
  market: string
  angle: string
  format: string
}

export interface CreativeBrief {
  id: string
  organizationId: string
  productId: string
  title: string
  status: BriefStatus
  sourceAdId: string | null
  hook: string
  callToAction: string | null
  dimensions: BriefDimensions
  createdAt: string
}
