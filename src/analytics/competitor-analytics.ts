import { PUBLIC_LIBRARY_MOMENTUM_PROXY_LABEL } from './scale-metrics.ts'

export const ANALYTICS_HISTORY_WINDOWS = [7, 30, 90] as const
export type AnalyticsHistoryWindow = typeof ANALYTICS_HISTORY_WINDOWS[number]
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
  label: typeof PUBLIC_LIBRARY_MOMENTUM_PROXY_LABEL
  competitor: { id: string; name: string }
  windowDays: AnalyticsHistoryWindow
  trend7d: AnalyticsTrend7d | null
  items: AnalyticsSnapshotMetrics[]
}

export interface CompetitorAnalyticsComparisonItem {
  competitor: { id: string; name: string }
  latest: AnalyticsSnapshotMetrics | null
  trend7d: AnalyticsTrend7d | null
}

export interface CompetitorAnalyticsComparison {
  label: typeof PUBLIC_LIBRARY_MOMENTUM_PROXY_LABEL
  items: CompetitorAnalyticsComparisonItem[]
}
