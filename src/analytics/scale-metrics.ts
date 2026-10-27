import type { CompetitorAd } from '../domain/types.ts'

/** This ranking is a public-data signal, not observed spend, revenue, or ROAS. */
export const PUBLIC_LIBRARY_MOMENTUM_PROXY_LABEL = 'Public Ad Library momentum proxy'

export const LONG_RUNNER_DAYS = 21
export const NEWLY_TRACKED_DAYS = 7
export const NEWLY_TRACKED_MAX_ADS = 5

export const SCALE_SCORE_WEIGHTS = {
  longRunner: 0.35,
  activeAds: 0.2,
  velocity: 0.3,
  impressions: 0.15,
} as const

const WINDOW_DAYS = 7
const MS_PER_DAY = 24 * 60 * 60 * 1000

export type ScaleMetricFormat = 'image' | 'video' | 'carousel' | 'text'
export type ScaleMetricFormatMix = Record<ScaleMetricFormat, number>

/** Analytics-only enrichment; canonical persisted ads need not expose impressions. */
export interface ScaleMetricsAd extends CompetitorAd {
  impressionsLowerBound?: number
  impressionsUpperBound?: number
}

export interface ScaleMetricsCompetitor {
  id: string
  name: string
}

export interface CompetitorScaleMetrics {
  competitorId: string
  competitorName: string
  activeAdCount: number
  newAdsLast7d: number
  newAdsPrev7d: number
  launchVelocityDelta: number
  avgDaysActive: number
  longRunnerCount: number
  formatMix: ScaleMetricFormatMix
  impressionWeight?: number
  scaleScore: number
  newlyTracked: boolean
}

export type UnscoredCompetitorScaleMetrics = Omit<CompetitorScaleMetrics, 'scaleScore'>

interface Accumulator {
  competitorId: string
  competitorName: string
  activeAdCount: number
  newAdsLast7d: number
  newAdsPrev7d: number
  daysActiveSum: number
  adCount: number
  longRunnerCount: number
  formatMix: Record<ScaleMetricFormat, number>
  impressionMidpointSum: number
  hasImpressions: boolean
  earliestFirstSeen: number
}

interface ScoringRow {
  bucket: Accumulator
  newlyTracked: boolean
  launchVelocityDelta: number
  impressionWeight?: number
  avgDaysActive: number
}

function emptyAccumulator(competitor: ScaleMetricsCompetitor): Accumulator {
  return {
    competitorId: competitor.id,
    competitorName: competitor.name,
    activeAdCount: 0,
    newAdsLast7d: 0,
    newAdsPrev7d: 0,
    daysActiveSum: 0,
    adCount: 0,
    longRunnerCount: 0,
    formatMix: { image: 0, video: 0, carousel: 0, text: 0 },
    impressionMidpointSum: 0,
    hasImpressions: false,
    earliestFirstSeen: Number.POSITIVE_INFINITY,
  }
}

function isVideoUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.hostname.toLowerCase().startsWith('video-') || /\.(?:mp4|m4v|webm|mov)$/iu.test(url.pathname)
  } catch {
    return false
  }
}

function mediaFormat(ad: ScaleMetricsAd): ScaleMetricFormat {
  if (ad.adType) return ad.adType
  if (ad.mediaUrls.some(isVideoUrl)) return 'video'
  return ad.mediaUrls.length > 0 ? 'image' : 'text'
}

