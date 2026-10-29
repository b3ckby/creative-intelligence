import { ConflictError, DataIntegrityError, NotFoundError, ValidationError } from '../domain/errors.ts'
import { validateIdentifier } from '../domain/identifiers.ts'
import { validatePageLimit } from '../domain/page-limit.ts'
import { normalizeCanonicalText } from '../domain/validation.ts'
import { attachExactCursorTimestamp, type CursorPosition } from '../http/pagination.ts'
import type { InspirationBoard, InspirationItem, InspirationSort, InspirationSourceKind } from '../domain/types.ts'
import type { SqlConnection, SqlPool } from './postgres-organization-repository.ts'
import { storedIdentifier, storedTimestamp } from './catalog-row-decoders.ts'
import { withVerifiedUserContext } from './verified-user-context.ts'

export interface InspirationBoardInput { name: string; description: string }
export interface InspirationItemInput { sourceKind: InspirationSourceKind; sourceId: string; title: string; notes: string; tags: string[] }
export interface InspirationItemUpdate { expectedVersion: number; boardId: string; title: string; notes: string; tags: string[] }
export interface InspirationItemPageOptions {
  limit: number; cursor?: CursorPosition; includeArchived: boolean; boardId?: string; search?: string; tag?: string; sourceKind?: InspirationSourceKind; sort?: InspirationSort
}

export class PostgresInspirationRepository {
  constructor(private readonly pool: SqlPool, private readonly createId: () => string, private readonly now: () => Date) {}

  async createBoard(userId: string, organizationIdInput: string, input: InspirationBoardInput): Promise<InspirationBoard> {
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const id = validateIdentifier(this.createId(), 'Generated inspiration board ID')
    const metadata = boardMetadata(input)
    const instant = timestamp(this.now())
    return withVerifiedUserContext(this.pool, userId, async (client) => {
      const result = await client.query<BoardRow>(
        `INSERT INTO inspiration_boards(id,organization_id,name,description,created_by,created_at,updated_at)
         VALUES($2,$1,$3,$4,$5,$6,$6) RETURNING *`,
        [organizationId, id, metadata.name, metadata.description, validateIdentifier(userId, 'Verified user ID'), instant],
      )
      if (!result.rows[0]) throw new NotFoundError()
      return decodeBoard(result.rows[0])
    })
  }

  async pageBoards(userId: string, organizationIdInput: string, options: { limit: number; cursor?: CursorPosition; includeArchived: boolean }): Promise<InspirationBoard[]> {
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const limit = validatePageLimit(options.limit)
    return withVerifiedUserContext(this.pool, userId, async (client) => {
      const values: unknown[] = [organizationId]
      const predicates = ['organization_id=$1', ...(options.includeArchived ? [] : ['archived_at IS NULL'])]
      if (options.cursor) { values.push(options.cursor.createdAt, options.cursor.id); predicates.push(`(EXTRACT(EPOCH FROM created_at)>$${values.length - 1}::numeric OR (EXTRACT(EPOCH FROM created_at)=$${values.length - 1}::numeric AND id>$${values.length}))`) }
      values.push(limit + 1)
      const result = await client.query<BoardRow>(`SELECT *,EXTRACT(EPOCH FROM created_at)::text cursor_created_at FROM inspiration_boards WHERE ${predicates.join(' AND ')} ORDER BY created_at,id LIMIT $${values.length}`, values)
      return result.rows.map(decodeBoard)
    })
  }

