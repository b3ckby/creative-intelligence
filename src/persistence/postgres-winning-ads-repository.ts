import { ConflictError, DataIntegrityError, NotFoundError, ValidationError } from '../domain/errors.ts'
import { validateIdentifier } from '../domain/identifiers.ts'
import { validatePageLimit } from '../domain/page-limit.ts'
import { normalizeCanonicalText } from '../domain/validation.ts'
import { validateCreativeTags } from '../creative-analysis/creative-analysis-service.ts'
import { attachExactCursorTimestamp, type CursorPosition } from '../http/pagination.ts'
import { WINNING_AD_CATEGORIES, type WinningAd, type WinningAdCategory } from '../domain/types.ts'
import type { SqlConnection, SqlPool } from './postgres-organization-repository.ts'
import { storedIdentifier, storedTimestamp } from './catalog-row-decoders.ts'
import { withVerifiedUserContext } from './verified-user-context.ts'

export interface WinningAdMetadataInput { title: string; category: WinningAdCategory; notes: string }
export interface WinningAdUpdateInput extends WinningAdMetadataInput { expectedVersion: number }
export interface WinningAdPageOptions {
  limit: number
  cursor?: CursorPosition
  includeArchived: boolean
  search?: string
  category?: WinningAdCategory
  active?: boolean
}

export class PostgresWinningAdsRepository {
  constructor(private readonly pool: SqlPool, private readonly createId: () => string, private readonly now: () => Date) {}

  async save(userIdInput: string, organizationIdInput: string, sourceAdIdInput: string, input: WinningAdMetadataInput): Promise<WinningAd> {
    const userId = validateIdentifier(userIdInput, 'Verified user ID')
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const sourceAdId = validateIdentifier(sourceAdIdInput, 'Source ad ID')
    const metadata = normalizeMetadata(input)
    const id = validateIdentifier(this.createId(), 'Generated winning ad ID')
    const createdAt = instant(this.now())
    return withVerifiedUserContext(this.pool, userId, async (client) => {
      const result = await client.query<WinningAdRow>(
        `INSERT INTO winning_ads (
           id,organization_id,source_ad_id,title,category,notes,source_provider,source_platform,
           source_external_id,source_url,advertiser_name,source_is_active,body,headline,description,call_to_action,
           analysis_tags,analysis_provenance,analysis_version,analysis_analyzed_at,created_by,created_at,updated_at
         )
         SELECT $3,a.organization_id,a.id,$4,$5,$6,a.provider_name,a.platform,a.external_id,a.source_url,
                a.advertiser_name,a.is_active,a.body,a.headline,a.description,a.call_to_action,
                latest.tags,latest.provenance,latest.analysis_version,latest.analyzed_at,$7,$8,$8
         FROM competitor_ads a
         JOIN products product ON product.organization_id=a.organization_id AND product.id=a.product_id AND product.archived_at IS NULL
         JOIN competitors competitor ON competitor.organization_id=a.organization_id AND competitor.product_id=a.product_id AND competitor.id=a.competitor_id AND competitor.archived_at IS NULL
         LEFT JOIN LATERAL (
           SELECT ca.tags,ca.provenance,ca.analysis_version,ca.analyzed_at
           FROM creative_ad_analyses ca
           WHERE ca.organization_id=a.organization_id AND ca.competitor_ad_id=a.id AND ca.status = 'completed'
           ORDER BY ca.analyzed_at DESC,ca.updated_at DESC,ca.analysis_version DESC,ca.input_fingerprint DESC LIMIT 1
         ) latest ON true
         WHERE a.organization_id=$1 AND a.id=$2
           AND EXISTS (
             SELECT 1 FROM competitor_ad_media_positions p
             JOIN creative_media_blobs b ON b.checksum=p.active_checksum
             WHERE p.organization_id=a.organization_id AND p.ad_id=a.id
               AND p.status = 'succeeded' AND p.active_checksum IS NOT NULL
           )
         ON CONFLICT (organization_id,source_ad_id) DO UPDATE SET source_ad_id=winning_ads.source_ad_id
         RETURNING *`,
        [organizationId, sourceAdId, id, metadata.title, metadata.category, metadata.notes, userId, createdAt],
      )
      const saved = result.rows[0]
      if (!saved) throw new ValidationError('Ad is unavailable or has no trusted mirrored media', 'Ad cannot be saved until mirrored media is available')
      await client.query(
        `INSERT INTO winning_ad_media(organization_id,winning_ad_id,position,media_kind,media_type,checksum)
         SELECT $1,$2,row_number() OVER (ORDER BY mirrored.slot_order,mirrored.source_position,mirrored.active_checksum)-1,
                mirrored.media_kind,mirrored.media_type,mirrored.active_checksum
         FROM (
           SELECT p.media_kind,b.media_type,p.active_checksum,p.position AS source_position,
                  CASE p.slot_kind WHEN 'structured_source' THEN 0 WHEN 'structured_poster' THEN 1 ELSE 2 END AS slot_order
           FROM competitor_ad_media_positions p JOIN creative_media_blobs b ON b.checksum=p.active_checksum
           WHERE p.organization_id=$1 AND p.ad_id=$3 AND p.status='succeeded' AND p.active_checksum IS NOT NULL
           ORDER BY slot_order,p.position,p.active_checksum LIMIT 50
         ) mirrored
         ORDER BY mirrored.slot_order,mirrored.source_position,mirrored.active_checksum
         ON CONFLICT DO NOTHING`,
        [organizationId, saved.id, sourceAdId],
      )
      return await requireById(client, organizationId, saved.id)
    })
  }

