import type { Competitor, CompetitorAd, Product } from '../domain/types.ts'
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.ts'
import { validatePageLimit } from '../domain/page-limit.ts'
import type { CursorPosition } from '../http/pagination.ts'
import { decodeAdRow, decodeCompetitorRow, decodeProductRow } from './catalog-row-decoders.ts'
import type { SqlPool } from './postgres-organization-repository.ts'
import { withVerifiedUserContext } from './verified-user-context.ts'

export class PostgresCatalogRepository {
  constructor(private readonly pool: SqlPool, private readonly includeMediaMirrors = false, private readonly includeAdDiscoveryState = false) {}

  async createProduct(verifiedUserId: string, product: Product): Promise<void> {
    await withVerifiedUserContext(this.pool, verifiedUserId, async (client) => client.query(
      `INSERT INTO products (
        id, organization_id, name, markets, platforms, target_audiences,
        unique_selling_points, archived_at, created_at
      ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)`,
      [
        product.id, product.organizationId, product.name,
        JSON.stringify(product.markets), JSON.stringify(product.platforms),
        JSON.stringify(product.targetAudiences), JSON.stringify(product.uniqueSellingPoints),
        product.archivedAt, product.createdAt,
      ],
    ))
  }


  async pageProducts(
    verifiedUserId: string,
    organizationId: string,
    options: { limit: number; cursor?: CursorPosition; includeArchived: boolean },
  ): Promise<Product[]> {
    const limit = validatePageLimit(options.limit)
    return withVerifiedUserContext(this.pool, verifiedUserId, async (client) => {
      const values: unknown[] = [organizationId]
      const predicates = ['organization_id = $1']
      if (!options.includeArchived) predicates.push('archived_at IS NULL')
      if (options.cursor) {
        values.push(options.cursor.createdAt, options.cursor.id)
        predicates.push(`(EXTRACT(EPOCH FROM created_at) > $${values.length - 1}::numeric OR (EXTRACT(EPOCH FROM created_at) = $${values.length - 1}::numeric AND id > $${values.length}))`)
      }
      values.push(limit + 1)
      const result = await client.query<ProductRow>(
        `SELECT *, EXTRACT(EPOCH FROM created_at)::text AS cursor_created_at FROM products WHERE ${predicates.join(' AND ')} ORDER BY created_at, id LIMIT $${values.length}`,
        values,
      )
      return result.rows.map(decodeProductRow)
    })
  }

  async findProduct(verifiedUserId: string, organizationId: string, productId: string): Promise<Product | undefined> {
    return withVerifiedUserContext(this.pool, verifiedUserId, async (client) => {
      const result = await client.query<ProductRow>(
      `SELECT * FROM products WHERE organization_id = $1 AND id = $2`,
      [organizationId, productId],
    )
      const row = result.rows[0]
      return row && decodeProductRow(row)
    })
  }

  async updateProduct(
    verifiedUserId: string,
    organizationId: string,
    productId: string,
    patch: Partial<Pick<Product, 'name' | 'markets' | 'platforms' | 'targetAudiences' | 'uniqueSellingPoints'>>,
  ): Promise<Product | undefined> {
    return withVerifiedUserContext(this.pool, verifiedUserId, async (client) => {
      const values: unknown[] = [organizationId, productId]
      const assignments: string[] = []
      const add = (column: string, value: unknown, cast = '') => {
        values.push(value)
        assignments.push(`${column} = $${values.length}${cast}`)
      }
      if (patch.name !== undefined) add('name', patch.name)
      if (patch.markets !== undefined) add('markets', JSON.stringify(patch.markets), '::jsonb')
      if (patch.platforms !== undefined) add('platforms', JSON.stringify(patch.platforms), '::jsonb')
      if (patch.targetAudiences !== undefined) add('target_audiences', JSON.stringify(patch.targetAudiences), '::jsonb')
      if (patch.uniqueSellingPoints !== undefined) add('unique_selling_points', JSON.stringify(patch.uniqueSellingPoints), '::jsonb')
      const result = await client.query<ProductRow>(
        `UPDATE products SET ${assignments.join(', ')} WHERE organization_id = $1 AND id = $2 RETURNING *`,
        values,
      )
      const row = result.rows[0]
      return row && decodeProductRow(row)
    })
  }