  async addItem(userId: string, organizationIdInput: string, boardIdInput: string, input: InspirationItemInput): Promise<InspirationItem> {
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const boardId = validateIdentifier(boardIdInput, 'Inspiration board ID')
    const sourceId = validateIdentifier(input.sourceId, 'Inspiration source ID')
    const sourceKind = sourceKindValue(input.sourceKind)
    const metadata = itemMetadata(input)
    const id = validateIdentifier(this.createId(), 'Generated inspiration item ID')
    const instant = timestamp(this.now())
    return withVerifiedUserContext(this.pool, userId, async (client) => {
      const result = await client.query<ItemRow>(
        `WITH source AS (
           SELECT 'competitor_ad'::text source_kind,a.id source_ref_id,a.provider_name source_provider,a.platform source_platform,
                  a.external_id source_external_id,a.source_url,a.advertiser_name,a.body,a.headline
           FROM competitor_ads a
           JOIN products p ON p.organization_id=a.organization_id AND p.id=a.product_id AND p.archived_at IS NULL
           JOIN competitors c ON c.organization_id=a.organization_id AND c.id=a.competitor_id AND c.product_id=a.product_id AND c.archived_at IS NULL
           WHERE $3='competitor_ad' AND a.organization_id=$1 AND a.id=$4 AND EXISTS (
             SELECT 1 FROM competitor_ad_media_positions mp JOIN creative_media_blobs mb ON mb.checksum=mp.active_checksum
             WHERE mp.organization_id=a.organization_id AND mp.ad_id=a.id AND mp.status='succeeded' AND mp.active_checksum IS NOT NULL)
           UNION ALL
           SELECT 'winning_ad',w.id,w.source_provider,w.source_platform,w.source_external_id,w.source_url,w.advertiser_name,w.body,w.headline
           FROM winning_ads w WHERE $3='winning_ad' AND w.organization_id=$1 AND w.id=$4 AND w.archived_at IS NULL AND EXISTS (
             SELECT 1 FROM winning_ad_media wm JOIN creative_media_blobs mb ON mb.checksum=wm.checksum
             WHERE wm.organization_id=w.organization_id AND wm.winning_ad_id=w.id)
         )
         INSERT INTO inspiration_items(id,organization_id,board_id,source_kind,source_ref_id,title,notes,tags,source_provider,source_platform,source_external_id,source_url,advertiser_name,body,headline,created_by,created_at,updated_at)
         SELECT $5,$1,b.id,source.source_kind,source.source_ref_id,$6,$7,$8,source.source_provider,source.source_platform,source.source_external_id,source.source_url,source.advertiser_name,source.body,source.headline,$9,$10,$10
         FROM inspiration_boards b CROSS JOIN source WHERE b.organization_id=$1 AND b.id=$2 AND b.archived_at IS NULL
         ON CONFLICT (organization_id,board_id,source_kind,source_ref_id) DO UPDATE SET source_ref_id=inspiration_items.source_ref_id
         RETURNING *`,
        [organizationId, boardId, sourceKind, sourceId, id, metadata.title, metadata.notes, metadata.tags, validateIdentifier(userId, 'Verified user ID'), instant],
      )
      const saved = result.rows[0]
      if (!saved) throw new ValidationError('Source is unavailable or has no trusted mirrored media', 'Source cannot be added until trusted mirrored media is available')
      await client.query(
        `INSERT INTO inspiration_item_media(organization_id,inspiration_item_id,position,media_kind,media_type,checksum)
         SELECT $1,$2,row_number() OVER (ORDER BY source.position,source.checksum)-1,source.media_kind,source.media_type,source.checksum
         FROM (
           SELECT mp.position,mp.media_kind,mb.media_type,mp.active_checksum checksum
           FROM competitor_ad_media_positions mp JOIN creative_media_blobs mb ON mb.checksum=mp.active_checksum
           WHERE $3='competitor_ad' AND mp.organization_id=$1 AND mp.ad_id=$4 AND mp.status='succeeded' AND mp.active_checksum IS NOT NULL
           UNION ALL
           SELECT wm.position,wm.media_kind,wm.media_type,wm.checksum FROM winning_ad_media wm
           WHERE $3='winning_ad' AND wm.organization_id=$1 AND wm.winning_ad_id=$4
         ) source ORDER BY source.position,source.checksum LIMIT 50 ON CONFLICT DO NOTHING`,
        [organizationId, saved.id, sourceKind, sourceId],
      )
      return requireItem(client, organizationId, saved.id)
    })
  }