  async page(userId: string, organizationIdInput: string, options: WinningAdPageOptions): Promise<WinningAd[]> {
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const limit = validatePageLimit(options.limit)
    const search = options.search === undefined ? undefined : normalizeCanonicalText(options.search, 'Search', { maxLength: 200 })
    const category = options.category === undefined ? undefined : categoryValue(options.category)
    return withVerifiedUserContext(this.pool, userId, async (client) => {
      const values: unknown[] = [organizationId]
      const predicates = ['winning_ads.organization_id = $1']
      if (!options.includeArchived) predicates.push('winning_ads.archived_at IS NULL')
      if (search !== undefined) { values.push(search); predicates.push(`to_tsvector('simple',winning_ads.title||' '||winning_ads.advertiser_name||' '||winning_ads.body||' '||coalesce(winning_ads.headline,'')||' '||winning_ads.notes) @@ plainto_tsquery('simple',$${values.length})`) }
      if (category !== undefined) { values.push(category); predicates.push(`winning_ads.category = $${values.length}`) }
      if (options.active !== undefined) { values.push(options.active); predicates.push(`winning_ads.source_is_active = $${values.length}`) }
      if (options.cursor) {
        values.push(options.cursor.createdAt, options.cursor.id)
        predicates.push(`(EXTRACT(EPOCH FROM winning_ads.created_at)>$${values.length - 1}::numeric OR (EXTRACT(EPOCH FROM winning_ads.created_at)=$${values.length - 1}::numeric AND winning_ads.id>$${values.length}))`)
      }
      values.push(limit + 1)
      const result = await client.query<WinningAdRow>(
        `${projection()} FROM winning_ads ${mediaJoin()} WHERE ${predicates.join(' AND ')}
         ORDER BY winning_ads.created_at,winning_ads.id LIMIT $${values.length}`,
        values,
      )
      return result.rows.map(decodeWinningAd)
    })
  }

  async find(userId: string, organizationIdInput: string, idInput: string, includeArchived = false): Promise<WinningAd | undefined> {
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const id = validateIdentifier(idInput, 'Winning ad ID')
    return withVerifiedUserContext(this.pool, userId, async (client) => {
      const result = await client.query<WinningAdRow>(`${projection()} FROM winning_ads ${mediaJoin()} WHERE winning_ads.organization_id=$1 AND winning_ads.id=$2 ${includeArchived ? '' : 'AND winning_ads.archived_at IS NULL'}`, [organizationId, id])
      return result.rows[0] && decodeWinningAd(result.rows[0])
    })
  }

