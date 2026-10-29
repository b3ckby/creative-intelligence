import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.ts'
import { validateIdentifier } from '../domain/identifiers.ts'
import { validateCreativeTags, type CreativeAnalysisRecord } from '../creative-analysis/creative-analysis-service.ts'
import {
  CREATIVE_TAG_REVIEW_STATUSES,
  effectiveCreativeTags,
  type CreativeTagCorrections,
  type CreativeTagReview,
  type CreativeTagReviewItem,
  type CreativeTagReviewStatus,
  validateCreativeTagReviewSubmission,
} from '../creative-analysis/creative-tag-review.ts'
import { storedTimestamp } from './catalog-row-decoders.ts'
import type { SqlPool } from './postgres-organization-repository.ts'
import { withVerifiedUserContext, withVerifiedUserReadContext } from './verified-user-context.ts'

interface ReviewRow extends Record<string, unknown> {
  organization_id: unknown; product_id: unknown; competitor_ad_id: unknown; analysis_version: unknown; input_fingerprint: unknown
  review_version: unknown; decision: unknown; corrections: unknown; reason: unknown; reviewer_user_id: unknown; reviewed_at: unknown
}
interface QueueRow extends ReviewRow {
  advertiser_name: unknown; model_provider: unknown; model_name: unknown; prompt_version: unknown; tags: unknown; analyzed_at: unknown
  provenance: unknown; analysis_mode: unknown; media_count: unknown; stale: unknown
}

const QUEUE_PROJECTION = `ca.organization_id,ca.product_id,ca.competitor_ad_id,ca.analysis_version,ca.input_fingerprint,
  ca.model_provider,ca.model_name,ca.prompt_version,ca.tags,ca.analyzed_at,ca.provenance,ca.analysis_mode,ca.media_count,
  a.advertiser_name,r.review_version,r.decision,r.corrections,r.reason,r.reviewer_user_id,r.reviewed_at`

export class PostgresCreativeTagReviewRepository {
  constructor(private readonly pool: SqlPool) {}

  async list(actorUserIdInput: string, organizationIdInput: string, options: { productId?: string; status?: CreativeTagReviewStatus; limit: number }): Promise<CreativeTagReviewItem[]> {
    const actorUserId = validateIdentifier(actorUserIdInput, 'Verified user ID')
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const productId = options.productId === undefined ? undefined : validateIdentifier(options.productId, 'Product ID')
    if (options.status !== undefined && !CREATIVE_TAG_REVIEW_STATUSES.includes(options.status)) throw new ValidationError('Review status is invalid')
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new ValidationError('Review limit is invalid')
    return withVerifiedUserReadContext(this.pool, actorUserId, async (connection) => {
      const result = await connection.query<QueueRow>(`WITH latest_analysis AS (
        SELECT DISTINCT ON (ca.competitor_ad_id) ca.*
        FROM creative_ad_analyses ca
        WHERE ca.organization_id=$1 AND ca.status='completed' AND ($2::text IS NULL OR ca.product_id=$2)
        ORDER BY ca.competitor_ad_id,ca.analyzed_at DESC,ca.updated_at DESC,ca.analysis_version DESC,ca.input_fingerprint DESC
      ), queue AS (
        SELECT ${QUEUE_PROJECTION},false AS stale,COALESCE(r.decision,'pending') AS review_status
        FROM latest_analysis ca JOIN competitor_ads a ON a.organization_id=ca.organization_id AND a.product_id=ca.product_id AND a.id=ca.competitor_ad_id
        LEFT JOIN LATERAL (SELECT cr.* FROM creative_analysis_reviews cr
          WHERE cr.organization_id=ca.organization_id AND cr.competitor_ad_id=ca.competitor_ad_id
            AND cr.analysis_version=ca.analysis_version AND cr.input_fingerprint=ca.input_fingerprint
          ORDER BY cr.review_version DESC LIMIT 1) r ON true
      ) SELECT * FROM queue WHERE ($3::text IS NULL OR review_status=$3)
        ORDER BY analyzed_at ASC,competitor_ad_id ASC LIMIT $4`, [organizationId, productId ?? null, options.status ?? null, options.limit])
      return result.rows.map(decodeQueueRow)
    })
  }

