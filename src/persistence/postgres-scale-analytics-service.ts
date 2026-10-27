import { PUBLIC_LIBRARY_MOMENTUM_PROXY_LABEL, scoreScaleMetricRows, type ScaleMetricFormat, type UnscoredCompetitorScaleMetrics } from '../analytics/scale-metrics.ts'
import { NotFoundError } from '../domain/errors.ts'
import { validateIdentifier } from '../domain/identifiers.ts'
import type { SqlPool } from './postgres-organization-repository.ts'
import { withVerifiedUserContext } from './verified-user-context.ts'

interface ScaleRow extends Record<string, unknown> {
  competitor_id: unknown
  competitor_name: unknown
  active_ad_count: unknown
  new_ads_last_7d: unknown
  new_ads_prev_7d: unknown
  avg_days_active: unknown
  long_runner_count: unknown
  image_count: unknown
  video_count: unknown
  carousel_count: unknown
  text_count: unknown
  impression_weight: unknown
  total_ad_count: unknown
  newly_tracked: unknown
}

const DAY_MS = 24 * 60 * 60 * 1_000

export class PostgresScaleAnalyticsService {
  constructor(private readonly pool: SqlPool, private readonly now: () => Date) {}

  async get(actorUserIdInput: string, organizationIdInput: string, productIdInput: string) {
    const actorUserId = validateIdentifier(actorUserIdInput, 'Verified user ID')
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const productId = validateIdentifier(productIdInput, 'Product ID')
    const instant = this.now()
    if (!Number.isFinite(instant.getTime())) throw new Error('Analytics clock is invalid')
    const now = instant.toISOString()
    const trailingStart = new Date(instant.getTime() - 7 * DAY_MS).toISOString()
    const previousStart = new Date(instant.getTime() - 14 * DAY_MS).toISOString()
    const newlyTrackedStart = trailingStart

    const items = await withVerifiedUserContext(this.pool, actorUserId, async (connection) => {
      const product = await connection.query<{ present: boolean }>(
        `SELECT true AS present FROM products
         WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL`,
        [organizationId, productId],
      )
      if (product.rows[0]?.present !== true) throw new NotFoundError()
      const competitors = await connection.query<{ id: unknown }>(
        `SELECT c.id
         FROM competitors c
         WHERE c.organization_id = $1 AND c.product_id = $2 AND c.archived_at IS NULL
         ORDER BY c.id
         LIMIT 10001`,
        [organizationId, productId],
      )
      if (competitors.rows.length > 10_000) throw new Error('Analytics competitor limit exceeded')
      const competitorIds = competitors.rows.map(({ id }) => text(id))
      if (competitorIds.length === 0) return []
      const result = await connection.query<ScaleRow>(
        `SELECT
           c.id AS competitor_id,
           c.name AS competitor_name,
           COUNT(a.id) FILTER (WHERE a.is_active)::int AS active_ad_count,
           COUNT(a.id) FILTER (WHERE a.started_at >= $4 AND a.started_at <= $3)::int AS new_ads_last_7d,
           COUNT(a.id) FILTER (WHERE a.started_at >= $5 AND a.started_at < $4)::int AS new_ads_prev_7d,
           COALESCE(AVG(GREATEST(0, EXTRACT(EPOCH FROM (
             (CASE WHEN a.is_active THEN $3::timestamptz ELSE LEAST(a.last_seen_at, $3::timestamptz) END) - a.started_at
           )) / 86400.0)) FILTER (WHERE a.id IS NOT NULL), 0)::float8 AS avg_days_active,
           COUNT(a.id) FILTER (WHERE a.is_active AND a.started_at < $3::timestamptz - interval '21 days')::int AS long_runner_count,
           COUNT(a.id) FILTER (WHERE format.value = 'image')::int AS image_count,
           COUNT(a.id) FILTER (WHERE format.value = 'video')::int AS video_count,
           COUNT(a.id) FILTER (WHERE format.value = 'carousel')::int AS carousel_count,
           COUNT(a.id) FILTER (WHERE format.value = 'text')::int AS text_count,
           SUM((COALESCE(a.impressions_lower_bound, a.impressions_upper_bound) + COALESCE(a.impressions_upper_bound, a.impressions_lower_bound)) / 2.0)::float8 AS impression_weight,
           COUNT(a.id)::int AS total_ad_count,
           COALESCE((MIN(a.first_seen_at) >= $6::timestamptz AND COUNT(a.id) <= 5), false)::boolean AS newly_tracked
         FROM competitors c
         LEFT JOIN competitor_ads a
           ON a.organization_id = c.organization_id AND a.product_id = c.product_id AND a.competitor_id = c.id
         LEFT JOIN LATERAL (
           SELECT CASE
             WHEN a.ad_type IS NOT NULL THEN a.ad_type
             WHEN EXISTS (
               SELECT 1 FROM jsonb_array_elements_text(a.media_urls) AS media(media_url)
               WHERE lower(media_url) ~ '^https://video-'
                  OR lower(split_part(split_part(media_url, '?', 1), '#', 1)) ~ '\\.(mp4|m4v|webm|mov)$'
             ) THEN 'video'
             WHEN jsonb_array_length(a.media_urls) > 0 THEN 'image'
             ELSE 'text'
           END AS value
         ) AS format ON true
         WHERE c.organization_id = $1 AND c.product_id = $2 AND c.archived_at IS NULL
           AND c.id = ANY($7::text[])
         GROUP BY c.id, c.name`,
        [organizationId, productId, now, trailingStart, previousStart, newlyTrackedStart, competitorIds],
      )
      if (result.rows.length > 10_000) throw new Error('Analytics competitor limit exceeded')
      const scored = scoreScaleMetricRows(result.rows.map(decodeScaleRow))
      if (scored.length > 0) {
        await connection.query(
          `INSERT INTO competitor_analytics_snapshots (
             organization_id, product_id, competitor_id, snapshot_date, active_ad_count,
             new_ads_last_7d, new_ads_prev_7d, launch_velocity_delta, avg_days_active,
             long_runner_count, image_count, video_count, carousel_count, text_count, impression_weight,
             scale_score, newly_tracked, captured_at
           )
           SELECT $1, $2, snapshot.competitor_id, $3::date, snapshot.active_ad_count,
             snapshot.new_ads_last_7d, snapshot.new_ads_prev_7d, snapshot.launch_velocity_delta,
             snapshot.avg_days_active, snapshot.long_runner_count, snapshot.image_count,
             snapshot.video_count, snapshot.carousel_count, snapshot.text_count, snapshot.impression_weight,
             snapshot.scale_score, snapshot.newly_tracked, $4::timestamptz
           FROM jsonb_to_recordset($5::jsonb) AS snapshot(
             competitor_id text, active_ad_count integer, new_ads_last_7d integer,
             new_ads_prev_7d integer, launch_velocity_delta integer, avg_days_active numeric,
             long_runner_count integer, image_count integer, video_count integer, carousel_count integer, text_count integer,
             impression_weight numeric, scale_score integer, newly_tracked boolean
           )
           ON CONFLICT (organization_id, competitor_id, snapshot_date) DO UPDATE SET
             active_ad_count = EXCLUDED.active_ad_count, new_ads_last_7d = EXCLUDED.new_ads_last_7d,
             new_ads_prev_7d = EXCLUDED.new_ads_prev_7d, launch_velocity_delta = EXCLUDED.launch_velocity_delta,
             avg_days_active = EXCLUDED.avg_days_active, long_runner_count = EXCLUDED.long_runner_count,
             image_count = EXCLUDED.image_count, video_count = EXCLUDED.video_count, carousel_count = EXCLUDED.carousel_count, text_count = EXCLUDED.text_count,
             impression_weight = EXCLUDED.impression_weight, scale_score = EXCLUDED.scale_score,
             newly_tracked = EXCLUDED.newly_tracked, captured_at = EXCLUDED.captured_at`,
          [organizationId, productId, now.slice(0, 10), now, JSON.stringify(scored.map((row) => ({
            competitor_id: row.competitorId, active_ad_count: row.activeAdCount,
            new_ads_last_7d: row.newAdsLast7d, new_ads_prev_7d: row.newAdsPrev7d,
            launch_velocity_delta: row.launchVelocityDelta, avg_days_active: row.avgDaysActive,
            long_runner_count: row.longRunnerCount, image_count: row.formatMix.image,
            video_count: row.formatMix.video, carousel_count: row.formatMix.carousel ?? 0, text_count: row.formatMix.text,
            impression_weight: row.impressionWeight ?? null, scale_score: row.scaleScore,
            newly_tracked: row.newlyTracked,
          })))],
        )
      }
      return scored
    })
    return { label: PUBLIC_LIBRARY_MOMENTUM_PROXY_LABEL, generatedAt: now, items }
  }
}