  async pageItems(userId: string, organizationIdInput: string, options: InspirationItemPageOptions): Promise<InspirationItem[]> {
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const limit = validatePageLimit(options.limit)
    const sort = options.sort ?? 'created_desc'
    if (!['created_asc', 'created_desc', 'updated_desc'].includes(sort)) throw new ValidationError('Inspiration sort is invalid')
    return withVerifiedUserContext(this.pool, userId, async (client) => {
      const values: unknown[] = [organizationId]
      const predicates = ['inspiration_items.organization_id=$1', ...(options.includeArchived ? [] : ['inspiration_items.archived_at IS NULL'])]
      if (options.boardId) { values.push(validateIdentifier(options.boardId, 'Inspiration board ID')); predicates.push(`inspiration_items.board_id=$${values.length}`) }
      if (options.search !== undefined) { values.push(normalizeCanonicalText(options.search, 'Search', { maxLength: 200 })); predicates.push(`to_tsvector('simple',inspiration_items.title||' '||inspiration_items.advertiser_name||' '||inspiration_items.body||' '||coalesce(inspiration_items.headline,'')||' '||inspiration_items.notes) @@ plainto_tsquery('simple',$${values.length})`) }
      if (options.tag !== undefined) { values.push(normalizeCanonicalText(options.tag, 'Tag', { maxLength: 60 })); predicates.push(`$${values.length} = ANY(inspiration_items.tags)`) }
      if (options.sourceKind !== undefined) { values.push(sourceKindValue(options.sourceKind)); predicates.push(`inspiration_items.source_kind=$${values.length}`) }
      const column = sort === 'updated_desc' ? 'updated_at' : 'created_at'
      const descending = sort !== 'created_asc'
      if (options.cursor) {
        values.push(options.cursor.createdAt, options.cursor.id)
        predicates.push(`(EXTRACT(EPOCH FROM inspiration_items.${column})${descending ? '<' : '>'}$${values.length - 1}::numeric OR (EXTRACT(EPOCH FROM inspiration_items.${column})=$${values.length - 1}::numeric AND inspiration_items.id${descending ? '<' : '>'}$${values.length}))`)
      }
      values.push(limit + 1)
      const result = await client.query<ItemRow>(`${itemProjection(column)} FROM inspiration_items ${mediaJoin()} WHERE ${predicates.join(' AND ')} ORDER BY inspiration_items.${column} ${descending ? 'DESC' : 'ASC'},inspiration_items.id ${descending ? 'DESC' : 'ASC'} LIMIT $${values.length}`, values)
      return result.rows.map(decodeItem)
    })
  }

  async findItem(userId: string, organizationIdInput: string, idInput: string, includeArchived = false): Promise<InspirationItem | undefined> {
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID'); const id = validateIdentifier(idInput, 'Inspiration item ID')
    return withVerifiedUserContext(this.pool, userId, async (client) => {
      const result = await client.query<ItemRow>(`${itemProjection('created_at')} FROM inspiration_items ${mediaJoin()} WHERE inspiration_items.organization_id=$1 AND inspiration_items.id=$2 ${includeArchived ? '' : 'AND inspiration_items.archived_at IS NULL'}`, [organizationId, id])
      return result.rows[0] && decodeItem(result.rows[0])
    })
  }

  async updateItem(userId: string, organizationIdInput: string, idInput: string, input: InspirationItemUpdate): Promise<InspirationItem> {
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID'); const id = validateIdentifier(idInput, 'Inspiration item ID')
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new ValidationError('Expected version is invalid')
    const boardId = validateIdentifier(input.boardId, 'Inspiration board ID'); const metadata = itemMetadata(input); const instant = timestamp(this.now())
    return withVerifiedUserContext(this.pool, userId, async (client) => {
      const result = await client.query(
        `UPDATE inspiration_items SET board_id=$3,title=$4,notes=$5,tags=$6,version=version+1,updated_at=$8
         WHERE organization_id=$1 AND id=$2 AND version=$7 AND EXISTS (SELECT 1 FROM inspiration_boards b WHERE b.organization_id=$1 AND b.id=$3 AND b.archived_at IS NULL) RETURNING id`,
        [organizationId, id, boardId, metadata.title, metadata.notes, metadata.tags, input.expectedVersion, instant],
      )
      if (result.rowCount !== 1) {
        const found = await client.query('SELECT 1 FROM inspiration_items WHERE organization_id=$1 AND id=$2', [organizationId, id])
        if (found.rowCount === 1) throw new ConflictError('Inspiration item version is stale or destination board is unavailable')
        throw new NotFoundError()
      }
      return requireItem(client, organizationId, id)
    })
  }

