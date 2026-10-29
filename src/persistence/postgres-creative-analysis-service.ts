import { randomBytes } from 'node:crypto'

import {
  CreativeAnalysisService,
  type CreativeAnalysisRecord,
  type CreativeAnalysisRepository,
  type CreativeMediaDescriptor,
  type CreativeTagger,
  validateCreativeTags,
} from '../creative-analysis/creative-analysis-service.ts'
import { ApplicationError, ConflictError, NotFoundError } from '../domain/errors.ts'
import { validateIdentifier } from '../domain/identifiers.ts'
import type { CompetitorAd } from '../domain/types.ts'
import type { MediaStore } from '../media/content-addressed-store.ts'
import { decodeAdRow, storedTimestamp } from './catalog-row-decoders.ts'
import type { SqlPool } from './postgres-organization-repository.ts'
import { withVerifiedUserContext, withVerifiedUserReadContext } from './verified-user-context.ts'

interface AnalysisRow extends Record<string, unknown> {
  organization_id: unknown
  product_id: unknown
  competitor_ad_id: unknown
  analysis_version: unknown
  model_provider: unknown
  model_name: unknown
  prompt_version: unknown
  input_fingerprint: unknown
  tags: unknown
  analyzed_at: unknown
  provenance: unknown
  analysis_mode: unknown
  media_count: unknown
}

export class PostgresCreativeAnalysisService {
  private readonly service: CreativeAnalysisService

  constructor(pool: SqlPool, tagger: CreativeTagger, now: () => Date, dailyLimit: number, private readonly mediaStore?: MediaStore) {
    this.service = new CreativeAnalysisService(new PostgresCreativeAnalysisRepository(pool, dailyLimit), tagger, now)
    this.pool = pool
  }

  private readonly pool: SqlPool

  async analyze(actorUserIdInput: string, organizationIdInput: string, productIdInput: string, adIdInput: string): Promise<CreativeAnalysisRecord> {
    const actorUserId = validateIdentifier(actorUserIdInput, 'Verified user ID')
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const productId = validateIdentifier(productIdInput, 'Product ID')
    const adId = validateIdentifier(adIdInput, 'Ad ID')
    const ad = await withVerifiedUserReadContext(this.pool, actorUserId, async (connection) => {
      const result = await connection.query<Record<string, unknown>>(
        `SELECT a.*
         FROM competitor_ads a
         JOIN products p ON p.organization_id = a.organization_id AND p.id = a.product_id
         JOIN competitors c ON c.organization_id = a.organization_id AND c.product_id = a.product_id AND c.id = a.competitor_id
         WHERE a.organization_id = $1 AND a.product_id = $2 AND a.id = $3
           AND p.archived_at IS NULL AND c.archived_at IS NULL`,
        [organizationId, productId, adId],
      )
      const row = result.rows[0]
      if (!row) throw new NotFoundError()
      return decodeAdRow(row)
    })
    const media = this.mediaStore ? await this.loadMedia(actorUserId, organizationId, adId) : []
    return this.service.analyze(actorUserId, ad, media)
  }

  private async loadMedia(actorUserId: string, organizationId: string, adId: string): Promise<CreativeMediaDescriptor[]> {
    const rows = await withVerifiedUserReadContext(this.pool, actorUserId, async (connection) => (await connection.query<{
      slot_kind: CreativeMediaDescriptor['slotKind']; media_position: number; checksum: string; media_type: CreativeMediaDescriptor['mediaType']; byte_size: string | number
    }>('SELECT * FROM app_get_creative_analysis_media($1,$2,$3)', [organizationId, adId, 4])).rows)
    const loaded: CreativeMediaDescriptor[] = []
    for (const row of rows) {
      const stored = await this.mediaStore!.read(row.checksum)
      const byteSize = Number(row.byte_size)
      if (stored.mediaType !== row.media_type || stored.byteSize !== byteSize) throw new Error('Mirrored media metadata mismatch')
      loaded.push({ slotKind: row.slot_kind, position: row.media_position, checksum: row.checksum, mediaType: row.media_type, byteSize, bytes: stored.bytes })
    }
    return loaded
  }
}

