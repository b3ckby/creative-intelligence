import { ANALYTICS_HISTORY_WINDOWS, type AnalyticsHistoryWindow, type AnalyticsSnapshotMetrics, type AnalyticsTrend7d, type CompetitorAnalyticsComparison, type CompetitorAnalyticsHistory } from '../analytics/competitor-analytics.ts'
import { PUBLIC_LIBRARY_MOMENTUM_PROXY_LABEL } from '../analytics/scale-metrics.ts'
import { NotFoundError, ValidationError } from '../domain/errors.ts'
import { validateIdentifier } from '../domain/identifiers.ts'
import type { SqlPool } from './postgres-organization-repository.ts'
import { withVerifiedUserContext } from './verified-user-context.ts'

interface SnapshotRow extends Record<string, unknown> {
  competitor_id: unknown
  competitor_name: unknown
  snapshot_date: unknown
  captured_at: unknown
  active_ad_count: unknown
  new_ads_last_7d: unknown
  launch_velocity_delta: unknown
  avg_days_active: unknown
  long_runner_count: unknown
  image_count: unknown
  video_count: unknown
  carousel_count: unknown
  text_count: unknown
  impression_weight: unknown
  scale_score: unknown
  newly_tracked: unknown
  is_displayed?: unknown
}

export class PostgresCompetitorAnalyticsService {
  constructor(private readonly pool: SqlPool) {}

  async history(
    actorUserIdInput: string,
    organizationIdInput: string,
    productIdInput: string,
    competitorIdInput: string,
    windowDaysInput: number,
  ): Promise<CompetitorAnalyticsHistory> {
    const actorUserId = validateIdentifier(actorUserIdInput, 'Verified user ID')
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const productId = validateIdentifier(productIdInput, 'Product ID')
    const competitorId = validateIdentifier(competitorIdInput, 'Competitor ID')
    const windowDays = historyWindow(windowDaysInput)
    return await withVerifiedUserContext(this.pool, actorUserId, async (connection) => {
      const product = await connection.query<{ present: boolean }>(
        `SELECT true AS present FROM products
         WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL`,
        [organizationId, productId],
      )
      if (product.rows[0]?.present !== true) throw new NotFoundError()
      const result = await connection.query<SnapshotRow>(
        `WITH bounds AS (
           SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date AS utc_today
         )
         SELECT c.id AS competitor_id,c.name AS competitor_name,
           s.snapshot_date::text,s.captured_at,s.active_ad_count,s.new_ads_last_7d,
           s.launch_velocity_delta,s.avg_days_active::float8,s.long_runner_count,
           s.image_count,s.video_count,s.carousel_count,s.text_count,
           s.impression_weight::float8,s.scale_score,s.newly_tracked,s.is_displayed
         FROM competitors c CROSS JOIN bounds
         LEFT JOIN LATERAL (
           SELECT stored.*,
             stored.snapshot_date >= bounds.utc_today-($4::integer-1) AS is_displayed
           FROM competitor_analytics_snapshots stored
           WHERE stored.organization_id=c.organization_id AND stored.product_id=c.product_id AND stored.competitor_id=c.id
             AND (
               stored.snapshot_date >= bounds.utc_today-($4::integer-1)
               OR stored.snapshot_date = (
                 SELECT max(candidate.snapshot_date)-7
                 FROM competitor_analytics_snapshots candidate
                 WHERE candidate.organization_id=c.organization_id AND candidate.product_id=c.product_id
                   AND candidate.competitor_id=c.id
                   AND candidate.snapshot_date >= bounds.utc_today-($4::integer-1)
               )
             )
           ORDER BY stored.snapshot_date DESC
           LIMIT 91
         ) s ON true
         WHERE c.organization_id=$1 AND c.product_id=$2 AND c.id=$3 AND c.archived_at IS NULL
         ORDER BY s.snapshot_date DESC NULLS LAST
         LIMIT 91`,
        [organizationId, productId, competitorId, windowDays],
      )
      if (result.rows.length === 0) throw new NotFoundError()
      if (result.rows.length > 91) throw new Error('Analytics history limit exceeded')
      const identity = { id: identifierText(result.rows[0]?.competitor_id), name: text(result.rows[0]?.competitor_name) }
      const snapshotRows = result.rows.filter((row) => row.snapshot_date !== null)
      const snapshots = snapshotRows.map(decodeSnapshot)
      const items = snapshotRows.flatMap((row, index) => displayed(row.is_displayed) ? [snapshots[index]!] : [])
      return {
        label: PUBLIC_LIBRARY_MOMENTUM_PROXY_LABEL,
        competitor: identity,
        windowDays,
        trend7d: trend(snapshots),
        items,
      }
    })
  }

