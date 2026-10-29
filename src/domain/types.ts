export type Platform = 'ios' | 'android' | 'web'
export type AdPlatform = 'meta'
export type AdType = 'image' | 'video' | 'carousel' | 'text'

export interface AdMedia {
  kind: 'image' | 'video'
  sourceUrl: string
  mirroredUrl?: string
  posterUrl: string | null
  mirroredPosterUrl?: string
  cardIndex: number | null
  order: number
}

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
  pageId?: string | null
  advertiserName: string
  body: string
  headline?: string | null
  description?: string | null
  callToAction: string | null
  displayFormat?: string | null
  adType?: AdType | null
  startedAt: string
  endedAt?: string | null
  isActive: boolean
  publisherPlatforms?: string[] | null
  impressionsLowerBound?: number | null
  impressionsUpperBound?: number | null
  spendLowerBound?: number | null
  spendUpperBound?: number | null
  currency?: string | null
  media?: AdMedia[] | null
  mediaUrls: string[]
  mirroredMediaUrls?: Array<string | null>
  sourceUrl: string
  firstSeenAt: string
  lastSeenAt: string
  bookmarked?: boolean
}

export const WINNING_AD_CATEGORIES = ['classic', 'modern', 'minimal', 'bold', 'lifestyle', 'product'] as const
export type WinningAdCategory = typeof WINNING_AD_CATEGORIES[number]

export interface WinningAd {
  id: string
  organizationId: string
  sourceAdId: string
  title: string
  category: WinningAdCategory
  notes: string
  source: {
    provider: string
    platform: AdPlatform
    externalId: string
    url: string
    advertiserName: string
    isActive: boolean
  }
  copy: { body: string; headline: string | null; description: string | null; callToAction: string | null }
  media: Array<{ position: number; kind: 'image' | 'video' | 'unknown'; mediaType: string; checksum: string; url: string }>
  analysis: {
    tags: Record<string, unknown>
    provenance: 'manual' | 'automatic'
    version: string
    analyzedAt: string
  } | null
  version: number
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export type InspirationSourceKind = 'competitor_ad' | 'winning_ad'
export type InspirationSort = 'created_asc' | 'created_desc' | 'updated_desc'

export interface InspirationBoard {
  id: string
  organizationId: string
  name: string
  description: string
  version: number
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface InspirationItem {
  id: string
  organizationId: string
  boardId: string
  sourceKind: InspirationSourceKind
  sourceId: string
  title: string
  notes: string
  tags: string[]
  source: { provider: string; platform: AdPlatform; externalId: string; url: string; advertiserName: string }
  copy: { body: string; headline: string | null }
  media: Array<{ position: number; kind: 'image' | 'video' | 'unknown'; mediaType: string; checksum: string; url: string }>
  version: number
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export type BriefStatus = 'draft' | 'triage' | 'approved' | 'production' | 'review' | 'completed' | 'archived'

export interface BriefDimensions {
  audience: string
  market: string
  angle: string
  format: string
}

export interface CreativeBriefDetails {
  strategy: {
    targetAudience: string
    objective: string
    keyMessage: string
    tension: string
    proofPoints: string[]
  }
  artDirection: {
    format: string
    visualStyle: string
    setting: string
    talent: string
    audio: string
    color: string
    mandatoryElements: string[]
  }
  narrative: {
    storyArc: string
    hooks: Array<{ visual: string; spoken: string; onScreenText: string }>
    bodyScript: string
    ctas: string[]
  }
  production: {
    aspectRatios: string[]
    durationSeconds: number
    deliverables: string[]
    shotList: Array<{ sequence: number; description: string; audio: string; onScreenText: string }>
    handoffNotes: string
    sourceAnalysis: { analysisVersion: string; confidence: number }
  }
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
  details?: CreativeBriefDetails | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface CreativeBriefVersion extends CreativeBrief {
  changedBy: string
  changedAt: string
}
