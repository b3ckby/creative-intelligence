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
    const { inserted, duplicates } = await this.importWithDetails(verifiedUserId, providerNameInput, contextInput, provider)
    return { inserted, duplicates }
  }

  async importWithDetails(
    verifiedUserId: string,
    providerNameInput: string,
    contextInput: AdCollectionContext,
    provider: AdSourceProvider,
    fence?: { runId: string; owner: string; token: string },
  ): Promise<{ inserted: number; duplicates: number; retired: number; complete: boolean }> {
    const providerName = validateProviderName(providerNameInput)
    const context = Object.freeze({
      organizationId: validateIdentifier(contextInput.organizationId, 'Organization ID'),
      productId: validateIdentifier(contextInput.productId, 'Product ID'),
      competitorId: validateIdentifier(contextInput.competitorId, 'Competitor ID'),
    })
    let collected: unknown
    let complete = false
    let scopeKey: string | null = null
    try {
      if (provider.collectSnapshot) {
        const snapshot = await provider.collectSnapshot(context)
        collected = snapshot.items
        if (snapshot.scopeKey !== undefined && (typeof snapshot.scopeKey !== 'string' || snapshot.scopeKey.length < 1 || snapshot.scopeKey.length > 256 || /[\p{Cc}\p{Cf}]/u.test(snapshot.scopeKey))) {
          throw new ValidationError('Provider returned invalid data')
        }
        complete = snapshot.completeness === 'complete' && providerName === 'apify-meta-ads' && snapshot.scopeKey !== undefined
        scopeKey = complete ? snapshot.scopeKey! : null
      } else {
        collected = await provider.collect(context)
      }
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
      await lockProductImport(client, context, fence)
      let inserted = 0
      let duplicates = 0
      const seenAt = this.now().toISOString()

      for (const item of items) {
        const proposedId = validateIdentifier(this.createId(), 'Generated ID')
        const ingestionToken = randomUUID()
        const saved = fence
          ? await upsertScheduledAd(client, fence, proposedId, ingestionToken, item, scopeKey)
          : await upsertAd(client, proposedId, ingestionToken, providerName, context, item, seenAt, scopeKey)
        if (!saved || saved.product_id !== context.productId || saved.competitor_id !== context.competitorId) {
          throw new ConflictError('Provider ad ID already belongs to another product or competitor')
        }
        if (saved.ingestion_token === ingestionToken) inserted += 1
        else duplicates += 1
      }

      let retired = 0
      if (complete && fence) {
        const result = await client.query<{ retired: number }>(
          'SELECT app_retire_scheduled_competitor_ads($1,$2,$3,$4,$5) AS retired',
          [fence.runId, fence.owner, fence.token, scopeKey, items.map(({ platform, externalId }) => `${platform}:${externalId}`)],
        )
        retired = result.rows[0]?.retired ?? 0
      } else if (complete) {
        const result = await client.query(
          `UPDATE competitor_ads
             SET is_active = false,
                 ended_at = CASE WHEN started_at > $5::timestamptz THEN started_at ELSE $5::timestamptz END
           WHERE organization_id = $1 AND product_id = $2 AND competitor_id = $3
             AND provider_name = $4 AND is_active = true
             AND snapshot_scope_key = $6
             AND NOT ((platform || ':' || external_id) = ANY($7::text[]))`,
          [context.organizationId, context.productId, context.competitorId, providerName, seenAt, scopeKey,
            items.map(({ platform, externalId }) => `${platform}:${externalId}`)],
        )
        retired = result.rowCount ?? 0
      }

      await captureAnalyticsSnapshot(client, context, fence)

      if (fence) {
        const finished = await client.query<{ app_finish_ad_sync_run_success: boolean }>(
          'SELECT app_finish_ad_sync_run_success($1,$2,$3,$4,$5,$6)',
          [fence.runId, fence.owner, fence.token, inserted, duplicates, retired],
        )
        if (finished.rows[0]?.app_finish_ad_sync_run_success !== true) throw new ConflictError('Scheduled sync lease was lost')
      }
      return { inserted, duplicates, retired, complete }
    })
  }
}

async function lockProductImport(
  client: SqlConnection,
  context: Readonly<AdCollectionContext>,
  fence?: { runId: string; owner: string; token: string },
): Promise<void> {
  if (fence) {
    try {
      await client.query('SELECT app_lock_scheduled_ingestion_product($1,$2,$3)', [fence.runId, fence.owner, fence.token])
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '40001') {
        throw new ConflictError('Scheduled sync lease was lost')
      }
      throw error
    }
    return
  }
  await requireContext(client, context)
  await client.query(
    'SELECT app_lock_ingestion_product($1,$2,$3)',
    [context.organizationId, context.productId, context.competitorId],
  )
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