  async archiveItem(userId: string, organizationIdInput: string, idInput: string): Promise<InspirationItem> {
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID'); const id = validateIdentifier(idInput, 'Inspiration item ID'); const instant = timestamp(this.now())
    return withVerifiedUserContext(this.pool, userId, async (client) => {
      const result = await client.query('UPDATE inspiration_items SET archived_at=COALESCE(archived_at,$3),updated_at=$3 WHERE organization_id=$1 AND id=$2 RETURNING id', [organizationId, id, instant])
      if (result.rowCount !== 1) throw new NotFoundError()
      return requireItem(client, organizationId, id)
    })
  }

  async removeItem(userId: string, organizationIdInput: string, idInput: string): Promise<void> {
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID'); const id = validateIdentifier(idInput, 'Inspiration item ID')
    await withVerifiedUserContext(this.pool, userId, async (client) => { const result = await client.query('DELETE FROM inspiration_items WHERE organization_id=$1 AND id=$2 RETURNING id', [organizationId, id]); if (result.rowCount !== 1) throw new NotFoundError() })
  }
}

function boardMetadata(input: InspirationBoardInput): InspirationBoardInput { return { name: normalizeCanonicalText(input.name, 'Board name', { maxLength: 200 }), description: normalizeCanonicalText(input.description, 'Board description', { maxLength: 1_000, allowEmpty: true }) } }
function itemMetadata(input: { title: string; notes: string; tags: string[] }) {
  if (!Array.isArray(input.tags) || input.tags.length > 20) throw new ValidationError('Inspiration tags are invalid')
  const tags = [...new Set(input.tags.map((tag) => normalizeCanonicalText(tag, 'Inspiration tag', { maxLength: 60 })))].sort()
  return { title: normalizeCanonicalText(input.title, 'Inspiration title', { maxLength: 300 }), notes: normalizeCanonicalText(input.notes, 'Inspiration notes', { maxLength: 4_000, allowEmpty: true }), tags }
}
function sourceKindValue(value: unknown): InspirationSourceKind { if (value !== 'competitor_ad' && value !== 'winning_ad') throw new ValidationError('Inspiration source kind is invalid'); return value }
function timestamp(value: Date): string { if (!Number.isFinite(value.getTime())) throw new Error('Inspiration clock is invalid'); return value.toISOString() }
function itemProjection(cursorColumn: 'created_at' | 'updated_at'): string { return `SELECT inspiration_items.*,EXTRACT(EPOCH FROM inspiration_items.${cursorColumn})::text cursor_created_at,COALESCE(media.items,'[]'::jsonb) media_items` }
function mediaJoin(): string { return `LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('position',m.position,'kind',m.media_kind,'mediaType',m.media_type,'checksum',m.checksum) ORDER BY m.position) items FROM inspiration_item_media m WHERE m.organization_id=inspiration_items.organization_id AND m.inspiration_item_id=inspiration_items.id) media ON true` }
async function requireItem(client: SqlConnection, organizationId: string, id: string): Promise<InspirationItem> { const result = await client.query<ItemRow>(`${itemProjection('created_at')} FROM inspiration_items ${mediaJoin()} WHERE inspiration_items.organization_id=$1 AND inspiration_items.id=$2`, [organizationId, id]); if (!result.rows[0]) throw new NotFoundError(); return decodeItem(result.rows[0]) }

