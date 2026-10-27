import { randomUUID } from 'node:crypto'

import type { AdCollectionContext, AdSourceProvider, CollectedAd } from '../ad-ingestion/ad-source-provider.ts'
import { validateCollectedAd } from '../ads/ad-library-service.ts'
import { ConflictError, ExternalProviderError, ValidationError } from '../domain/errors.ts'
import { validateIdentifier } from '../domain/identifiers.ts'
import type { SqlConnection, SqlPool } from './postgres-organization-repository.ts'
import { withVerifiedUserContext } from './verified-user-context.ts'

export class PostgresProviderAdImportService {
  constructor(
    private readonly pool: SqlPool,
    private readonly createId: () => string,
    private readonly now: () => Date,
  ) {}

  async import(
    verifiedUserId: string,
    providerNameInput: string,
    contextInput: AdCollectionContext,
    provider: AdSourceProvider,
  ): Promise<{ inserted: number; duplicates: number }> {
    const providerName = validateProviderName(providerNameInput)
    const context = Object.freeze({
      organizationId: validateIdentifier(contextInput.organizationId, 'Organization ID'),
      productId: validateIdentifier(contextInput.productId, 'Product ID'),
      competitorId: validateIdentifier(contextInput.competitorId, 'Competitor ID'),
    })
    let collected: unknown
    try {
      collected = await provider.collect(context)
    } catch (error) {
      if (error instanceof ValidationError || error instanceof ConflictError) throw error
      throw new ExternalProviderError()
    }
    let items: CollectedAd[]
    try {
      if (!Array.isArray(collected) || collected.length > 1_000) throw new Error('invalid batch')
      items = collected.map((item) => validateCollectedAd(item))
      ensureUniqueBatch(items)
    } catch {
      throw new ValidationError('Provider returned invalid data')
    }

    return withVerifiedUserContext(this.pool, verifiedUserId, async (client) => {
      await requireContext(client, context)
      let inserted = 0
      let duplicates = 0
      const seenAt = this.now().toISOString()

      for (const item of items) {
        const proposedId = validateIdentifier(this.createId(), 'Generated ID')
        const ingestionToken = randomUUID()
        const saved = await upsertAd(client, proposedId, ingestionToken, providerName, context, item, seenAt)
        if (!saved || saved.product_id !== context.productId || saved.competitor_id !== context.competitorId) {
          throw new ConflictError('Provider ad ID already belongs to another product or competitor')
        }
        if (saved.ingestion_token === ingestionToken) inserted += 1
        else duplicates += 1
      }

      return { inserted, duplicates }
    })
  }
}

function validateProviderName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value)) throw new ValidationError('Provider name is invalid')
  return value
}

function ensureUniqueBatch(items: readonly CollectedAd[]): void {
  const seen = new Set<string>()
  for (const item of items) {
    const key = JSON.stringify([item.platform, item.externalId])
    if (seen.has(key)) throw new Error('duplicate provider ID')
    seen.add(key)
  }
}

async function requireContext(client: SqlConnection, context: Readonly<AdCollectionContext>): Promise<void> {
  const product = await client.query(
    `SELECT id FROM products
     WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL
     FOR SHARE`,
    [context.organizationId, context.productId],
  )
  if (product.rowCount !== 1) throw new ValidationError('Competitor does not belong to product')
  const result = await client.query(
    `SELECT id FROM competitors
     WHERE organization_id = $1 AND product_id = $2 AND id = $3 AND archived_at IS NULL
     FOR SHARE`,
    [context.organizationId, context.productId, context.competitorId],
  )
  if (result.rowCount !== 1) throw new ValidationError('Competitor does not belong to product')
}

async function upsertAd(
  client: SqlConnection,
  id: string,
  ingestionToken: string,
  providerName: string,
  context: Readonly<AdCollectionContext>,
  item: CollectedAd,
  seenAt: string,
): Promise<{ id: string; ingestion_token: string; product_id: string; competitor_id: string } | undefined> {
  const result = await client.query<{ id: string; ingestion_token: string; product_id: string; competitor_id: string }>(
    `INSERT INTO competitor_ads (
      id, ingestion_token, organization_id, product_id, competitor_id, provider_name, platform,
      external_id, advertiser_name, body, call_to_action, started_at, is_active,
      media_urls, source_url, first_seen_at, last_seen_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $16)
    ON CONFLICT (organization_id, provider_name, platform, external_id)
    DO UPDATE SET
      advertiser_name = EXCLUDED.advertiser_name,
      body = EXCLUDED.body,
      call_to_action = EXCLUDED.call_to_action,
      started_at = EXCLUDED.started_at,
      is_active = EXCLUDED.is_active,
      media_urls = EXCLUDED.media_urls,
      source_url = EXCLUDED.source_url,
      last_seen_at = EXCLUDED.last_seen_at
    WHERE competitor_ads.product_id = EXCLUDED.product_id
      AND competitor_ads.competitor_id = EXCLUDED.competitor_id
    RETURNING competitor_ads.id, competitor_ads.ingestion_token, competitor_ads.product_id, competitor_ads.competitor_id`,
    [
      id, ingestionToken, context.organizationId, context.productId, context.competitorId, providerName,
      item.platform, item.externalId, item.advertiserName, item.body, item.callToAction,
      item.startedAt, item.isActive, JSON.stringify(item.mediaUrls), item.sourceUrl, seenAt,
    ],
  )
  return result.rows[0]
}