class PostgresCreativeAnalysisRepository implements CreativeAnalysisRepository {
  constructor(private readonly pool: SqlPool, private readonly dailyLimit: number) {
    if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 10_000) throw new Error('Creative analysis daily limit is invalid')
  }

  async findCompleted(actorUserId: string, ad: CompetitorAd, analysisVersion: string, inputFingerprint: string): Promise<CreativeAnalysisRecord | undefined> {
    return withVerifiedUserReadContext(this.pool, actorUserId, async (connection) => {
      const result = await connection.query<AnalysisRow>(
        `SELECT organization_id, product_id, competitor_ad_id, analysis_version, model_provider,
                model_name, prompt_version, input_fingerprint, tags, analyzed_at, provenance, analysis_mode, media_count
         FROM creative_ad_analyses
         WHERE organization_id = $1 AND product_id = $2 AND competitor_ad_id = $3
           AND analysis_version = $4 AND input_fingerprint = $5 AND status = 'completed'
         LIMIT 1`,
        [ad.organizationId, ad.productId, ad.id, analysisVersion, inputFingerprint],
      )
      return result.rows[0] ? decodeAnalysisRow(result.rows[0]) : undefined
    })
  }

  async acquireClaim(actorUserId: string, ad: CompetitorAd, analysisVersion: string, inputFingerprint: string): Promise<{ claimToken: string } | undefined> {
    const claimToken = randomBytes(32).toString('hex')
    return withVerifiedUserContext(this.pool, actorUserId, async (connection) => {
      const allowed = await connection.query<{ allowed: boolean }>(
        `SELECT true AS allowed
         FROM competitor_ads a
         JOIN products p ON p.organization_id = a.organization_id AND p.id = a.product_id
         JOIN competitors c ON c.organization_id = a.organization_id AND c.product_id = a.product_id AND c.id = a.competitor_id
         WHERE a.organization_id = $1 AND a.product_id = $2 AND a.id = $3
           AND p.archived_at IS NULL AND c.archived_at IS NULL
         FOR UPDATE OF a`,
        [ad.organizationId, ad.productId, ad.id],
      )
      if (allowed.rows[0]?.allowed !== true) throw new NotFoundError()
      const claimed = await connection.query<{ claim_token: string }>(
        `INSERT INTO creative_ad_analyses (
           organization_id, product_id, competitor_ad_id, analysis_version, model_provider, model_name,
           prompt_version, input_fingerprint, status, claim_token, claim_expires_at, tags, analyzed_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'pending', 'pending', 'pending', $5, 'pending', $6, statement_timestamp() + interval '5 minutes', NULL, NULL, statement_timestamp(), statement_timestamp())
         ON CONFLICT (organization_id, competitor_ad_id, analysis_version, input_fingerprint) DO UPDATE
         SET product_id = EXCLUDED.product_id, model_provider = 'pending', model_name = 'pending', prompt_version = 'pending',
             status = 'pending', claim_token = EXCLUDED.claim_token, claim_expires_at = EXCLUDED.claim_expires_at,
             tags = NULL, analyzed_at = NULL, updated_at = EXCLUDED.updated_at
         WHERE creative_ad_analyses.status = 'failed'
            OR (creative_ad_analyses.status = 'pending' AND creative_ad_analyses.claim_expires_at <= statement_timestamp())
         RETURNING claim_token`,
        [ad.organizationId, ad.productId, ad.id, analysisVersion, inputFingerprint, claimToken],
      )
      return claimed.rows[0]?.claim_token === claimToken ? { claimToken } : undefined
    })
  }

  async consumeUsage(actorUserId: string, ad: CompetitorAd, analysisVersion: string, inputFingerprint: string, claimToken: string): Promise<void> {
    await withVerifiedUserContext(this.pool, actorUserId, async (connection) => {
      const activeClaim = await connection.query<{ allowed: boolean }>(
        `SELECT true AS allowed FROM creative_ad_analyses
         WHERE organization_id = $1 AND product_id = $2 AND competitor_ad_id = $3
           AND analysis_version = $4 AND input_fingerprint = $5 AND status = 'pending'
           AND claim_token = $6 AND claim_expires_at > statement_timestamp()
         FOR UPDATE`,
        [ad.organizationId, ad.productId, ad.id, analysisVersion, inputFingerprint, claimToken],
      )
      if (activeClaim.rows[0]?.allowed !== true) throw new ConflictError('Creative analysis claim expired')
      const usage = await connection.query<{ usage_count: number }>(
        `INSERT INTO creative_analysis_daily_usage (organization_id, usage_date, usage_count, updated_at)
         VALUES ($1, (statement_timestamp() AT TIME ZONE 'UTC')::date, 1, statement_timestamp())
         ON CONFLICT (organization_id, usage_date) DO UPDATE
         SET usage_count = creative_analysis_daily_usage.usage_count + 1, updated_at = EXCLUDED.updated_at
         WHERE creative_analysis_daily_usage.usage_count < $2
         RETURNING usage_count`,
        [ad.organizationId, this.dailyLimit],
      )
      if (!usage.rows[0]) throw new ApplicationError(429, 'AI analysis daily limit reached')
    })
  }

  async complete(actorUserId: string, record: CreativeAnalysisRecord, claimToken: string): Promise<void> {
    await withVerifiedUserContext(this.pool, actorUserId, async (connection) => {
      const result = await connection.query(
        `UPDATE creative_ad_analyses
         SET model_provider = $5, model_name = $6, prompt_version = $7, status = 'completed',
             claim_token = NULL, claim_expires_at = NULL, tags = $8::jsonb, analyzed_at = $9,
             provenance = $12, analysis_mode = $13, media_count = $14, failure_category = NULL, updated_at = statement_timestamp()
         WHERE organization_id = $1 AND product_id = $2 AND competitor_ad_id = $3
           AND analysis_version = $4 AND input_fingerprint = $10 AND status = 'pending' AND claim_token = $11`,
        [record.organizationId, record.productId, record.competitorAdId, record.analysisVersion,
          record.modelProvider, record.modelName, record.promptVersion, JSON.stringify(record.tags), record.analyzedAt, record.inputFingerprint, claimToken,
          record.provenance, record.analysisMode, record.mediaCount],
      )
      if (result.rowCount !== 1) throw new Error('Creative analysis claim was lost')
    })
  }

  async fail(actorUserId: string, ad: CompetitorAd, analysisVersion: string, inputFingerprint: string, claimToken: string): Promise<void> {
    await withVerifiedUserContext(this.pool, actorUserId, async (connection) => {
      const result = await connection.query(
        `UPDATE creative_ad_analyses
         SET status = 'failed', claim_token = NULL, claim_expires_at = NULL, tags = NULL, analyzed_at = NULL, updated_at = statement_timestamp()
         WHERE organization_id = $1 AND product_id = $2 AND competitor_ad_id = $3
           AND analysis_version = $4 AND input_fingerprint = $5 AND status = 'pending' AND claim_token = $6`,
        [ad.organizationId, ad.productId, ad.id, analysisVersion, inputFingerprint, claimToken],
      )
      if (result.rowCount !== 1) throw new Error('Creative analysis claim was lost')
    })
  }
}