function decodeScaleRow(row: ScaleRow): UnscoredCompetitorScaleMetrics {
  const last7 = integer(row.new_ads_last_7d)
  const previous7 = integer(row.new_ads_prev_7d)
  const totalAdCount = integer(row.total_ad_count)
  const newlyTracked = totalAdCount === 0 && row.newly_tracked === null
    ? false
    : boolean(row.newly_tracked)
  const formatMix: Record<ScaleMetricFormat, number> = {
    image: integer(row.image_count), video: integer(row.video_count), carousel: integer(row.carousel_count), text: integer(row.text_count),
  }
  const decoded: UnscoredCompetitorScaleMetrics = {
    competitorId: text(row.competitor_id), competitorName: text(row.competitor_name),
    activeAdCount: integer(row.active_ad_count), newAdsLast7d: last7, newAdsPrev7d: previous7,
    launchVelocityDelta: newlyTracked ? 0 : last7 - previous7,
    avgDaysActive: Math.round(nonNegative(row.avg_days_active) * 10) / 10,
    longRunnerCount: integer(row.long_runner_count), formatMix, newlyTracked,
  }
  if (row.impression_weight !== null && row.impression_weight !== undefined) decoded.impressionWeight = nonNegative(row.impression_weight)
  return decoded
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Stored analytics row is invalid')
  return value
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Stored analytics row is invalid')
  return value
}
function nonNegative(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Stored analytics row is invalid')
  return value
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Stored analytics row is invalid')
  return value
}