function finiteTimestamp(value: string): number | undefined {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function daysActive(ad: ScaleMetricsAd, now: number): number {
  const startedAt = finiteTimestamp(ad.startedAt)
  if (startedAt === undefined) return 0
  const lastSeenAt = finiteTimestamp(ad.lastSeenAt) ?? now
  const endpoint = ad.isActive ? now : Math.min(lastSeenAt, now)
  return Math.max(0, endpoint - startedAt) / MS_PER_DAY
}

function normalize(value: number, min: number, max: number): number {
  if (max <= min) return max > 0 ? 0.5 : 0
  return (Math.min(Math.max(value, min), max) - min) / (max - min)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Computes a deterministic relative momentum ranking from public ad-library data.
 * `now` is required so callers, tests, and replays control the clock explicitly.
 */
export function computeScaleMetrics(
  ads: readonly ScaleMetricsAd[],
  competitors: readonly ScaleMetricsCompetitor[],
  now: number,
): CompetitorScaleMetrics[] {
  const trailingStart = now - WINDOW_DAYS * MS_PER_DAY
  const previousStart = now - 2 * WINDOW_DAYS * MS_PER_DAY
  const newlyTrackedStart = now - NEWLY_TRACKED_DAYS * MS_PER_DAY
  const accumulators = new Map<string, Accumulator>()

  for (const competitor of competitors) {
    accumulators.set(competitor.id, emptyAccumulator(competitor))
  }

  for (const ad of ads) {
    let bucket = accumulators.get(ad.competitorId)
    if (!bucket) {
      bucket = emptyAccumulator({ id: ad.competitorId, name: ad.advertiserName })
      accumulators.set(ad.competitorId, bucket)
    }

    bucket.adCount += 1
    bucket.daysActiveSum += daysActive(ad, now)
    bucket.formatMix[mediaFormat(ad)] += 1
    if (ad.isActive) bucket.activeAdCount += 1
    if (ad.isActive && daysActive(ad, now) > LONG_RUNNER_DAYS) bucket.longRunnerCount += 1

    const startedAt = finiteTimestamp(ad.startedAt)
    if (startedAt !== undefined) {
      if (startedAt >= trailingStart && startedAt <= now) bucket.newAdsLast7d += 1
      else if (startedAt >= previousStart && startedAt < trailingStart) bucket.newAdsPrev7d += 1
    }

    const firstSeenAt = finiteTimestamp(ad.firstSeenAt)
    if (firstSeenAt !== undefined) bucket.earliestFirstSeen = Math.min(bucket.earliestFirstSeen, firstSeenAt)

    if (ad.impressionsLowerBound !== undefined || ad.impressionsUpperBound !== undefined) {
      const lower = ad.impressionsLowerBound ?? ad.impressionsUpperBound ?? 0
      const upper = ad.impressionsUpperBound ?? ad.impressionsLowerBound ?? 0
      bucket.impressionMidpointSum += (lower + upper) / 2
      bucket.hasImpressions = true
    }
  }

  const rows: ScoringRow[] = [...accumulators.values()].map((bucket) => {
    const newlyTracked = bucket.earliestFirstSeen >= newlyTrackedStart
      && bucket.earliestFirstSeen <= now
      && bucket.adCount <= NEWLY_TRACKED_MAX_ADS
    const row: ScoringRow = {
      bucket,
      newlyTracked,
      launchVelocityDelta: newlyTracked ? 0 : bucket.newAdsLast7d - bucket.newAdsPrev7d,
      avgDaysActive: bucket.adCount === 0 ? 0 : bucket.daysActiveSum / bucket.adCount,
    }
    if (bucket.hasImpressions) row.impressionWeight = bucket.impressionMidpointSum
    return row
  })

  const aggregated: UnscoredCompetitorScaleMetrics[] = rows.map((row) => {
    const item: UnscoredCompetitorScaleMetrics = {
      competitorId: row.bucket.competitorId,
      competitorName: row.bucket.competitorName,
      activeAdCount: row.bucket.activeAdCount,
      newAdsLast7d: row.bucket.newAdsLast7d,
      newAdsPrev7d: row.bucket.newAdsPrev7d,
      launchVelocityDelta: row.launchVelocityDelta,
      avgDaysActive: Math.round(row.avgDaysActive * 10) / 10,
      longRunnerCount: row.bucket.longRunnerCount,
      formatMix: row.bucket.formatMix,
      newlyTracked: row.newlyTracked,
    }
    if (row.impressionWeight !== undefined) item.impressionWeight = row.impressionWeight
    return item
  })
  return scoreScaleMetricRows(aggregated)
}

/** Scores already aggregated SQL rows without transferring every ad to the application. */
export function scoreScaleMetricRows(rows: readonly UnscoredCompetitorScaleMetrics[]): CompetitorScaleMetrics[] {
  if (rows.length === 0) return []
  const anyImpressions = rows.some((row) => row.impressionWeight !== undefined)
  const components = [
    { weight: SCALE_SCORE_WEIGHTS.longRunner, value: (row: UnscoredCompetitorScaleMetrics) => row.longRunnerCount, enabled: true },
    { weight: SCALE_SCORE_WEIGHTS.activeAds, value: (row: UnscoredCompetitorScaleMetrics) => row.activeAdCount, enabled: true },
    { weight: SCALE_SCORE_WEIGHTS.velocity, value: (row: UnscoredCompetitorScaleMetrics) => Math.max(0, row.launchVelocityDelta), enabled: true },
    { weight: SCALE_SCORE_WEIGHTS.impressions, value: (row: UnscoredCompetitorScaleMetrics) => row.impressionWeight ?? 0, enabled: anyImpressions },
  ].filter((component) => component.enabled).map((component) => {
    const values = rows.map(component.value)
    return { ...component, min: Math.min(...values), max: Math.max(...values) }
  })
  const weightTotal = components.reduce((total, component) => total + component.weight, 0)

  return rows.map((row) => {
    const weighted = components.reduce((total, component) => (
      total + component.weight * normalize(component.value(row), component.min, component.max)
    ), 0)
    const result: CompetitorScaleMetrics = {
      ...row,
      scaleScore: weightTotal === 0 ? 0 : Math.round((weighted / weightTotal) * 100),
    }
    return result
  }).sort((left, right) => (
    right.scaleScore - left.scaleScore
    || compareText(left.competitorName, right.competitorName)
    || compareText(left.competitorId, right.competitorId)
  ))
}
