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
  media?: Array<{ kind: 'image' | 'video'; sourceUrl: string; posterUrl: string | null; cardIndex: number | null; order: number }> | null
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
  version: number
  createdAt: string
  updatedAt: string
}

export interface CreativeBriefVersion extends CreativeBrief {
  changedBy: string
  changedAt: string
}

export interface BriefUpdateDraft {
  expectedVersion: number
  title: string
  status: BriefStatus
  hook: string
  callToAction: string | null
  dimensions: BriefDimensions
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

export interface ScalingAnalyticsItem {
  competitorId: string
  competitorName: string
  activeAdCount: number
  newAdsLast7d: number
  newAdsPrev7d: number
  launchVelocityDelta: number
  avgDaysActive: number
  longRunnerCount: number
  formatMix: { image: number; video: number; carousel: number; text: number }
  impressionWeight?: number
  scaleScore: number
  newlyTracked: boolean
}

export interface ScalingAnalytics {
  label: string
  generatedAt: string
  items: ScalingAnalyticsItem[]
}

export interface CreativeAnalysisTags {
  hookCategory: string
  angle: string
  emotion: string
  persona: string
  format: string
  offerFrame: string
  cta: string
  onScreenText?: string
  visualSummary: string
  funnelStage: 'awareness' | 'consideration' | 'conversion' | 'retention'
  confidence: number
}

export interface CreativeAnalysis {
  organizationId: string
  productId: string
  competitorAdId: string
  analysisVersion: string
  modelProvider: string
  modelName: string
  promptVersion: string
  inputFingerprint: string
  tags: CreativeAnalysisTags
  analyzedAt: string
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