  async setProductArchived(
    verifiedUserId: string,
    organizationId: string,
    productId: string,
    archivedAt: string | null,
  ): Promise<Product | undefined> {
    return withVerifiedUserContext(this.pool, verifiedUserId, async (client) => {
      const result = await client.query<ProductRow>(
        archivedAt === null
          ? `UPDATE products SET archived_at = NULL WHERE organization_id = $1 AND id = $2 RETURNING *`
          : `UPDATE products SET archived_at = COALESCE(archived_at, $3) WHERE organization_id = $1 AND id = $2 RETURNING *`,
        archivedAt === null ? [organizationId, productId] : [organizationId, productId, archivedAt],
      )
      const row = result.rows[0]
      return row && decodeProductRow(row)
    })
  }

  async createCompetitor(verifiedUserId: string, competitor: Competitor): Promise<void> {
    try {
      await withVerifiedUserContext(this.pool, verifiedUserId, async (client) => {
        const parent = await client.query(
          `SELECT id FROM products
           WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL
           FOR SHARE`,
          [competitor.organizationId, competitor.productId],
        )
        if (parent.rowCount !== 1) throw new ValidationError('Product is missing or archived')
        await client.query(
          `INSERT INTO competitors (
            id, organization_id, product_id, name, meta_page_url, archived_at, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            competitor.id, competitor.organizationId, competitor.productId, competitor.name,
            competitor.metaPageUrl, competitor.archivedAt, competitor.createdAt,
          ],
        )
      })
    } catch (error) {
      if (isPostgresError(error, '23505')) throw new ConflictError('Competitor already exists')
      if (isPostgresError(error, '23503')) throw new ValidationError('Product is missing or archived')
      throw error
    }
  }


  async pageCompetitors(
    verifiedUserId: string,
    organizationId: string,
    productId: string,
    options: { limit: number; cursor?: CursorPosition; includeArchived: boolean },
  ): Promise<Competitor[]> {
    const limit = validatePageLimit(options.limit)
    return withVerifiedUserContext(this.pool, verifiedUserId, async (client) => {
      const values: unknown[] = [organizationId, productId]
      const predicates = ['competitors.organization_id = $1', 'competitors.product_id = $2']
      if (!options.includeArchived) predicates.push('competitors.archived_at IS NULL', 'p.archived_at IS NULL')
      if (options.cursor) {
        values.push(options.cursor.createdAt, options.cursor.id)
        predicates.push(`(EXTRACT(EPOCH FROM competitors.created_at) > $${values.length - 1}::numeric OR (EXTRACT(EPOCH FROM competitors.created_at) = $${values.length - 1}::numeric AND competitors.id > $${values.length}))`)
      }
      values.push(limit + 1)
      const result = await client.query<CompetitorRow>(
        `SELECT competitors.*, EXTRACT(EPOCH FROM competitors.created_at)::text AS cursor_created_at
         FROM competitors
         JOIN products p ON p.organization_id = competitors.organization_id AND p.id = competitors.product_id
         WHERE ${predicates.join(' AND ')}
         ORDER BY competitors.created_at, competitors.id LIMIT $${values.length}`,
        values,
      )
      return result.rows.map(decodeCompetitorRow)
    })
  }

  async findCompetitor(verifiedUserId: string, organizationId: string, productId: string, competitorId: string): Promise<Competitor | undefined> {
    return withVerifiedUserContext(this.pool, verifiedUserId, async (client) => {
      const result = await client.query<CompetitorRow>(
        `SELECT * FROM competitors WHERE organization_id = $1 AND product_id = $2 AND id = $3`,
        [organizationId, productId, competitorId],
      )
      const row = result.rows[0]
      return row && decodeCompetitorRow(row)
    })
  }


  async pageAds(
    verifiedUserId: string,
    organizationId: string,
    options: { limit: number; cursor?: CursorPosition; includeArchived?: boolean; productId?: string; competitorId?: string; isActive?: boolean; provider?: string; search?: string; hookCategory?: string; angle?: string; creativeFormat?: string; bookmarked?: boolean; sort?: AdDiscoverySort },
  ): Promise<CompetitorAd[]> {
    const limit = validatePageLimit(options.limit)
    return withVerifiedUserContext(this.pool, verifiedUserId, async (client) => {
      const values: unknown[] = [organizationId]
      const predicates = ['competitor_ads.organization_id = $1']
      if (!options.includeArchived) predicates.push('p.archived_at IS NULL', 'c.archived_at IS NULL')
      const add = (column: string, value: unknown) => {
        values.push(value)
        predicates.push(`competitor_ads.${column} = $${values.length}`)
      }
      if (options.productId !== undefined) add('product_id', options.productId)
      if (options.competitorId !== undefined) add('competitor_id', options.competitorId)
      if (options.isActive !== undefined) add('is_active', options.isActive)
      if (options.provider !== undefined) add('provider_name', options.provider)
      if (options.search !== undefined) {
        values.push(options.search)
        predicates.push(`to_tsvector('simple', coalesce(competitor_ads.advertiser_name, '') || ' ' || coalesce(competitor_ads.headline, '') || ' ' || coalesce(competitor_ads.description, '') || ' ' || coalesce(competitor_ads.body, '') || ' ' || coalesce(competitor_ads.call_to_action, '')) @@ plainto_tsquery('simple', $${values.length})`)
      }
      const tagFilters: Array<[string, string | undefined]> = [
        ['hookCategory', options.hookCategory], ['angle', options.angle], ['format', options.creativeFormat],
      ]
      for (const [tag, value] of tagFilters) {
        if (value === undefined) continue
        values.push(value)
        predicates.push(`latest_analysis.tags->>'${tag}' = $${values.length}`)
      }
      if (options.bookmarked === true) predicates.push('bookmarks.competitor_ad_id IS NOT NULL')
      if (options.bookmarked === false) predicates.push('bookmarks.competitor_ad_id IS NULL')
      const includeBookmarks = this.includeAdDiscoveryState || options.bookmarked !== undefined
      const includeLatestAnalysis = options.hookCategory !== undefined || options.angle !== undefined || options.creativeFormat !== undefined
      const sort = discoverySort(options.sort)
      if (options.cursor) {
        values.push(options.cursor.createdAt, options.cursor.id)
        const comparison = sort.direction === 'DESC' ? '<' : '>'
        predicates.push(`(${sort.cursorExpression} ${comparison} $${values.length - 1}::numeric OR (${sort.cursorExpression} = $${values.length - 1}::numeric AND competitor_ads.id ${comparison} $${values.length}))`)
      }
      values.push(limit + 1)
      const mediaProjection = this.includeMediaMirrors ? "COALESCE(media_positions.media_mirrors,'[]'::jsonb)" : "'[]'::jsonb"
      const mediaJoin = this.includeMediaMirrors ? `LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object(
             'slotKind',position.slot_kind,'position',position.position,'checksum',position.active_checksum
           ) ORDER BY position.slot_kind,position.position) AS media_mirrors
           FROM competitor_ad_media_positions position
           WHERE position.organization_id=competitor_ads.organization_id AND position.ad_id=competitor_ads.id
             AND position.active_checksum IS NOT NULL
         ) media_positions ON true` : ''
      const bookmarkProjection = includeBookmarks ? ', (bookmarks.competitor_ad_id IS NOT NULL) AS bookmarked' : ''
      const bookmarkJoin = includeBookmarks ? `LEFT JOIN competitor_ad_bookmarks bookmarks
           ON bookmarks.organization_id = competitor_ads.organization_id AND bookmarks.competitor_ad_id = competitor_ads.id
          AND bookmarks.user_id = app_verified_user_id()` : ''
      const analysisJoin = includeLatestAnalysis ? `LEFT JOIN LATERAL (
           SELECT ca.tags || COALESCE(latest_review.corrections,'{}'::jsonb) AS tags
           FROM (SELECT candidate.* FROM creative_ad_analyses candidate
             WHERE candidate.organization_id = competitor_ads.organization_id AND candidate.product_id = competitor_ads.product_id
               AND candidate.competitor_ad_id = competitor_ads.id AND candidate.status = 'completed'
             ORDER BY candidate.analyzed_at DESC, candidate.updated_at DESC, candidate.analysis_version DESC, candidate.input_fingerprint DESC
             LIMIT 1) ca
           LEFT JOIN LATERAL (SELECT cr.decision,cr.corrections FROM creative_analysis_reviews cr
             WHERE cr.organization_id=ca.organization_id AND cr.competitor_ad_id=ca.competitor_ad_id
               AND cr.analysis_version=ca.analysis_version AND cr.input_fingerprint=ca.input_fingerprint
             ORDER BY cr.review_version DESC LIMIT 1) latest_review ON true
           WHERE latest_review.decision IS NULL OR latest_review.decision <> 'rejected'
         ) latest_analysis ON true` : ''
      const result = await client.query<AdRow>(
        `SELECT competitor_ads.*, (${sort.cursorExpression})::text AS cursor_created_at,
                ${mediaProjection} AS media_mirrors${bookmarkProjection}
         FROM competitor_ads
         JOIN products p ON p.organization_id = competitor_ads.organization_id AND p.id = competitor_ads.product_id
         JOIN competitors c ON c.organization_id = competitor_ads.organization_id
           AND c.product_id = competitor_ads.product_id AND c.id = competitor_ads.competitor_id
         ${mediaJoin}
         ${bookmarkJoin}
         ${analysisJoin}
         WHERE ${predicates.join(' AND ')}
         ORDER BY ${sort.orderExpression} ${sort.direction}, competitor_ads.id ${sort.direction} LIMIT $${values.length}`,
        values,
      )
      return result.rows.map(decodeAdRow)
    })
  }

  async setAdBookmark(verifiedUserId: string, organizationId: string, adId: string, bookmarked: boolean): Promise<void> {
    await withVerifiedUserContext(this.pool, verifiedUserId, async (client) => {
      if (bookmarked) {
        const result = await client.query(
          `INSERT INTO competitor_ad_bookmarks (organization_id, user_id, competitor_ad_id)
           SELECT $1, app_verified_user_id(), a.id FROM competitor_ads a
           WHERE a.organization_id = $1 AND a.id = $2
           ON CONFLICT DO NOTHING RETURNING competitor_ad_id`,
          [organizationId, adId],
        )
        if (result.rowCount !== 1) {
          const exists = await client.query(
            `SELECT 1 FROM competitor_ad_bookmarks WHERE organization_id = $1 AND user_id = app_verified_user_id() AND competitor_ad_id = $2`,
            [organizationId, adId],
          )
          if (exists.rowCount !== 1) throw new NotFoundError()
        }
      } else {
        await client.query(
          `DELETE FROM competitor_ad_bookmarks WHERE organization_id = $1 AND user_id = app_verified_user_id() AND competitor_ad_id = $2`,
          [organizationId, adId],
        )
      }
    })
  }
}

export type AdDiscoverySort = 'first_seen_asc' | 'first_seen_desc' | 'last_seen_asc' | 'last_seen_desc' | 'lifespan_desc' | 'impressions_desc'

function discoverySort(value: AdDiscoverySort | undefined): { cursorExpression: string; orderExpression: string; direction: 'ASC' | 'DESC' } {
  switch (value ?? 'first_seen_asc') {
    case 'first_seen_asc': return { cursorExpression: 'EXTRACT(EPOCH FROM competitor_ads.first_seen_at)', orderExpression: 'competitor_ads.first_seen_at', direction: 'ASC' }
    case 'first_seen_desc': return { cursorExpression: 'EXTRACT(EPOCH FROM competitor_ads.first_seen_at)', orderExpression: 'competitor_ads.first_seen_at', direction: 'DESC' }
    case 'last_seen_asc': return { cursorExpression: 'EXTRACT(EPOCH FROM competitor_ads.last_seen_at)', orderExpression: 'competitor_ads.last_seen_at', direction: 'ASC' }
    case 'last_seen_desc': return { cursorExpression: 'EXTRACT(EPOCH FROM competitor_ads.last_seen_at)', orderExpression: 'competitor_ads.last_seen_at', direction: 'DESC' }
    case 'lifespan_desc': return { cursorExpression: 'GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(competitor_ads.ended_at, competitor_ads.last_seen_at) - competitor_ads.started_at)))', orderExpression: 'GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(competitor_ads.ended_at, competitor_ads.last_seen_at) - competitor_ads.started_at)))', direction: 'DESC' }
    case 'impressions_desc': return { cursorExpression: 'COALESCE(competitor_ads.impressions_upper_bound, 0)', orderExpression: 'COALESCE(competitor_ads.impressions_upper_bound, 0)', direction: 'DESC' }
  }
}

type ProductRow = Record<string, unknown> & {
  id: string
  organization_id: string
  name: string
  markets: string[]
  platforms: Product['platforms']
  target_audiences: string[]
  unique_selling_points: string[]
  archived_at: Date | string | null
  created_at: Date | string
}

type CompetitorRow = Record<string, unknown> & {
  id: string
  organization_id: string
  product_id: string
  name: string
  meta_page_url: string | null
  archived_at: Date | string | null
  created_at: Date | string
}

type AdRow = Record<string, unknown> & {
  id: string
  organization_id: string
  product_id: string
  competitor_id: string
  provider_name: string
  platform: CompetitorAd['platform']
  external_id: string
  advertiser_name: string
  body: string
  call_to_action: string | null
  started_at: Date | string
  is_active: boolean
  media_urls: string[]
  source_url: string
  first_seen_at: Date | string
  last_seen_at: Date | string
}

function isPostgresError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
