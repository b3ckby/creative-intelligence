export type Platform = 'ios' | 'android' | 'web'
export type BriefStatus = 'draft' | 'triage' | 'approved' | 'production' | 'review' | 'completed' | 'archived'

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
  platform: 'meta'
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

export interface IterationCell {
  dimensions: BriefDimensions
  briefIds: string[]
}

export interface IterationMap {
  totalCombinations: number
  covered: IterationCell[]
  missing: IterationCell[]
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export interface ProductDraft {
  name: string
  markets: string[]
  platforms: Platform[]
  targetAudiences: string[]
  uniqueSellingPoints: string[]
}

export interface CompetitorDraft {
  name: string
  metaPageUrl?: string | null
}

export interface ManualBriefDraft {
  title: string
  hook: string
  callToAction?: string
  dimensions: BriefDimensions
}

export interface IterationAxes {
  audience: string[]
  market: string[]
  angle: string[]
  format: string[]
}