async function captureAnalyticsSnapshot(
  client: SqlConnection,
  context: Readonly<AdCollectionContext>,
  fence?: { runId: string; owner: string; token: string },
): Promise<void> {
  try {
    if (fence) {
      await client.query(
        'SELECT app_capture_scheduled_ingestion_analytics_snapshot($1,$2,$3)',
        [fence.runId, fence.owner, fence.token],
      )
    } else {
      await client.query(
        'SELECT app_capture_ingestion_analytics_snapshot($1,$2,$3)',
        [context.organizationId, context.productId, context.competitorId],
      )
    }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '40001') {
      throw new ConflictError('Scheduled sync lease was lost')
    }
    throw error
  }
}

async function upsertScheduledAd(
  client: SqlConnection,
  fence: { runId: string; owner: string; token: string },
  id: string,
  ingestionToken: string,
  item: CollectedAd,
  scopeKey: string | null,
): Promise<{ id: string; ingestion_token: string; product_id: string; competitor_id: string } | undefined> {
  try {
    const result = await client.query<{ id: string; ingestion_token: string; product_id: string; competitor_id: string }>(
      'SELECT * FROM app_upsert_scheduled_competitor_ad($1,$2,$3,$4,$5,$6::jsonb,$7)',
      [fence.runId, fence.owner, fence.token, id, ingestionToken, JSON.stringify(item), scopeKey],
    )
    return result.rows[0]
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '40001') {
      throw new ConflictError('Scheduled sync lease was lost')
    }
    throw error
  }
}

async function upsertAd(
  client: SqlConnection,
  id: string,
  ingestionToken: string,
  providerName: string,
  context: Readonly<AdCollectionContext>,
  item: CollectedAd,
  seenAt: string,
  scopeKey: string | null,
): Promise<{ id: string; ingestion_token: string; product_id: string; competitor_id: string } | undefined> {
  const result = await client.query<{ id: string; ingestion_token: string; product_id: string; competitor_id: string }>(
    `INSERT INTO competitor_ads (
      id, ingestion_token, organization_id, product_id, competitor_id, provider_name, platform,
      external_id, page_id, advertiser_name, body, headline, description, call_to_action,
      display_format, ad_type, started_at, ended_at, is_active, publisher_platforms,
      impressions_lower_bound, impressions_upper_bound, spend_lower_bound, spend_upper_bound,
      currency, media, media_urls, source_url, first_seen_at, last_seen_at, snapshot_scope_key
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
      $17, $18, $19, $20::jsonb, $21, $22, $23, $24, $25, $26::jsonb, $27::jsonb, $28, $29, $29, $30
    )
    ON CONFLICT (organization_id, provider_name, platform, external_id)
    DO UPDATE SET
      page_id = EXCLUDED.page_id,
      advertiser_name = EXCLUDED.advertiser_name,
      body = EXCLUDED.body,
      headline = EXCLUDED.headline,
      description = EXCLUDED.description,
      call_to_action = EXCLUDED.call_to_action,
      display_format = EXCLUDED.display_format,
      ad_type = EXCLUDED.ad_type,
      started_at = EXCLUDED.started_at,
      ended_at = EXCLUDED.ended_at,
      is_active = EXCLUDED.is_active,
      publisher_platforms = EXCLUDED.publisher_platforms,
      impressions_lower_bound = EXCLUDED.impressions_lower_bound,
      impressions_upper_bound = EXCLUDED.impressions_upper_bound,
      spend_lower_bound = EXCLUDED.spend_lower_bound,
      spend_upper_bound = EXCLUDED.spend_upper_bound,
      currency = EXCLUDED.currency,
      media = EXCLUDED.media,
      media_urls = EXCLUDED.media_urls,
      source_url = EXCLUDED.source_url,
      last_seen_at = EXCLUDED.last_seen_at,
      snapshot_scope_key = CASE WHEN EXCLUDED.snapshot_scope_key IS NULL THEN competitor_ads.snapshot_scope_key ELSE EXCLUDED.snapshot_scope_key END
    WHERE competitor_ads.product_id = EXCLUDED.product_id
      AND competitor_ads.competitor_id = EXCLUDED.competitor_id
    RETURNING competitor_ads.id, competitor_ads.ingestion_token, competitor_ads.product_id, competitor_ads.competitor_id`,
    [
      id, ingestionToken, context.organizationId, context.productId, context.competitorId, providerName,
      item.platform, item.externalId, item.pageId ?? null, item.advertiserName, item.body,
      item.headline ?? null, item.description ?? null, item.callToAction, item.displayFormat ?? null,
      item.adType ?? null, item.startedAt, item.endedAt ?? null, item.isActive,
      item.publisherPlatforms == null ? null : JSON.stringify(item.publisherPlatforms),
      item.impressionsLowerBound ?? null, item.impressionsUpperBound ?? null,
      item.spendLowerBound ?? null, item.spendUpperBound ?? null, item.currency ?? null,
      item.media == null ? null : JSON.stringify(item.media), JSON.stringify(item.mediaUrls),
      item.sourceUrl, seenAt, scopeKey,
    ],
  )
  return result.rows[0]
}
