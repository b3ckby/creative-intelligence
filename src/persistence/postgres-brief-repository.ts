import {
  buildBriefFromAd,
  buildManualBrief,
  normalizeBriefFromAdInput,
  normalizeManualBriefInput,
  type CreateBriefFromAdInput,
  type CreateManualBriefInput,
} from '../briefs/brief-service.ts'
import { normalizeBriefUpdate, requireBriefStatusTransition, type BriefUpdateInput } from '../briefs/brief-workflow.ts'
import { ConflictError, DataIntegrityError, NotFoundError, ValidationError } from '../domain/errors.ts'
import { validatePageLimit } from '../domain/page-limit.ts'
import { attachExactCursorTimestamp, type CursorPosition } from '../http/pagination.ts'
import { validateIdentifier } from '../domain/identifiers.ts'
import { validateCanonicalText } from '../domain/validation.ts'
import type { BriefDimensions, BriefStatus, CompetitorAd, CreativeBrief, CreativeBriefVersion, Product } from '../domain/types.ts'
import type { SqlConnection, SqlPool } from './postgres-organization-repository.ts'
import { decodeAdRow, decodeProductRow, storedIdentifier, storedTimestamp } from './catalog-row-decoders.ts'
import { requireBriefReadContext } from './postgres-brief-read-context.ts'
import { withVerifiedUserContext, withVerifiedUserReadContext } from './verified-user-context.ts'

const STORED_DIMENSIONS_ERROR = 'Stored brief dimensions failed data-integrity validation'
const DIMENSION_FIELDS = ['audience', 'market', 'angle', 'format'] as const

const BRIEF_STATUSES = new Set<BriefStatus>(['draft', 'triage', 'approved', 'production', 'review', 'completed', 'archived'])

export class PostgresBriefRepository {
  constructor(
    private readonly pool: SqlPool,
    private readonly now: () => Date,
    private readonly createId: () => string,
  ) {}

  async createManual(verifiedUserId: string, input: CreateManualBriefInput): Promise<CreativeBrief> {
    const normalized = normalizeManualBriefInput(input)
    try {
      return await withVerifiedUserContext(this.pool, verifiedUserId, async (client) => {
        const product = await requireProduct(client, normalized.organizationId, normalized.productId)
        const brief = buildManualBrief(normalized, product, this.now(), this.createId())
        return insertBrief(client, brief, verifiedUserId)
      })
    } catch (error) {
      throw mapInsertError(error)
    }
  }

  async createFromAd(verifiedUserId: string, input: CreateBriefFromAdInput): Promise<CreativeBrief> {
    const normalized = normalizeBriefFromAdInput(input)
    try {
      return await withVerifiedUserContext(this.pool, verifiedUserId, async (client) => {
        const { product, ad } = await requireProductAndAd(client, normalized.organizationId, normalized.productId, normalized.adId)
        const brief = buildBriefFromAd(normalized, product, ad, this.now(), this.createId())
        return insertBrief(client, brief, verifiedUserId)
      })
    } catch (error) {
      throw mapInsertError(error)
    }
  }


  async pageForProduct(
    verifiedUserId: string,
    organizationIdInput: string,
    productIdInput: string,
    options: { limit: number; cursor?: CursorPosition; includeArchived: boolean },
  ): Promise<CreativeBrief[]> {
    const limit = validatePageLimit(options.limit)
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const productId = validateIdentifier(productIdInput, 'Product ID')
    return withVerifiedUserReadContext(this.pool, verifiedUserId, async (client) => {
      await requireBriefReadContext(client, verifiedUserId, organizationId, productId, true)
      if (!options.includeArchived) {
        const activeParent = await client.query(
          `SELECT id FROM products WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL`,
          [organizationId, productId],
        )
        if (activeParent.rowCount !== 1) return []
      }
      const values: unknown[] = [organizationId, productId]
      const predicates = ['organization_id = $1', 'product_id = $2']
      if (!options.includeArchived) predicates.push(`status <> 'archived'`)
      if (options.cursor) {
        values.push(options.cursor.createdAt, options.cursor.id)
        predicates.push(`(EXTRACT(EPOCH FROM created_at) > $${values.length - 1}::numeric OR (EXTRACT(EPOCH FROM created_at) = $${values.length - 1}::numeric AND id > $${values.length}))`)
      }
      values.push(limit + 1)
      const result = await client.query<BriefRow>(
        `SELECT id, organization_id, product_id, title, status, source_ad_id,
                hook, call_to_action, dimensions, version, created_at, updated_at, EXTRACT(EPOCH FROM created_at)::text AS cursor_created_at
         FROM creative_briefs WHERE ${predicates.join(' AND ')}
         ORDER BY created_at, id LIMIT $${values.length}`,
        values,
      )
      return result.rows.map(briefFromRow)
    })
  }