  async update(userId: string, organizationIdInput: string, idInput: string, input: WinningAdUpdateInput): Promise<WinningAd> {
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const id = validateIdentifier(idInput, 'Winning ad ID')
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new ValidationError('Expected version is invalid')
    const metadata = normalizeMetadata(input)
    const updatedAt = instant(this.now())
    return withVerifiedUserContext(this.pool, userId, async (client) => {
      const result = await client.query<WinningAdRow>(
        `UPDATE winning_ads SET title = $3,category = $4,notes = $5,version = version + 1,updated_at = $7
         WHERE organization_id = $1 AND id = $2 AND version = $6 RETURNING *`,
        [organizationId, id, metadata.title, metadata.category, metadata.notes, input.expectedVersion, updatedAt],
      )
      if (!result.rows[0]) {
        const found = await client.query('SELECT 1 FROM winning_ads WHERE organization_id=$1 AND id=$2', [organizationId, id])
        if (found.rowCount === 1) throw new ConflictError('Winning ad version is stale')
        throw new NotFoundError()
      }
      return requireById(client, organizationId, id)
    })
  }

  async archive(userId: string, organizationIdInput: string, idInput: string): Promise<WinningAd> {
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const id = validateIdentifier(idInput, 'Winning ad ID')
    const archivedAt = instant(this.now())
    return withVerifiedUserContext(this.pool, userId, async (client) => {
      const result = await client.query(`UPDATE winning_ads SET archived_at=COALESCE(archived_at,$3),updated_at=$3 WHERE organization_id=$1 AND id=$2 RETURNING id`, [organizationId, id, archivedAt])
      if (result.rowCount !== 1) throw new NotFoundError()
      return requireById(client, organizationId, id)
    })
  }

  async remove(userId: string, organizationIdInput: string, idInput: string): Promise<void> {
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const id = validateIdentifier(idInput, 'Winning ad ID')
    await withVerifiedUserContext(this.pool, userId, async (client) => {
      const result = await client.query('DELETE FROM winning_ads WHERE organization_id=$1 AND id=$2 RETURNING id', [organizationId, id])
      if (result.rowCount !== 1) throw new NotFoundError()
    })
  }
}

function normalizeMetadata(input: WinningAdMetadataInput): WinningAdMetadataInput {
  return {
    title: normalizeCanonicalText(input.title, 'Winning ad title', { maxLength: 300 }),
    category: categoryValue(input.category),
    notes: normalizeCanonicalText(input.notes, 'Winning ad notes', { maxLength: 2_000, allowEmpty: true }),
  }
}
function categoryValue(value: unknown): WinningAdCategory {
  if (typeof value !== 'string' || !WINNING_AD_CATEGORIES.includes(value as WinningAdCategory)) throw new ValidationError('Winning ad category is invalid')
  return value as WinningAdCategory
}
function instant(value: Date): string { if (!Number.isFinite(value.getTime())) throw new Error('Winning ad clock is invalid'); return value.toISOString() }
function projection(): string { return `SELECT winning_ads.*,EXTRACT(EPOCH FROM winning_ads.created_at)::text AS cursor_created_at,COALESCE(media.items,'[]'::jsonb) AS media_items` }
function mediaJoin(): string { return `LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('position',m.position,'kind',m.media_kind,'mediaType',m.media_type,'checksum',m.checksum) ORDER BY m.position) items FROM winning_ad_media m WHERE m.organization_id=winning_ads.organization_id AND m.winning_ad_id=winning_ads.id) media ON true` }
async function requireById(client: SqlConnection, organizationId: string, id: string): Promise<WinningAd> {
  const result = await client.query<WinningAdRow>(`${projection()} FROM winning_ads ${mediaJoin()} WHERE winning_ads.organization_id=$1 AND winning_ads.id=$2`, [organizationId, id])
  if (!result.rows[0]) throw new NotFoundError()
  return decodeWinningAd(result.rows[0])
}

