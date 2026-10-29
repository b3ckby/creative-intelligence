import assert from 'node:assert/strict'
import test from 'node:test'

import { OrganizationService } from '../../src/organizations/organization-service.ts'
import { PostgresOrganizationRepository } from '../../src/persistence/postgres-organization-repository.ts'
import { PostgresWinningAdsRepository } from '../../src/persistence/postgres-winning-ads-repository.ts'
import { withVerifiedUserContext } from '../../src/persistence/verified-user-context.ts'
import { withRealPostgres } from './helpers/real-postgres.ts'

const checksum = 'c'.repeat(64)

test('Winning Ads RLS isolates tenants and copied media survives source deletion', async () => {
  await withRealPostgres(async ({ runtimePool, inspectionPool }) => {
    const organizations = new OrganizationService(new PostgresOrganizationRepository(runtimePool), () => 'org-winning', () => new Date())
    await organizations.create({ name: 'Winning', actorUserId: 'winning-admin' })
    await withVerifiedUserContext(runtimePool, 'winning-admin', async (connection) => {
      await connection.query(`INSERT INTO products(id,organization_id,name) VALUES ('product-winning','org-winning','Product')`)
      await connection.query(`INSERT INTO competitors(id,organization_id,product_id,name) VALUES ('competitor-winning','org-winning','product-winning','Competitor')`)
      await connection.query(`INSERT INTO competitor_ads(id,ingestion_token,organization_id,product_id,competitor_id,provider_name,platform,external_id,advertiser_name,body,started_at,is_active,media_urls,source_url,first_seen_at,last_seen_at)
        VALUES ('ad-winning','token-winning','org-winning','product-winning','competitor-winning','manual-meta','meta','external-winning','Advertiser','Durable copy',clock_timestamp(),true,$1::jsonb,'https://example.test/ad',clock_timestamp(),clock_timestamp())`, [JSON.stringify(['https://cdn.example.test/ad.jpg'])])
    })
    await inspectionPool.query(`INSERT INTO creative_media_blobs(checksum,byte_size,media_type) VALUES ($1,12,'image/png')`, [checksum])
    await inspectionPool.query(`UPDATE competitor_ad_media_positions SET status='succeeded',active_checksum=$1,active_source_url=desired_source_url WHERE ad_id='ad-winning'`, [checksum])

    const repository = new PostgresWinningAdsRepository(runtimePool, () => 'winning-1', () => new Date('2026-10-28T12:00:00.000Z'))
    const saved = await repository.save('winning-admin', 'org-winning', 'ad-winning', { title: 'Reference', category: 'classic', notes: '' })
    assert.equal(saved.media[0]?.url, `/media/sha256/${checksum}`)
    assert.equal(await repository.find('outsider', 'org-winning', saved.id), undefined)

    await inspectionPool.query(`DELETE FROM competitor_ads WHERE organization_id='org-winning' AND id='ad-winning'`)
    const durable = await repository.find('winning-admin', 'org-winning', saved.id)
    assert.equal(durable?.copy.body, 'Durable copy')
    assert.equal(durable?.media[0]?.checksum, checksum)
    await assert.rejects(() => inspectionPool.query('DELETE FROM creative_media_blobs WHERE checksum=$1', [checksum]), /foreign key/i)
  })
})

test('Winning Ads rejects a source whose competitor parent is archived', async () => {
  await withRealPostgres(async ({ runtimePool, inspectionPool }) => {
    const organizations = new OrganizationService(new PostgresOrganizationRepository(runtimePool), () => 'org-winning-archived', () => new Date())
    await organizations.create({ name: 'Winning archived', actorUserId: 'winning-admin' })
    await withVerifiedUserContext(runtimePool, 'winning-admin', async (connection) => {
      await connection.query(`INSERT INTO products(id,organization_id,name) VALUES ('product-winning','org-winning-archived','Product')`)
      await connection.query(`INSERT INTO competitors(id,organization_id,product_id,name,archived_at) VALUES ('competitor-winning','org-winning-archived','product-winning','Competitor',clock_timestamp())`)
      await connection.query(`INSERT INTO competitor_ads(id,ingestion_token,organization_id,product_id,competitor_id,provider_name,platform,external_id,advertiser_name,body,started_at,is_active,media_urls,source_url,first_seen_at,last_seen_at)
        VALUES ('ad-winning','token-winning','org-winning-archived','product-winning','competitor-winning','manual-meta','meta','external-winning','Advertiser','Copy',clock_timestamp(),true,$1::jsonb,'https://example.test/ad',clock_timestamp(),clock_timestamp())`, [JSON.stringify(['https://cdn.example.test/ad.jpg'])])
    })
    await inspectionPool.query(`INSERT INTO creative_media_blobs(checksum,byte_size,media_type) VALUES ($1,12,'image/png') ON CONFLICT DO NOTHING`, [checksum])
    await inspectionPool.query(`UPDATE competitor_ad_media_positions SET status='succeeded',active_checksum=$1,active_source_url=desired_source_url WHERE organization_id='org-winning-archived'`, [checksum])
    const repository = new PostgresWinningAdsRepository(runtimePool, () => 'winning-2', () => new Date())
    await assert.rejects(() => repository.save('winning-admin', 'org-winning-archived', 'ad-winning', { title: 'Reference', category: 'classic', notes: '' }), /mirrored media/i)
  })
})
