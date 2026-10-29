import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { PostgresAutoAnalysisService } from '../../src/creative-analysis/postgres-auto-analysis-service.ts'
import { creativeAnalysisVersion, creativeInputFingerprint } from '../../src/creative-analysis/creative-analysis-service.ts'
import type { MediaStore } from '../../src/media/content-addressed-store.ts'
import { OrganizationService } from '../../src/organizations/organization-service.ts'
import { PostgresOrganizationRepository } from '../../src/persistence/postgres-organization-repository.ts'
import { PostgresCreativeAnalysisService } from '../../src/persistence/postgres-creative-analysis-service.ts'
import { verifyAnalysisWorkerDatabase } from '../../src/persistence/postgres-pool.ts'
import { withVerifiedUserContext } from '../../src/persistence/verified-user-context.ts'
import { withRealPostgres } from './helpers/real-postgres.ts'

const tags = { hookCategory: 'pain_point', angle: 'rational', emotion: 'relief', persona: 'busy marketers', format: 'tutorial', offerFrame: 'demo', cta: 'Learn more', visualSummary: 'Mirrored image-grounded creative.', funnelStage: 'consideration', confidence: 0.6 } as const
const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const imageChecksum = createHash('sha256').update(imageBytes).digest('hex')
const mirroredStore: MediaStore = {
  async put() { throw new Error('unused') },
  async read(checksum) { assert.equal(checksum, imageChecksum); return { bytes: imageBytes, byteSize: imageBytes.length, mediaType: 'image/png' } },
}

test('real PostgreSQL automatic analysis recovers expired leases, fences stale workers, isolates tenants, and shares manual cache', async () => {
  await withRealPostgres(async ({ runtimePool, analysisWorkerPool, inspectionPool }) => {
    await verifyAnalysisWorkerDatabase(analysisWorkerPool, 5_000)
    const now = () => new Date('2026-10-28T10:00:00.000Z')
    let organizationSequence = 0
    const organizations = new OrganizationService(new PostgresOrganizationRepository(runtimePool), () => organizationSequence++ === 0 ? 'org-auto' : 'org-other', now)
    await organizations.create({ name: 'Auto org', actorUserId: 'user-auto' })
    await organizations.create({ name: 'Other org', actorUserId: 'user-other' })
    await withVerifiedUserContext(runtimePool, 'user-auto', async (connection) => {
      await connection.query(`INSERT INTO products(id,organization_id,name) VALUES('product-auto','org-auto','Product')`)
      await connection.query(`INSERT INTO competitors(id,organization_id,product_id,name) VALUES('competitor-auto','org-auto','product-auto','Competitor')`)
      await connection.query(`INSERT INTO competitor_ads(id,ingestion_token,organization_id,product_id,competitor_id,provider_name,platform,external_id,advertiser_name,body,started_at,is_active,source_url,first_seen_at,last_seen_at)
        VALUES('ad-auto','token','org-auto','product-auto','competitor-auto','provider','meta','external','Example','Save time',now(),true,'https://example.test/ad',now(),now())`)
    })
    await inspectionPool.query(`INSERT INTO creative_media_blobs(checksum,byte_size,media_type) VALUES($1,$2,'image/png')`, [imageChecksum, imageBytes.length])
    await inspectionPool.query(`INSERT INTO competitor_ad_media_positions(organization_id,ad_id,slot_kind,position,media_kind,desired_source_url,active_source_url,active_checksum,status)
      VALUES('org-auto','ad-auto','legacy',0,'unknown','https://cdn.example.test/image.png','https://cdn.example.test/image.png',$1,'succeeded')`, [imageChecksum])
    const tagger = { provider: 'gemini', model: 'gemini-test', calls: 0, async analyze() { this.calls += 1; return tags } }
    const settings = { leaseSeconds: 60, batchSize: 1, dailyLimit: 10, maxMediaCount: 4, maxMediaBytes: 1024, backoffBaseMs: 1000, backoffMaxMs: 10000 }
    const crashed = new PostgresAutoAnalysisService(analysisWorkerPool, mirroredStore, tagger, 'worker-crashed', settings)
    const [stale] = await crashed.claim()
    assert.ok(stale)
    await inspectionPool.query(`UPDATE creative_analysis_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [stale.job_id])
    const recovered = new PostgresAutoAnalysisService(analysisWorkerPool, mirroredStore, tagger, 'worker-recovered', settings)
    const [fresh] = await recovered.claim()
    assert.ok(fresh)
    assert.notEqual(stale.fence_token, fresh.fence_token)
    const staleBegin = await analysisWorkerPool.query<{ outcome: string }>('SELECT * FROM app_begin_auto_analysis($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [
      stale.job_id, 'worker-crashed', stale.fence_token, creativeAnalysisVersion('gemini', 'gemini-test'),
      creativeInputFingerprint({ advertiserName: 'Example', body: 'Save time', callToAction: null }), 'gemini', 'gemini-test', 'creative-tags-grounded-v2', 'copy_only', 0, 10,
    ])
    assert.equal(staleBegin.rows[0]?.outcome, 'lost')
    await recovered.run(fresh)
    assert.equal(tagger.calls, 1)

    const hidden = await withVerifiedUserContext(runtimePool, 'user-other', async (connection) => connection.query('SELECT * FROM creative_analysis_jobs WHERE organization_id=$1', ['org-auto']))
    assert.equal(hidden.rowCount, 0)

    const manual = new PostgresCreativeAnalysisService(runtimePool, tagger, now, 10, mirroredStore)
    const cached = await manual.analyze('user-auto', 'org-auto', 'product-auto', 'ad-auto')
    assert.equal(tagger.calls, 1)
    assert.equal(cached.provenance, 'automatic')
    assert.equal(cached.analysisMode, 'media')
    assert.equal(cached.mediaCount, 1)
  })
})
