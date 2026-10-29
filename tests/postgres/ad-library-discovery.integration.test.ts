import assert from 'node:assert/strict'
import test from 'node:test'

import { OrganizationService } from '../../src/organizations/organization-service.ts'
import { buildApi } from '../../src/http/build-api.ts'
import { PostgresCatalogRepository } from '../../src/persistence/postgres-catalog-repository.ts'
import { PostgresCreativeAnalysisService } from '../../src/persistence/postgres-creative-analysis-service.ts'
import { PostgresOrganizationRepository } from '../../src/persistence/postgres-organization-repository.ts'
import { withVerifiedUserContext } from '../../src/persistence/verified-user-context.ts'
import { withRealPostgres } from './helpers/real-postgres.ts'

const instant = new Date('2026-10-28T12:00:00.000Z')
const resultTags = (hookCategory: 'pain_point' | 'results') => ({ hookCategory, angle: 'rational', emotion: 'relief', persona: 'Founder', format: 'ugc', offerFrame: 'demo', cta: 'Learn more', visualSummary: 'Copy-led', funnelStage: 'consideration', confidence: 0.8 }) as const

test('real PostgreSQL ad discovery combines search, latest AI facets, sort and user-private bookmarks', async () => {
  await withRealPostgres(async ({ runtimePool }) => {
    const organizations = new OrganizationService(new PostgresOrganizationRepository(runtimePool), () => 'org-discovery', () => instant)
    await organizations.create({ name: 'Discovery org', actorUserId: 'admin-discovery' })
    await organizations.addMember({ organizationId: 'org-discovery', actorUserId: 'admin-discovery', userId: 'member-discovery', role: 'member' })
    await withVerifiedUserContext(runtimePool, 'admin-discovery', async (connection) => {
      await connection.query(`INSERT INTO products (id, organization_id, name) VALUES ('product-discovery', 'org-discovery', 'Product')`)
      await connection.query(`INSERT INTO competitors (id, organization_id, product_id, name) VALUES ('competitor-discovery', 'org-discovery', 'product-discovery', 'Competitor')`)
      await connection.query(`INSERT INTO competitor_ads
        (id, ingestion_token, organization_id, product_id, competitor_id, provider_name, platform, external_id, advertiser_name, body, started_at, is_active, impressions_upper_bound, source_url, first_seen_at, last_seen_at)
        VALUES
        ('ad-high', 'token-high', 'org-discovery', 'product-discovery', 'competitor-discovery', 'provider', 'meta', 'external-high', 'Orbit', 'Stop missing customer calls', '2026-10-01T00:00:00Z', true, 900, 'https://example.test/high', '2026-10-01T00:00:00Z', '2026-10-20T00:00:00Z'),
        ('ad-low', 'token-low', 'org-discovery', 'product-discovery', 'competitor-discovery', 'provider', 'meta', 'external-low', 'Orbit', 'Grow your pipeline', '2026-10-02T00:00:00Z', true, 100, 'https://example.test/low', '2026-10-02T00:00:00Z', '2026-10-21T00:00:00Z')`)
    })

    let tags = resultTags('pain_point')
    const analysis = new PostgresCreativeAnalysisService(runtimePool, { provider: 'gemini', model: 'test', async analyze() { return tags } }, () => instant, 20)
    await analysis.analyze('admin-discovery', 'org-discovery', 'product-discovery', 'ad-high')
    tags = resultTags('results')
    await analysis.analyze('admin-discovery', 'org-discovery', 'product-discovery', 'ad-low')

    const catalog = new PostgresCatalogRepository(runtimePool)
    await catalog.setAdBookmark('admin-discovery', 'org-discovery', 'ad-high', true)
    const rows = await catalog.pageAds('admin-discovery', 'org-discovery', {
      limit: 10, productId: 'product-discovery', search: 'missing calls', hookCategory: 'pain_point', angle: 'rational',
      creativeFormat: 'ugc', bookmarked: true, sort: 'impressions_desc',
    })
    assert.deepEqual(rows.map(({ id, bookmarked }) => ({ id, bookmarked })), [{ id: 'ad-high', bookmarked: true }])

    assert.deepEqual(await catalog.pageAds('member-discovery', 'org-discovery', { limit: 10, bookmarked: true }), [])

    const app = buildApi({
      pool: runtimePool, createId: () => 'unused', now: () => instant, adLibraryDiscovery: true,
      cursorSigningKey: 'test-cursor-signing-key-at-least-32-bytes', authenticate: async () => 'admin-discovery',
    })
    const bookmark = await app.inject({ method: 'POST', url: '/organizations/org-discovery/ads/ad-low/bookmark', payload: { bookmarked: true } })
    assert.equal(bookmark.statusCode, 200)
    assert.deepEqual(bookmark.json(), { bookmarked: true })
    const listed = await app.inject({ method: 'GET', url: '/organizations/org-discovery/ads?search=pipeline&hookCategory=results&sort=impressions_desc&bookmarked=true' })
    assert.equal(listed.statusCode, 200)
    assert.deepEqual(listed.json().items.map(({ id, bookmarked }: { id: string; bookmarked: boolean }) => ({ id, bookmarked })), [{ id: 'ad-low', bookmarked: true }])
    await app.close()
  })
})