  async compare(
    actorUserIdInput: string,
    organizationIdInput: string,
    productIdInput: string,
    competitorIdsInput: string[],
  ): Promise<CompetitorAnalyticsComparison> {
    if (!Array.isArray(competitorIdsInput) || competitorIdsInput.length < 2 || competitorIdsInput.length > 10) {
      throw new ValidationError('Analytics comparison requires 2 to 10 competitors')
    }
    const competitorIds = competitorIdsInput.map((value) => validateIdentifier(value, 'Competitor ID'))
    if (new Set(competitorIds).size !== competitorIds.length) throw new ValidationError('Analytics comparison competitors must be unique')
    const actorUserId = validateIdentifier(actorUserIdInput, 'Verified user ID')
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const productId = validateIdentifier(productIdInput, 'Product ID')
    return await withVerifiedUserContext(this.pool, actorUserId, async (connection) => {
      const result = await connection.query<SnapshotRow>(
        `WITH selected AS (
           SELECT competitor_id,selection_order
           FROM unnest($3::text[]) WITH ORDINALITY AS chosen(competitor_id,selection_order)
         )
         SELECT c.id AS competitor_id,c.name AS competitor_name,
           s.snapshot_date::text,s.captured_at,s.active_ad_count,s.new_ads_last_7d,
           s.launch_velocity_delta,s.avg_days_active::float8,s.long_runner_count,
           s.image_count,s.video_count,s.carousel_count,s.text_count,
           s.impression_weight::float8,s.scale_score,s.newly_tracked
         FROM selected
         JOIN competitors c ON c.organization_id=$1 AND c.product_id=$2
           AND c.id=selected.competitor_id AND c.archived_at IS NULL
         JOIN products p ON p.organization_id=c.organization_id AND p.id=c.product_id AND p.archived_at IS NULL
         LEFT JOIN LATERAL (
           SELECT stored.*
           FROM competitor_analytics_snapshots stored
           WHERE stored.organization_id=c.organization_id AND stored.product_id=c.product_id AND stored.competitor_id=c.id
           ORDER BY stored.snapshot_date DESC
           LIMIT 8
         ) s ON true
         ORDER BY selected.selection_order,s.snapshot_date DESC NULLS LAST
         LIMIT 81`,
        [organizationId, productId, competitorIds],
      )
      if (result.rows.length > 80) throw new Error('Analytics comparison history limit exceeded')
      const groups = new Map<string, { name: string; rows: SnapshotRow[] }>()
      for (const row of result.rows) {
        const id = identifierText(row.competitor_id)
        const name = text(row.competitor_name)
        const group = groups.get(id) ?? { name, rows: [] }
        if (group.name !== name) throw invalidRow()
        group.rows.push(row)
        groups.set(id, group)
      }
      if (groups.size !== competitorIds.length) throw new NotFoundError()
      return {
        label: PUBLIC_LIBRARY_MOMENTUM_PROXY_LABEL,
        items: competitorIds.map((id) => {
          const group = groups.get(id)
          if (!group) throw new NotFoundError()
          const snapshots = group.rows.filter((row) => row.snapshot_date !== null).map(decodeSnapshot)
          return { competitor: { id, name: group.name }, latest: snapshots[0] ?? null, trend7d: trend(snapshots) }
        }),
      }
    })
  }
}

function historyWindow(value: number): AnalyticsHistoryWindow {
  if (!ANALYTICS_HISTORY_WINDOWS.includes(value as AnalyticsHistoryWindow)) throw new ValidationError('Analytics history window is invalid')
  return value as AnalyticsHistoryWindow
}

function decodeSnapshot(row: SnapshotRow): AnalyticsSnapshotMetrics {
  const result: AnalyticsSnapshotMetrics = {
    snapshotDate: date(row.snapshot_date), capturedAt: timestamp(row.captured_at),
    activeAdCount: nonNegativeInteger(row.active_ad_count), newAdsLast7d: nonNegativeInteger(row.new_ads_last_7d),
    launchVelocityDelta: integer(row.launch_velocity_delta), avgDaysActive: nonNegativeNumber(row.avg_days_active),
    longRunnerCount: nonNegativeInteger(row.long_runner_count),
    formatMix: {
      image: nonNegativeInteger(row.image_count), video: nonNegativeInteger(row.video_count),
      carousel: nonNegativeInteger(row.carousel_count), text: nonNegativeInteger(row.text_count),
    },
    scaleScore: boundedInteger(row.scale_score, 0, 100), newlyTracked: boolean(row.newly_tracked),
  }
  if (row.impression_weight !== null && row.impression_weight !== undefined) result.impressionWeight = nonNegativeNumber(row.impression_weight)
  return result
}

function trend(items: AnalyticsSnapshotMetrics[]): AnalyticsTrend7d | null {
  const latest = items[0]
  if (!latest) return null
  const latestTime = Date.parse(`${latest.snapshotDate}T00:00:00.000Z`)
  const baseline = items.find((item) => latestTime-Date.parse(`${item.snapshotDate}T00:00:00.000Z`) === 7*86_400_000)
  if (!baseline) return null
  const activeAdCountChange = latest.activeAdCount-baseline.activeAdCount
  const scaleScoreChange = latest.scaleScore-baseline.scaleScore
  return {
    activeAdCountChange,
    activeAdCountChangePercent: baseline.activeAdCount === 0 ? null : Math.round(activeAdCountChange/baseline.activeAdCount*100),
    scaleScoreChange,
    direction: activeAdCountChange > 0 || (activeAdCountChange === 0 && scaleScoreChange > 0) ? 'up'
      : activeAdCountChange < 0 || (activeAdCountChange === 0 && scaleScoreChange < 0) ? 'down' : 'flat',
  }
}

function identifierText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /^\s|\s$|[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw invalidRow()
  return value
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300 || /^\s|\s$|[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw invalidRow()
  return value
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) throw invalidRow()
  return value
}
function timestamp(value: unknown): string {
  const result = value instanceof Date ? value.toISOString() : value
  if (typeof result !== 'string') throw invalidRow()
  const parsed = new Date(result)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) throw invalidRow()
  return result
}
function integer(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw invalidRow(); return value }
function nonNegativeInteger(value: unknown): number { const result=integer(value); if (result<0) throw invalidRow(); return result }
function boundedInteger(value: unknown,min:number,max:number):number { const result=integer(value); if(result<min||result>max) throw invalidRow(); return result }
function nonNegativeNumber(value: unknown): number { if(typeof value!=='number'||!Number.isFinite(value)||value<0) throw invalidRow(); return value }
function boolean(value: unknown): boolean { if(typeof value!=='boolean') throw invalidRow(); return value }
function displayed(value: unknown): boolean { return boolean(value) }
function invalidRow(): Error { return new Error('Stored analytics snapshot is invalid') }
