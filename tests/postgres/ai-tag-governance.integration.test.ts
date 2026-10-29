import assert from 'node:assert/strict'
import test from 'node:test'

import { NotFoundError } from '../../src/domain/errors.ts'
import { OrganizationService } from '../../src/organizations/organization-service.ts'
import { PostgresCreativeAnalysisService } from '../../src/persistence/postgres-creative-analysis-service.ts'
import { PostgresCreativeTagReviewRepository } from '../../src/persistence/postgres-creative-tag-review-repository.ts'
import { PostgresOrganizationRepository } from '../../src/persistence/postgres-organization-repository.ts'
import { withVerifiedUserContext } from '../../src/persistence/verified-user-context.ts'
import { withRealPostgres } from './helpers/real-postgres.ts'

const instant = new Date('2026-10-29T10:00:00.000Z')
const tags = { hookCategory: 'pain_point', angle: 'rational', emotion: 'relief', persona: 'Founder', format: 'ugc', offerFrame: 'demo', cta: 'Learn more', visualSummary: 'Founder demo', funnelStage: 'consideration', confidence: 0.9 } as const

test('real PostgreSQL keeps model output immutable and review history exact, append-only, stale-aware, and tenant-isolated', async () => {
  await withRealPostgres(async ({ runtimePool }) => {
    const organizations = new OrganizationService(new PostgresOrganizationRepository(runtimePool), (() => { const ids = ['org-review', 'org-other']; return () => ids.shift()! })(), () => instant)
    await organizations.create({ name: 'Review org', actorUserId: 'reviewer-1' })
    await organizations.create({ name: 'Other org', actorUserId: 'other-1' })
    await withVerifiedUserContext(runtimePool, 'reviewer-1', async (connection) => {
      await connection.query(`INSERT INTO products (id,organization_id,name) VALUES ('product-review','org-review','Product')`)
      await connection.query(`INSERT INTO competitors (id,organization_id,product_id,name) VALUES ('competitor-review','org-review','product-review','Competitor')`)
      await connection.query(`INSERT INTO competitor_ads
        (id,ingestion_token,organization_id,product_id,competitor_id,provider_name,platform,external_id,advertiser_name,body,started_at,is_active,source_url,first_seen_at,last_seen_at)
        VALUES ('ad-review','token-review','org-review','product-review','competitor-review','provider','meta','external-review','Orbit','Original copy',$1,true,'https://example.test/ad',$1,$1)`, [instant.toISOString()])
    })
    const analyses = new PostgresCreativeAnalysisService(runtimePool, { provider: 'gemini', model: 'test', async analyze() { return tags } }, () => instant, 20)
    const first = await analyses.analyze('reviewer-1', 'org-review', 'product-review', 'ad-review')
    const reviews = new PostgresCreativeTagReviewRepository(runtimePool)
    const corrected = await reviews.submit('reviewer-1', 'org-review', 'ad-review', first.analysisVersion, first.inputFingerprint, {
      expectedReviewVersion: 0, decision: 'corrected', corrections: { format: 'tutorial' }, reason: 'Verified against the source creative.',
    })
    assert.equal(corrected.reviewVersion, 1)
    const approved = await reviews.submit('reviewer-1', 'org-review', 'ad-review', first.analysisVersion, first.inputFingerprint, {
      expectedReviewVersion: 1, decision: 'approved', corrections: null, reason: 'Second reviewer pass completed.',
    })
    assert.equal(approved.reviewVersion, 2)
    assert.deepEqual((await reviews.history('reviewer-1', 'org-review', 'ad-review', first.analysisVersion, first.inputFingerprint, 100)).map(({ reviewVersion }) => reviewVersion), [2, 1])

    await assert.rejects(withVerifiedUserContext(runtimePool, 'reviewer-1', async (connection) => connection.query(`UPDATE creative_ad_analyses SET tags='{}'::jsonb WHERE organization_id='org-review' AND competitor_ad_id='ad-review' AND status='completed'`)), /immutable/u)
    await withVerifiedUserContext(runtimePool, 'reviewer-1', async (connection) => connection.query(`UPDATE competitor_ads SET body='New copy' WHERE organization_id='org-review' AND id='ad-review'`))
    const second = await analyses.analyze('reviewer-1', 'org-review', 'product-review', 'ad-review')
    assert.notEqual(second.inputFingerprint, first.inputFingerprint)
    assert.equal((await reviews.detail('reviewer-1', 'org-review', 'ad-review', first.analysisVersion, first.inputFingerprint)).stale, true)
    const queue = await reviews.list('reviewer-1', 'org-review', { productId: 'product-review', status: 'pending', limit: 100 })
    assert.equal(queue.length, 1); assert.equal(queue[0]?.analysis.inputFingerprint, second.inputFingerprint)
    await assert.rejects(reviews.detail('other-1', 'org-review', 'ad-review', first.analysisVersion, first.inputFingerprint), NotFoundError)
    await assert.rejects(reviews.submit('other-1', 'org-review', 'ad-review', first.analysisVersion, first.inputFingerprint, { expectedReviewVersion: 2, decision: 'approved', corrections: null, reason: 'Cross tenant attempt.' }), NotFoundError)
  })
})
