import assert from 'node:assert/strict'
import test from 'node:test'

import { OrganizationService } from '../../src/organizations/organization-service.ts'
import { PostgresInspirationRepository } from '../../src/persistence/postgres-inspiration-repository.ts'
import { PostgresOrganizationRepository } from '../../src/persistence/postgres-organization-repository.ts'
import { withVerifiedUserContext } from '../../src/persistence/verified-user-context.ts'
import { withRealPostgres } from './helpers/real-postgres.ts'

const checksum = 'd'.repeat(64)

test('Inspiration FORCE RLS isolates organizations and durable snapshots survive source deletion', async () => {
  await withRealPostgres(async ({ runtimePool, inspectionPool }) => {
    const organizations = new OrganizationService(new PostgresOrganizationRepository(runtimePool), () => 'org-inspiration', () => new Date())
    await organizations.create({ name: 'Inspiration', actorUserId: 'inspiration-admin' })
    await withVerifiedUserContext(runtimePool, 'inspiration-admin', async (connection) => {
      await connection.query(`INSERT INTO products(id,organization_id,name) VALUES ('product-inspiration','org-inspiration','Product')`)
      await connection.query(`INSERT INTO competitors(id,organization_id,product_id,name) VALUES ('competitor-inspiration','org-inspiration','product-inspiration','Competitor')`)
      await connection.query(`INSERT INTO competitor_ads(id,ingestion_token,organization_id,product_id,competitor_id,provider_name,platform,external_id,advertiser_name,body,headline,started_at,is_active,media_urls,source_url,first_seen_at,last_seen_at)
        VALUES ('ad-inspiration','token-inspiration','org-inspiration','product-inspiration','competitor-inspiration','manual-meta','meta','external-inspiration','Orbit','Durable visual language','Move faster',clock_timestamp(),true,$1::jsonb,'https://example.test/ad',clock_timestamp(),clock_timestamp())`, [JSON.stringify(['https://cdn.example.test/ad.jpg'])])
    })
    await inspectionPool.query(`INSERT INTO creative_media_blobs(checksum,byte_size,media_type) VALUES ($1,12,'image/png')`, [checksum])
    await inspectionPool.query(`UPDATE competitor_ad_media_positions SET status='succeeded',active_checksum=$1,active_source_url=desired_source_url WHERE ad_id='ad-inspiration'`, [checksum])
    const ids = ['board-1', 'item-1']
    const repository = new PostgresInspirationRepository(runtimePool, () => ids.shift()!, () => new Date('2026-10-28T12:00:00.000Z'))
    const board = await repository.createBoard('inspiration-admin', 'org-inspiration', { name: 'Launch worlds', description: '' })
    const item = await repository.addItem('inspiration-admin', 'org-inspiration', board.id, { sourceKind: 'competitor_ad', sourceId: 'ad-inspiration', title: 'Kinetic proof', notes: 'Reuse the rhythm', tags: ['motion', 'proof'] })
    assert.equal(item.media[0]?.url, `/media/sha256/${checksum}`)
    assert.equal(await repository.findItem('outsider', 'org-inspiration', item.id), undefined)
    await inspectionPool.query(`DELETE FROM competitor_ads WHERE organization_id='org-inspiration' AND id='ad-inspiration'`)
    const durable = await repository.findItem('inspiration-admin', 'org-inspiration', item.id)
    assert.equal(durable?.copy.body, 'Durable visual language')
    await assert.rejects(() => inspectionPool.query('DELETE FROM creative_media_blobs WHERE checksum=$1', [checksum]), /foreign key/i)
    const policies = await inspectionPool.query<{ relname: string; relforcerowsecurity: boolean }>(`SELECT relname,relforcerowsecurity FROM pg_class WHERE relname IN ('inspiration_boards','inspiration_items','inspiration_item_media') ORDER BY relname`)
    assert.deepEqual(policies.rows, [
      { relname: 'inspiration_boards', relforcerowsecurity: true },
      { relname: 'inspiration_item_media', relforcerowsecurity: true },
      { relname: 'inspiration_items', relforcerowsecurity: true },
    ])
  })
})