  async detail(actorUserIdInput: string, organizationIdInput: string, adIdInput: string, analysisVersionInput: string, fingerprintInput: string): Promise<CreativeTagReviewItem> {
    const actorUserId = validateIdentifier(actorUserIdInput, 'Verified user ID')
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const adId = validateIdentifier(adIdInput, 'Ad ID')
    const analysisVersion = bounded(analysisVersionInput, 128)
    const inputFingerprint = fingerprint(fingerprintInput)
    return withVerifiedUserReadContext(this.pool, actorUserId, async (connection) => {
      const result = await connection.query<QueueRow>(`SELECT ${QUEUE_PROJECTION},EXISTS (
          SELECT 1 FROM creative_ad_analyses newer WHERE newer.organization_id=ca.organization_id
            AND newer.competitor_ad_id=ca.competitor_ad_id AND newer.status='completed'
            AND (newer.analyzed_at,newer.updated_at,newer.analysis_version,newer.input_fingerprint)>(ca.analyzed_at,ca.updated_at,ca.analysis_version,ca.input_fingerprint)
        ) AS stale
        FROM creative_ad_analyses ca JOIN competitor_ads a ON a.organization_id=ca.organization_id AND a.product_id=ca.product_id AND a.id=ca.competitor_ad_id
        LEFT JOIN LATERAL (SELECT cr.* FROM creative_analysis_reviews cr WHERE cr.organization_id=ca.organization_id
          AND cr.competitor_ad_id=ca.competitor_ad_id AND cr.analysis_version=ca.analysis_version AND cr.input_fingerprint=ca.input_fingerprint
          ORDER BY cr.review_version DESC LIMIT 1) r ON true
        WHERE ca.organization_id=$1 AND ca.competitor_ad_id=$2 AND ca.analysis_version=$3 AND ca.input_fingerprint=$4 AND ca.status='completed'`,
      [organizationId, adId, analysisVersion, inputFingerprint])
      if (!result.rows[0]) throw new NotFoundError()
      return decodeQueueRow(result.rows[0])
    })
  }

  async history(actorUserIdInput: string, organizationIdInput: string, adIdInput: string, analysisVersionInput: string, fingerprintInput: string, limit: number): Promise<CreativeTagReview[]> {
    const actorUserId = validateIdentifier(actorUserIdInput, 'Verified user ID')
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const adId = validateIdentifier(adIdInput, 'Ad ID')
    const analysisVersion = bounded(analysisVersionInput, 128)
    const inputFingerprint = fingerprint(fingerprintInput)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ValidationError('Review history limit is invalid')
    return withVerifiedUserReadContext(this.pool, actorUserId, async (connection) => {
      const analysis = await connection.query(`SELECT 1 FROM creative_ad_analyses WHERE organization_id=$1 AND competitor_ad_id=$2 AND analysis_version=$3 AND input_fingerprint=$4 AND status='completed'`, [organizationId, adId, analysisVersion, inputFingerprint])
      if (analysis.rowCount !== 1) throw new NotFoundError()
      const result = await connection.query<ReviewRow>(`SELECT * FROM creative_analysis_reviews
        WHERE organization_id=$1 AND competitor_ad_id=$2 AND analysis_version=$3 AND input_fingerprint=$4
        ORDER BY review_version DESC LIMIT $5`, [organizationId, adId, analysisVersion, inputFingerprint, limit])
      return result.rows.map(decodeReviewRow)
    })
  }

  async submit(actorUserIdInput: string, organizationIdInput: string, adIdInput: string, analysisVersionInput: string, fingerprintInput: string, submissionInput: unknown): Promise<CreativeTagReview> {
    const actorUserId = validateIdentifier(actorUserIdInput, 'Verified user ID')
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const adId = validateIdentifier(adIdInput, 'Ad ID')
    const analysisVersion = bounded(analysisVersionInput, 128)
    const inputFingerprint = fingerprint(fingerprintInput)
    const submission = validateCreativeTagReviewSubmission(submissionInput)
    return withVerifiedUserContext(this.pool, actorUserId, async (connection) => {
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([organizationId, adId, analysisVersion, inputFingerprint])])
      const analysis = await connection.query<{ product_id: string }>(`SELECT ca.product_id FROM creative_ad_analyses ca
        WHERE ca.organization_id=$1 AND ca.competitor_ad_id=$2 AND ca.analysis_version=$3 AND ca.input_fingerprint=$4 AND ca.status='completed' FOR SHARE`,
      [organizationId, adId, analysisVersion, inputFingerprint])
      const productId = analysis.rows[0]?.product_id
      if (!productId) throw new NotFoundError()
      const current = await connection.query<{ review_version: number | string | null }>(`SELECT COALESCE(max(review_version),0) AS review_version FROM creative_analysis_reviews
        WHERE organization_id=$1 AND competitor_ad_id=$2 AND analysis_version=$3 AND input_fingerprint=$4`, [organizationId, adId, analysisVersion, inputFingerprint])
      const currentVersion = integer(current.rows[0]?.review_version ?? 0)
      if (currentVersion !== submission.expectedReviewVersion) throw new ConflictError('Creative tag review version changed')
      const inserted = await connection.query<ReviewRow>(`INSERT INTO creative_analysis_reviews
        (organization_id,product_id,competitor_ad_id,analysis_version,input_fingerprint,review_version,decision,corrections,reason,reviewer_user_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,app_verified_user_id()) RETURNING *`,
      [organizationId, productId, adId, analysisVersion, inputFingerprint, currentVersion + 1, submission.decision, submission.corrections === null ? null : JSON.stringify(submission.corrections), submission.reason])
      if (!inserted.rows[0]) throw new Error('Creative tag review was not stored')
      return decodeReviewRow(inserted.rows[0])
    })
  }
}