type WinningAdRow = Record<string, unknown> & {
  id: string; organization_id: string; source_ad_id: string; title: string; category: string; notes: string
  source_provider: string; source_platform: string; source_external_id: string; source_url: string; advertiser_name: string; source_is_active: boolean
  body: string; headline: string | null; description: string | null; call_to_action: string | null
  analysis_tags: unknown; analysis_provenance: string | null; analysis_version: string | null; analysis_analyzed_at: Date | string | null
  version: number; archived_at: Date | string | null; created_at: Date | string; updated_at: Date | string; cursor_created_at?: string; media_items: unknown
}
function decodeWinningAd(row: WinningAdRow): WinningAd {
  try {
    if (!WINNING_AD_CATEGORIES.includes(row.category as WinningAdCategory) || row.source_platform !== 'meta' || typeof row.source_is_active !== 'boolean' || !Number.isSafeInteger(row.version) || row.version < 1) throw new Error()
    if (!Array.isArray(row.media_items) || row.media_items.length < 1 || row.media_items.length > 50) throw new Error()
    const media = row.media_items.map((value, index) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error()
      const item = value as Record<string, unknown>
      if (item.position !== index || (item.kind !== 'image' && item.kind !== 'video' && item.kind !== 'unknown') || typeof item.mediaType !== 'string' || typeof item.checksum !== 'string' || !/^[a-f0-9]{64}$/u.test(item.checksum)) throw new Error()
      return { position: index, kind: item.kind, mediaType: item.mediaType, checksum: item.checksum, url: `/media/sha256/${item.checksum}` } as WinningAd['media'][number]
    })
    const provenance: 'manual' | 'automatic' | null = row.analysis_provenance === 'manual' || row.analysis_provenance === 'automatic' ? row.analysis_provenance : null
    const analysis = row.analysis_tags === null ? null : {
      tags: { ...validateCreativeTags(row.analysis_tags) },
      provenance: provenance ?? (() => { throw new Error() })(),
      version: normalizeCanonicalText(row.analysis_version, 'Stored analysis version', { maxLength: 128 }),
      analyzedAt: storedTimestamp(row.analysis_analyzed_at as Date | string, 'winning_ad.analysis_analyzed_at'),
    }
    const result: WinningAd = {
      id: storedIdentifier(row.id, 'winning_ad.id'), organizationId: storedIdentifier(row.organization_id, 'winning_ad.organization_id'), sourceAdId: storedIdentifier(row.source_ad_id, 'winning_ad.source_ad_id'),
      title: normalizeCanonicalText(row.title, 'Stored winning ad title', { maxLength: 300 }), category: row.category as WinningAdCategory,
      notes: normalizeCanonicalText(row.notes, 'Stored winning ad notes', { maxLength: 2_000, allowEmpty: true }),
      source: { provider: normalizeCanonicalText(row.source_provider, 'Stored provider', { maxLength: 64 }), platform: 'meta', externalId: storedIdentifier(row.source_external_id, 'winning_ad.external_id'), url: row.source_url, advertiserName: normalizeCanonicalText(row.advertiser_name, 'Stored advertiser', { maxLength: 500 }), isActive: row.source_is_active },
      copy: { body: normalizeCanonicalText(row.body, 'Stored body', { maxLength: 20_000, allowEmpty: true }), headline: row.headline, description: row.description, callToAction: row.call_to_action },
      media, analysis, version: row.version, archivedAt: row.archived_at === null ? null : storedTimestamp(row.archived_at, 'winning_ad.archived_at'),
      createdAt: storedTimestamp(row.created_at, 'winning_ad.created_at'), updatedAt: storedTimestamp(row.updated_at, 'winning_ad.updated_at'),
    }
    if (row.cursor_created_at === undefined) return result
    if (typeof row.cursor_created_at !== 'string' || !/^\d{1,20}(?:\.\d{1,6})?$/u.test(row.cursor_created_at)) throw new Error()
    return attachExactCursorTimestamp(result, row.cursor_created_at)
  } catch (error) {
    if (error instanceof DataIntegrityError) throw error
    throw new DataIntegrityError('Stored winning ad failed data-integrity validation')
  }
}
