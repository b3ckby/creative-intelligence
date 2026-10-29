import type {
  CreativeStrategySummary,
  CreativeStrategySummaryService,
} from '../creative-analysis/creative-strategy-summary.ts'
import { NotFoundError } from '../domain/errors.ts'
import { validateIdentifier } from '../domain/identifiers.ts'
import type { SqlPool } from './postgres-organization-repository.ts'
import { withVerifiedUserReadContext } from './verified-user-context.ts'

type Dimension = keyof CreativeStrategySummary['dimensions']

interface StrategyRow extends Record<string, unknown> {
  dimension: unknown
  value: unknown
  tag_count: unknown
  total_ads: unknown
  analyzed_ads: unknown
}

const DIMENSIONS: readonly Dimension[] = ['hooks', 'angles', 'formats', 'emotions', 'personas', 'offers', 'funnelStages']

export class PostgresCreativeStrategyService implements CreativeStrategySummaryService {
  constructor(private readonly pool: SqlPool) {}

  async get(actorUserIdInput: string, organizationIdInput: string, productIdInput: string, competitorIdInput: string): Promise<CreativeStrategySummary> {
    const actorUserId = validateIdentifier(actorUserIdInput, 'Verified user ID')
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const productId = validateIdentifier(productIdInput, 'Product ID')
    const competitorId = validateIdentifier(competitorIdInput, 'Competitor ID')
    const rows = await withVerifiedUserReadContext(this.pool, actorUserId, async (connection) => (await connection.query<StrategyRow>(
      `WITH scope AS (
         SELECT c.organization_id, c.product_id, c.id
         FROM competitors c
         JOIN products p ON p.organization_id = c.organization_id AND p.id = c.product_id
         WHERE c.organization_id = $1 AND c.product_id = $2 AND c.id = $3
           AND c.archived_at IS NULL AND p.archived_at IS NULL
       ), latest_raw AS (
         SELECT DISTINCT ON (a.id) a.id, ca.*
         FROM scope s
         JOIN competitor_ads a ON a.organization_id = s.organization_id AND a.product_id = s.product_id AND a.competitor_id = s.id
         JOIN creative_ad_analyses ca ON ca.organization_id = a.organization_id AND ca.product_id = a.product_id AND ca.competitor_ad_id = a.id
         WHERE ca.status = 'completed'
         ORDER BY a.id, ca.analyzed_at DESC, ca.updated_at DESC, ca.analysis_version DESC, ca.input_fingerprint DESC
       ), latest AS (
         SELECT ca.id, ca.tags || COALESCE(latest_review.corrections,'{}'::jsonb) AS tags
         FROM latest_raw ca
         LEFT JOIN LATERAL (SELECT cr.decision,cr.corrections FROM creative_analysis_reviews cr
           WHERE cr.organization_id=ca.organization_id AND cr.competitor_ad_id=ca.competitor_ad_id
             AND cr.analysis_version=ca.analysis_version AND cr.input_fingerprint=ca.input_fingerprint
           ORDER BY cr.review_version DESC LIMIT 1) latest_review ON true
         WHERE latest_review.decision IS NULL OR latest_review.decision <> 'rejected'
       ), counts AS (
         SELECT
           (SELECT count(*) FROM competitor_ads a JOIN scope s ON s.organization_id = a.organization_id AND s.product_id = a.product_id AND s.id = a.competitor_id) AS total_ads,
           (SELECT count(*) FROM latest) AS analyzed_ads
       ), tag_values AS (
         SELECT v.dimension, v.value,
                CASE WHEN v.dimension = 'personas' THEN lower(trim(v.value)) ELSE v.value END AS group_key
         FROM latest l
         CROSS JOIN LATERAL (VALUES
           ('hooks', l.tags->>'hookCategory'), ('angles', l.tags->>'angle'), ('formats', l.tags->>'format'),
           ('emotions', l.tags->>'emotion'), ('personas', l.tags->>'persona'), ('offers', l.tags->>'offerFrame'),
           ('funnelStages', l.tags->>'funnelStage')
         ) AS v(dimension, value)
         WHERE v.value IS NOT NULL AND trim(v.value) <> ''
       ), frequencies AS (
         SELECT dimension, min(value) AS value, count(*) AS tag_count, group_key
         FROM tag_values GROUP BY dimension, group_key
       ), ranked AS (
         SELECT dimension, value, tag_count,
                ROW_NUMBER() OVER (PARTITION BY dimension ORDER BY tag_count DESC, group_key ASC) AS rank
         FROM frequencies
       )
       SELECT r.dimension, r.value, r.tag_count, counts.total_ads, counts.analyzed_ads
       FROM scope CROSS JOIN counts
       LEFT JOIN ranked r ON r.rank <= 5
       ORDER BY r.dimension ASC NULLS LAST, r.rank ASC`,
      [organizationId, productId, competitorId],
    )).rows)

    const first = rows[0]
    if (!first) throw new NotFoundError()
    const totalAds = integer(first.total_ads)
    const analyzedAds = integer(first.analyzed_ads)
    if (analyzedAds > totalAds) throw new Error('Stored creative strategy counts are invalid')
    const dimensions = emptyDimensions()
    for (const row of rows) {
      if (row.dimension === null || row.dimension === undefined) continue
      const dimension = storedDimension(row.dimension)
      const value = storedValue(row.value)
      const count = integer(row.tag_count)
      if (count < 1 || count > analyzedAds || dimensions[dimension].length >= 5) throw new Error('Stored creative strategy frequency is invalid')
      dimensions[dimension].push({ value, count, percentage: analyzedAds === 0 ? 0 : Math.round((count / analyzedAds) * 100) })
    }
    return { organizationId, productId, competitorId, totalAds, analyzedAds, dimensions }
  }
}

function emptyDimensions(): CreativeStrategySummary['dimensions'] {
  return { hooks: [], angles: [], formats: [], emotions: [], personas: [], offers: [], funnelStages: [] }
}

function storedDimension(value: unknown): Dimension {
  if (typeof value !== 'string' || !DIMENSIONS.includes(value as Dimension)) throw new Error('Stored creative strategy dimension is invalid')
  return value as Dimension
}

function storedValue(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || [...value].length > 120) throw new Error('Stored creative strategy value is invalid')
  return value
}

function integer(value: unknown): number {
  const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) throw new Error('Stored creative strategy count is invalid')
  return parsed as number
}