  async findById(
    verifiedUserId: string,
    organizationIdInput: string,
    briefIdInput: string,
    includeArchived = false,
  ): Promise<CreativeBrief | undefined> {
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const briefId = validateIdentifier(briefIdInput, 'Brief ID')
    return withVerifiedUserContext(this.pool, verifiedUserId, async (client) => {
      const archivePredicate = includeArchived ? '' : "AND b.status <> 'archived' AND p.archived_at IS NULL"
      const result = await client.query<BriefRow>(
        `SELECT b.id, b.organization_id, b.product_id, b.title, b.status, b.source_ad_id,
                b.hook, b.call_to_action, b.dimensions, b.version, b.created_at, b.updated_at
         FROM creative_briefs b
         JOIN products p ON p.organization_id = b.organization_id AND p.id = b.product_id
         WHERE b.organization_id = $1 AND b.id = $2 ${archivePredicate}`,
        [organizationId, briefId],
      )
      const row = result.rows[0]
      return row && briefFromRow(row)
    })
  }

  async update(
    verifiedUserIdInput: string,
    organizationIdInput: string,
    briefIdInput: string,
    input: BriefUpdateInput,
  ): Promise<CreativeBrief> {
    const verifiedUserId = validateIdentifier(verifiedUserIdInput, 'Verified user ID')
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const briefId = validateIdentifier(briefIdInput, 'Brief ID')
    const normalized = normalizeBriefUpdate(input)
    return withVerifiedUserContext(this.pool, verifiedUserId, async (client) => {
      const currentResult = await client.query<BriefRow>(
        `SELECT id, organization_id, product_id, title, status, source_ad_id, hook, call_to_action,
                dimensions, version, created_at, updated_at
         FROM creative_briefs WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [organizationId, briefId],
      )
      const currentRow = currentResult.rows[0]
      if (!currentRow) throw new NotFoundError()
      const current = briefFromRow(currentRow)
      if (current.version !== normalized.expectedVersion) throw new ConflictError('Brief version is stale')
      requireBriefStatusTransition(current.status, normalized.status)
      const instant = this.now()
      if (!Number.isFinite(instant.getTime())) throw new Error('Brief clock is invalid')
      const updatedAt = instant.toISOString()
      const result = await client.query<BriefRow>(
        `UPDATE creative_briefs SET title = $3, status = $4, hook = $5, call_to_action = $6,
                dimensions = $7::jsonb, version = version + 1, updated_at = $8
         WHERE organization_id = $1 AND id = $2 AND version = $9
         RETURNING id, organization_id, product_id, title, status, source_ad_id, hook, call_to_action,
                   dimensions, version, created_at, updated_at`,
        [organizationId, briefId, normalized.title, normalized.status, normalized.hook, normalized.callToAction,
          JSON.stringify(normalized.dimensions), updatedAt, normalized.expectedVersion],
      )
      const row = result.rows[0]
      if (!row) throw new ConflictError('Brief version is stale')
      const updated = briefFromRow(row)
      await insertBriefVersion(client, updated, verifiedUserId, updatedAt)
      return updated
    })
  }

  async listVersions(
    verifiedUserIdInput: string,
    organizationIdInput: string,
    briefIdInput: string,
    limitInput: number,
  ): Promise<CreativeBriefVersion[]> {
    const verifiedUserId = validateIdentifier(verifiedUserIdInput, 'Verified user ID')
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const briefId = validateIdentifier(briefIdInput, 'Brief ID')
    const limit = validatePageLimit(limitInput)
    return withVerifiedUserContext(this.pool, verifiedUserId, async (client) => {
      const present = await client.query(`SELECT id FROM creative_briefs WHERE organization_id = $1 AND id = $2`, [organizationId, briefId])
      if (present.rowCount !== 1) throw new NotFoundError()
      const result = await client.query<BriefVersionRow>(
        `SELECT organization_id, brief_id, product_id, version, title, status, source_ad_id,
                hook, call_to_action, dimensions, brief_created_at, changed_by, changed_at
         FROM creative_brief_versions
         WHERE organization_id = $1 AND brief_id = $2
         ORDER BY version DESC LIMIT $3`,
        [organizationId, briefId, limit],
      )
      return result.rows.map(briefVersionFromRow)
    })
  }
}

async function requireProduct(client: SqlConnection, organizationId: string, productId: string): Promise<Product> {
  const result = await client.query<ProductRow>(
    `SELECT id, organization_id, name, markets, platforms, target_audiences,
            unique_selling_points, archived_at, created_at
     FROM products WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL
     FOR SHARE`,
    [organizationId, productId],
  )
  const row = result.rows[0]
  if (!row) throw new ValidationError('Product does not belong to organization')
  return decodeProductRow(row)
}

async function requireProductAndAd(
  client: SqlConnection,
  organizationId: string,
  productId: string,
  adId: string,
): Promise<{ product: Product; ad: CompetitorAd }> {
  const product = await requireProduct(client, organizationId, productId)
  const ads = await client.query<AdRow>(
    `SELECT a.id, a.organization_id, a.product_id, a.competitor_id, a.provider_name, a.platform,
            a.external_id, a.advertiser_name, a.body, a.call_to_action, a.started_at, a.is_active,
            a.media_urls, a.source_url, a.first_seen_at, a.last_seen_at
     FROM competitor_ads a
     JOIN competitors c ON c.organization_id = a.organization_id
       AND c.product_id = a.product_id AND c.id = a.competitor_id
     WHERE a.organization_id = $1 AND a.product_id = $2 AND a.id = $3
       AND c.archived_at IS NULL
     FOR SHARE`,
    [organizationId, productId, adId],
  )
  const row = ads.rows[0]
  if (!row) throw new ValidationError('Ad does not belong to product')
  return { product, ad: decodeAdRow(row) }
}

async function insertBrief(client: SqlConnection, brief: CreativeBrief, changedBy: string): Promise<CreativeBrief> {
  const result = await client.query<BriefRow>(
    `INSERT INTO creative_briefs (
       id, organization_id, product_id, title, status, source_ad_id,
       hook, call_to_action, dimensions, version, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
     RETURNING id, organization_id, product_id, title, status, source_ad_id,
               hook, call_to_action, dimensions, version, created_at, updated_at`,
    [
      brief.id, brief.organizationId, brief.productId, brief.title, brief.status,
      brief.sourceAdId, brief.hook, brief.callToAction, JSON.stringify(brief.dimensions), brief.version,
      brief.createdAt, brief.updatedAt,
    ],
  )
  const row = result.rows[0]
  if (!row) throw new ConflictError('Brief insert did not return a row')
  const stored = briefFromRow(row)
  await insertBriefVersion(client, stored, changedBy, stored.createdAt)
  return stored
}

async function insertBriefVersion(client: SqlConnection, brief: CreativeBrief, changedBy: string, changedAt: string): Promise<void> {
  await client.query(
    `INSERT INTO creative_brief_versions (
       organization_id, brief_id, version, product_id, title, status, source_ad_id,
       hook, call_to_action, dimensions, brief_created_at, changed_by, changed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)`,
    [brief.organizationId, brief.id, brief.version, brief.productId, brief.title, brief.status,
      brief.sourceAdId, brief.hook, brief.callToAction, JSON.stringify(brief.dimensions), brief.createdAt, changedBy, changedAt],
  )
}

function mapInsertError(error: unknown): unknown {
  if (isPostgresError(error, '23505')) return new ConflictError('Generated brief ID collision')
  if (isPostgresError(error, '23503')) return new ValidationError('Brief references are invalid')
  if (isPostgresError(error, '23514')) return new ValidationError('Brief data violates a constraint')
  return error
}

function isPostgresError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
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

export type BriefRow = Record<string, unknown> & {
  id: string
  organization_id: string
  product_id: string
  title: string
  status: BriefStatus
  source_ad_id: string | null
  hook: string
  call_to_action: string | null
  dimensions: unknown
  version: number
  created_at: Date | string
  updated_at: Date | string
  cursor_created_at?: string
}

function iso(value: Date | string): string {
  return storedTimestamp(value, 'brief.created_at')
}

export function briefFromRow(row: BriefRow): CreativeBrief {
  if (typeof row.status !== 'string' || !BRIEF_STATUSES.has(row.status as BriefStatus)) throw storedBriefError('status')
  const brief: CreativeBrief = {
    id: storedIdentifier(row.id, 'brief.id'),
    organizationId: storedIdentifier(row.organization_id, 'brief.organization_id'),
    productId: storedIdentifier(row.product_id, 'brief.product_id'),
    title: storedBriefText(row.title, 'title', 500, false),
    status: row.status as BriefStatus,
    sourceAdId: row.source_ad_id === null ? null : storedIdentifier(row.source_ad_id, 'brief.source_ad_id'),
    hook: storedBriefText(row.hook, 'hook', 20_000, true),
    callToAction: row.call_to_action === null ? null : storedBriefText(row.call_to_action, 'call_to_action', 100, false),
    dimensions: decodeStoredBriefDimensions(row.dimensions),
    version: storedBriefVersion(row.version),
    createdAt: iso(row.created_at),
    updatedAt: storedTimestamp(row.updated_at, 'brief.updated_at'),
  }
  if (row.cursor_created_at === undefined) return brief
  if (typeof row.cursor_created_at !== 'string' || !/^\d{1,20}(?:\.\d{1,6})?$/.test(row.cursor_created_at)) throw storedBriefError('cursor_created_at')
  return attachExactCursorTimestamp(brief, row.cursor_created_at)
}

function storedBriefVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw storedBriefError('version')
  return value
}

type BriefVersionRow = Record<string, unknown> & {
  organization_id: string
  brief_id: string
  product_id: string
  version: number
  title: string
  status: BriefStatus
  source_ad_id: string | null
  hook: string
  call_to_action: string | null
  dimensions: unknown
  brief_created_at: Date | string
  changed_by: string
  changed_at: Date | string
}

function briefVersionFromRow(row: BriefVersionRow): CreativeBriefVersion {
  const changedAt = storedTimestamp(row.changed_at, 'brief_version.changed_at')
  return {
    ...briefFromRow({
      id: row.brief_id,
      organization_id: row.organization_id,
      product_id: row.product_id,
      title: row.title,
      status: row.status,
      source_ad_id: row.source_ad_id,
      hook: row.hook,
      call_to_action: row.call_to_action,
      dimensions: row.dimensions,
      version: row.version,
      created_at: row.brief_created_at,
      updated_at: changedAt,
    }),
    changedBy: storedIdentifier(row.changed_by, 'brief_version.changed_by'),
    changedAt,
  }
}

function storedBriefText(value: unknown, field: string, max: number, allowEmpty: boolean): string {
  try {
    return validateCanonicalText(value, field, { maxLength: max, allowEmpty })
  } catch (error) {
    if (error instanceof ValidationError) throw storedBriefError(field)
    throw error
  }
}

function storedBriefError(field: string): DataIntegrityError {
  return new DataIntegrityError(`Stored brief.${field} failed data-integrity validation`)
}

export function decodeStoredBriefDimensions(value: unknown): BriefDimensions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw storedDimensionsError()
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== DIMENSION_FIELDS.length || keys.some((key) => !DIMENSION_FIELDS.includes(key as typeof DIMENSION_FIELDS[number]))) {
    throw storedDimensionsError()
  }
  for (const field of DIMENSION_FIELDS) {
    const item = record[field]
    try {
      validateCanonicalText(item, `brief.dimensions.${field}`, { maxLength: 100 })
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error
      throw storedDimensionsError()
    }
  }
  return {
    audience: record.audience as string,
    market: record.market as string,
    angle: record.angle as string,
    format: record.format as string,
  }
}

function storedDimensionsError(): Error {
  return new DataIntegrityError(STORED_DIMENSIONS_ERROR)
}
