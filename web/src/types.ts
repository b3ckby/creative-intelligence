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
  media?: Array<{
    kind: 'image' | 'video'; sourceUrl: string; mirroredUrl?: string; posterUrl: string | null;
    mirroredPosterUrl?: string; cardIndex: number | null; order: number
  }> | null
  mediaUrls: string[]
  mirroredMediaUrls?: Array<string | null>
  sourceUrl: string
  firstSeenAt: string
  lastSeenAt: string
  bookmarked?: boolean
}

export interface BriefDimensions {
  audience: string
  market: string
  angle: string
  format: string
}

export interface CreativeBriefDetails {
  strategy: { targetAudience: string; objective: string; keyMessage: string; tension: string; proofPoints: string[] }
  artDirection: { format: string; visualStyle: string; setting: string; talent: string; audio: string; color: string; mandatoryElements: string[] }
  narrative: { storyArc: string; hooks: Array<{ visual: string; spoken: string; onScreenText: string }>; bodyScript: string; ctas: string[] }
  production: {
    aspectRatios: string[]; durationSeconds: number; deliverables: string[]
    shotList: Array<{ sequence: number; description: string; audio: string; onScreenText: string }>
    handoffNotes: string; sourceAnalysis: { analysisVersion: string; confidence: number }
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
  briefs: Array<Pick<CreativeBrief, 'id' | 'title' | 'status'>>
  briefCount: number
  hasMoreBriefs: boolean
}

export interface IterationMap {
  totalCombinations: number
  covered: IterationCell[]
  missing: IterationCell[]
}

export type AnalyticsHistoryWindow = 7 | 30 | 90
export type AnalyticsTrendDirection = 'up' | 'down' | 'flat'

export interface AnalyticsSnapshotMetrics {
  snapshotDate: string
  capturedAt: string
  activeAdCount: number
  newAdsLast7d: number
  launchVelocityDelta: number
  avgDaysActive: number
  longRunnerCount: number
  formatMix: { image: number; video: number; carousel: number; text: number }
  impressionWeight?: number
  scaleScore: number
  newlyTracked: boolean
}

export interface AnalyticsTrend7d {
  activeAdCountChange: number
  activeAdCountChangePercent: number | null
  scaleScoreChange: number
  direction: AnalyticsTrendDirection
}

export interface CompetitorAnalyticsHistory {
  label: 'Public Ad Library momentum proxy'
  competitor: { id: string; name: string }
  windowDays: AnalyticsHistoryWindow
  trend7d: AnalyticsTrend7d | null
  items: AnalyticsSnapshotMetrics[]
}

export interface CompetitorAnalyticsComparison {
  label: 'Public Ad Library momentum proxy'
  items: Array<{
    competitor: { id: string; name: string }
    latest: AnalyticsSnapshotMetrics | null
    trend7d: AnalyticsTrend7d | null
  }>
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
  provenance: 'manual' | 'automatic'
  analysisMode: 'media' | 'copy_only'
  mediaCount: number
}

export type CreativeTagReviewStatus = 'pending' | 'approved' | 'rejected' | 'corrected'
export type CreativeTagReviewDecision = Exclude<CreativeTagReviewStatus, 'pending'>
export type CreativeTagCorrections = Partial<Pick<CreativeAnalysisTags, 'hookCategory' | 'angle' | 'format' | 'offerFrame' | 'funnelStage'>>
export interface CreativeTagReview {
  organizationId: string; productId: string; competitorAdId: string; analysisVersion: string; inputFingerprint: string
  reviewVersion: number; decision: CreativeTagReviewDecision; corrections: CreativeTagCorrections | null
  reason: string; reviewerUserId: string; reviewedAt: string
}
export interface CreativeTagReviewItem {
  advertiserName: string; analysis: CreativeAnalysis; status: CreativeTagReviewStatus; review: CreativeTagReview | null
  originalTags: CreativeAnalysisTags; effectiveTags: CreativeAnalysisTags | null; stale: boolean
}
export interface CreativeTagReviewSubmission {
  analysisVersion: string; inputFingerprint: string; expectedReviewVersion: number; decision: CreativeTagReviewDecision
  corrections: CreativeTagCorrections | null; reason: string
}

export interface CreativeStrategyFrequency {
  value: string
  count: number
  percentage: number
}

export interface CreativeStrategySummary {
  organizationId: string
  productId: string
  competitorId: string
  totalAds: number
  analyzedAds: number
  dimensions: Record<'hooks' | 'angles' | 'formats' | 'emotions' | 'personas' | 'offers' | 'funnelStages', CreativeStrategyFrequency[]>
}

export type WinningAdCategory = 'classic' | 'modern' | 'minimal' | 'bold' | 'lifestyle' | 'product'
export interface WinningAd {
  id: string
  organizationId: string
  sourceAdId: string
  title: string
  category: WinningAdCategory
  notes: string
  source: { provider: string; platform: 'meta'; externalId: string; url: string; advertiserName: string; isActive: boolean }
  copy: { body: string; headline: string | null; description: string | null; callToAction: string | null }
  media: Array<{ position: number; kind: 'image' | 'video' | 'unknown'; mediaType: string; checksum: string; url: string }>
  analysis: { tags: CreativeAnalysisTags; provenance: 'manual' | 'automatic'; version: string; analyzedAt: string } | null
  version: number
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface WinningAdFilters { search?: string; category?: WinningAdCategory; active?: boolean; includeArchived?: boolean }
export interface WinningAdMetadataDraft { title: string; category: WinningAdCategory; notes: string }
export interface WinningAdUpdateDraft extends WinningAdMetadataDraft { expectedVersion: number }

export type InspirationSourceKind = 'competitor_ad' | 'winning_ad'
export type InspirationSort = 'created_asc' | 'created_desc' | 'updated_desc'
export interface InspirationBoard {
  id: string; organizationId: string; name: string; description: string; version: number
  archivedAt: string | null; createdAt: string; updatedAt: string
}
export interface InspirationItem {
  id: string; organizationId: string; boardId: string; sourceKind: InspirationSourceKind; sourceId: string
  title: string; notes: string; tags: string[]
  source: { provider: string; platform: 'meta'; externalId: string; url: string; advertiserName: string }
  copy: { body: string; headline: string | null }
  media: Array<{ position: number; kind: 'image' | 'video' | 'unknown'; mediaType: string; checksum: string; url: string }>
  version: number; archivedAt: string | null; createdAt: string; updatedAt: string
}
export interface InspirationFilters { boardId?: string; search?: string; tag?: string; sourceKind?: InspirationSourceKind; sort?: InspirationSort; includeArchived?: boolean }
export interface InspirationMetadataDraft { title: string; notes: string; tags: string[] }
export interface InspirationUpdateDraft extends InspirationMetadataDraft { expectedVersion: number; boardId: string }

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
