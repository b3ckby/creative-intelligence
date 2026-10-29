import assert from 'node:assert/strict'
import test from 'node:test'

import { NotFoundError } from '../../src/domain/errors.ts'
import { OrganizationService } from '../../src/organizations/organization-service.ts'
import { PostgresCreativeAnalysisService } from '../../src/persistence/postgres-creative-analysis-service.ts'
import { PostgresCreativeStrategyService } from '../../src/persistence/postgres-creative-strategy-service.ts'
import { PostgresOrganizationRepository } from '../../src/persistence/postgres-organization-repository.ts'
import { withVerifiedUserContext } from '../../src/persistence/verified-user-context.ts'
import { withRealPostgres } from './helpers/real-postgres.ts'

const instant = new Date('2026-10-28T12:00:00.000Z')

function tags(hookCategory: 'pain_point' | 'results', persona: string) {
  return { hookCategory, angle: 'rational', emotion: 'relief', persona, format: 'tutorial', offerFrame: 'demo', cta: 'Learn more', visualSummary: 'Copy-led message', funnelStage: 'consideration', confidence: 0.82 } as const
}

test('real PostgreSQL creative strategy aggregates latest analyses and enforces tenant scope', async () => {
  await withRealPostgres(async ({ runtimePool }) => {
    const organizations = new OrganizationService(new PostgresOrganizationRepository(runtimePool), (() => { const ids = ['org-strategy', 'org-other']; return () => ids.shift()! })(), () => instant)
    await organizations.create({ name: 'Strategy org', actorUserId: 'user-strategy' })
    await organizations.create({ name: 'Other org', actorUserId: 'user-other' })
    await withVerifiedUserContext(runtimePool, 'user-strategy', async (connection) => {
      await connection.query(`INSERT INTO products (id, organization_id, name) VALUES ('product-strategy', 'org-strategy', 'Product')`)
      await connection.query(`INSERT INTO competitors (id, organization_id, product_id, name) VALUES ('competitor-strategy', 'org-strategy', 'product-strategy', 'Competitor')`)
      for (const [id, external] of [['ad-one', 'external-one'], ['ad-two', 'external-two']] as const) {
        await connection.query(`INSERT INTO competitor_ads
          (id, ingestion_token, organization_id, product_id, competitor_id, provider_name, platform, external_id, advertiser_name, body, started_at, is_active, source_url, first_seen_at, last_seen_at)
          VALUES ($1, $2, 'org-strategy', 'product-strategy', 'competitor-strategy', 'provider', 'meta', $3, 'Advertiser', 'Copy', $4, true, $5, $4, $4)`,
        [id, `token-${id}`, external, instant.toISOString(), `https://example.test/${id}`])
      }
    })

    let current = tags('pain_point', 'Founders')
    const analysis = new PostgresCreativeAnalysisService(runtimePool, { provider: 'gemini', model: 'test', async analyze() { return current } }, () => instant, 20)
    await analysis.analyze('user-strategy', 'org-strategy', 'product-strategy', 'ad-one')
    await withVerifiedUserContext(runtimePool, 'user-strategy', async (connection) => { await connection.query(`UPDATE competitor_ads SET body = 'Changed copy' WHERE id = 'ad-one'`) })
    current = tags('results', 'Founders')
    await analysis.analyze('user-strategy', 'org-strategy', 'product-strategy', 'ad-one')
    await analysis.analyze('user-strategy', 'org-strategy', 'product-strategy', 'ad-two')

    const service = new PostgresCreativeStrategyService(runtimePool)
    const summary = await service.get('user-strategy', 'org-strategy', 'product-strategy', 'competitor-strategy')
    assert.equal(summary.totalAds, 2)
    assert.equal(summary.analyzedAds, 2)
    assert.deepEqual(summary.dimensions.hooks, [{ value: 'results', count: 2, percentage: 100 }])
    assert.deepEqual(summary.dimensions.personas, [{ value: 'Founders', count: 2, percentage: 100 }])
    await assert.rejects(service.get('user-other', 'org-strategy', 'product-strategy', 'competitor-strategy'), NotFoundError)
  })
})