function decodeQueueRow(row: QueueRow): CreativeTagReviewItem {
  const analysis = decodeAnalysis(row)
  const review = row.review_version === null || row.review_version === undefined ? null : decodeReviewRow(row)
  if (typeof row.advertiser_name !== 'string' || row.advertiser_name.length < 1 || [...row.advertiser_name].length > 500) throw new Error('Stored creative tag review queue is invalid')
  if (typeof row.stale !== 'boolean') throw new Error('Stored creative tag review queue is invalid')
  return { advertiserName: row.advertiser_name, analysis, status: review?.decision ?? 'pending', review, originalTags: { ...analysis.tags }, effectiveTags: effectiveCreativeTags(analysis.tags, review), stale: row.stale }
}
function decodeAnalysis(row: QueueRow): CreativeAnalysisRecord {
  return {
    organizationId: identifier(row.organization_id), productId: identifier(row.product_id), competitorAdId: identifier(row.competitor_ad_id),
    analysisVersion: bounded(row.analysis_version, 128), modelProvider: bounded(row.model_provider, 64), modelName: bounded(row.model_name, 200), promptVersion: bounded(row.prompt_version, 128),
    inputFingerprint: fingerprint(row.input_fingerprint), tags: validateCreativeTags(row.tags), analyzedAt: storedTimestamp(row.analyzed_at, 'creative_tag_review.analyzed_at'),
    provenance: enumStored(row.provenance, ['manual','automatic'] as const), analysisMode: enumStored(row.analysis_mode, ['media','copy_only'] as const), mediaCount: integer(row.media_count),
  }
}
function decodeReviewRow(row: ReviewRow): CreativeTagReview {
  const decision = enumStored(row.decision, ['approved','rejected','corrected'] as const)
  const corrections = row.corrections === null ? null : decodeCorrections(row.corrections)
  if ((decision === 'corrected') !== (corrections !== null)) throw new Error('Stored creative tag review is invalid')
  return {
    organizationId: identifier(row.organization_id), productId: identifier(row.product_id), competitorAdId: identifier(row.competitor_ad_id), analysisVersion: bounded(row.analysis_version, 128),
    inputFingerprint: fingerprint(row.input_fingerprint), reviewVersion: positiveInteger(row.review_version), decision, corrections, reason: bounded(row.reason, 1_000),
    reviewerUserId: identifier(row.reviewer_user_id), reviewedAt: storedTimestamp(row.reviewed_at, 'creative_tag_review.reviewed_at'),
  }
}
function decodeCorrections(value: unknown): CreativeTagCorrections {
  return validateCreativeTagReviewSubmission({ expectedReviewVersion: 0, decision: 'corrected', corrections: value, reason: 'stored' }).corrections!
}
function enumStored<const T extends readonly string[]>(value: unknown, allowed: T): T[number] { if (typeof value !== 'string' || !allowed.includes(value)) throw new Error('Stored creative tag review is invalid'); return value as T[number] }
function bounded(value: unknown, maximum: number): string { if (typeof value !== 'string' || value.length < 1 || [...value].length > maximum || value !== value.trim()) throw new Error('Stored creative tag review is invalid'); return value }
function identifier(value: unknown): string { return validateIdentifier(value, 'Stored creative tag review ID') }
function fingerprint(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new ValidationError('Analysis fingerprint is invalid'); return value }
function integer(value: unknown): number { const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value; if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) throw new Error('Stored creative tag review version is invalid'); return parsed as number }
function positiveInteger(value: unknown): number { const parsed = integer(value); if (parsed < 1) throw new Error('Stored creative tag review version is invalid'); return parsed }