function decodeAnalysisRow(row: AnalysisRow): CreativeAnalysisRecord {
  return {
    organizationId: identifier(row.organization_id), productId: identifier(row.product_id), competitorAdId: identifier(row.competitor_ad_id),
    analysisVersion: bounded(row.analysis_version, 128), modelProvider: bounded(row.model_provider, 64), modelName: bounded(row.model_name, 200),
    promptVersion: bounded(row.prompt_version, 128), inputFingerprint: fingerprint(row.input_fingerprint), tags: validateCreativeTags(row.tags),
    analyzedAt: storedTimestamp(row.analyzed_at, 'creative_analysis.analyzed_at'),
    provenance: enumStored(row.provenance, ['manual', 'automatic'] as const),
    analysisMode: enumStored(row.analysis_mode, ['media', 'copy_only'] as const),
    mediaCount: storedInteger(row.media_count, 0, 16),
  }
}
function enumStored<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new Error('Stored creative analysis is invalid')
  return value as T[number]
}
function storedInteger(value: unknown, minimum: number, maximum: number): number {
  const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(parsed) || (parsed as number) < minimum || (parsed as number) > maximum) throw new Error('Stored creative analysis is invalid')
  return parsed as number
}
function identifier(value: unknown): string { return validateIdentifier(value, 'Stored creative analysis ID') }
function bounded(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value !== value.trim()) throw new Error('Stored creative analysis is invalid')
  return value
}
function fingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Error('Stored creative analysis is invalid')
  return value
}