type BoardRow = Record<string, unknown> & { id: string; organization_id: string; name: string; description: string; version: number; archived_at: Date | string | null; created_at: Date | string; updated_at: Date | string; cursor_created_at?: string }
type ItemRow = Record<string, unknown> & { id: string; organization_id: string; board_id: string; source_kind: string; source_ref_id: string; title: string; notes: string; tags: unknown; source_provider: string; source_platform: string; source_external_id: string; source_url: string; advertiser_name: string; body: string; headline: string | null; version: number; archived_at: Date | string | null; created_at: Date | string; updated_at: Date | string; cursor_created_at?: string; media_items: unknown }
function decodeBoard(row: BoardRow): InspirationBoard {
  try { const value: InspirationBoard = { id: storedIdentifier(row.id, 'inspiration_board.id'), organizationId: storedIdentifier(row.organization_id, 'inspiration_board.organization_id'), name: normalizeCanonicalText(row.name, 'Stored board name', { maxLength: 200 }), description: normalizeCanonicalText(row.description, 'Stored board description', { maxLength: 1_000, allowEmpty: true }), version: positiveVersion(row.version), archivedAt: row.archived_at === null ? null : storedTimestamp(row.archived_at, 'inspiration_board.archived_at'), createdAt: storedTimestamp(row.created_at, 'inspiration_board.created_at'), updatedAt: storedTimestamp(row.updated_at, 'inspiration_board.updated_at') }; return row.cursor_created_at ? attachCursor(value, row.cursor_created_at) : value } catch (error) { if (error instanceof DataIntegrityError) throw error; throw new DataIntegrityError('Stored inspiration board failed data-integrity validation') }
}
function decodeItem(row: ItemRow): InspirationItem {
  try {
    if (!Array.isArray(row.tags) || !row.tags.every((tag) => typeof tag === 'string') || !Array.isArray(row.media_items) || row.media_items.length < 1 || row.media_items.length > 50 || row.source_platform !== 'meta') throw new Error()
    const media = row.media_items.map((raw, index) => { if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(); const item = raw as Record<string, unknown>; if (item.position !== index || !['image','video','unknown'].includes(item.kind as string) || typeof item.mediaType !== 'string' || typeof item.checksum !== 'string' || !/^[a-f0-9]{64}$/u.test(item.checksum)) throw new Error(); return { position: index, kind: item.kind as 'image'|'video'|'unknown', mediaType: item.mediaType, checksum: item.checksum, url: `/media/sha256/${item.checksum}` } })
    const value: InspirationItem = { id: storedIdentifier(row.id, 'inspiration_item.id'), organizationId: storedIdentifier(row.organization_id, 'inspiration_item.organization_id'), boardId: storedIdentifier(row.board_id, 'inspiration_item.board_id'), sourceKind: sourceKindValue(row.source_kind), sourceId: storedIdentifier(row.source_ref_id, 'inspiration_item.source_id'), title: normalizeCanonicalText(row.title, 'Stored inspiration title', { maxLength: 300 }), notes: normalizeCanonicalText(row.notes, 'Stored inspiration notes', { maxLength: 4_000, allowEmpty: true }), tags: itemMetadata({ title: row.title, notes: row.notes, tags: row.tags as string[] }).tags, source: { provider: normalizeCanonicalText(row.source_provider, 'Stored provider', { maxLength: 64 }), platform: 'meta', externalId: storedIdentifier(row.source_external_id, 'inspiration_item.external_id'), url: row.source_url, advertiserName: normalizeCanonicalText(row.advertiser_name, 'Stored advertiser', { maxLength: 500 }) }, copy: { body: normalizeCanonicalText(row.body, 'Stored body', { maxLength: 20_000, allowEmpty: true }), headline: row.headline }, media, version: positiveVersion(row.version), archivedAt: row.archived_at === null ? null : storedTimestamp(row.archived_at, 'inspiration_item.archived_at'), createdAt: storedTimestamp(row.created_at, 'inspiration_item.created_at'), updatedAt: storedTimestamp(row.updated_at, 'inspiration_item.updated_at') }
    return row.cursor_created_at ? attachCursor(value, row.cursor_created_at) : value
  } catch (error) { if (error instanceof DataIntegrityError) throw error; throw new DataIntegrityError('Stored inspiration item failed data-integrity validation') }
}
function positiveVersion(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(); return value as number }
function attachCursor<T extends { id: string }>(value: T, cursor: string): T { if (!/^\d{1,20}(?:\.\d{1,6})?$/u.test(cursor)) throw new Error(); return attachExactCursorTimestamp(value, cursor) }
