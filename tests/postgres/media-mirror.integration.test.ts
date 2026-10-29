import assert from 'node:assert/strict'
import test from 'node:test'

import { OrganizationService } from '../../src/organizations/organization-service.ts'
import { PostgresOrganizationRepository } from '../../src/persistence/postgres-organization-repository.ts'
import { PostgresCatalogRepository } from '../../src/persistence/postgres-catalog-repository.ts'
import { withVerifiedUserContext } from '../../src/persistence/verified-user-context.ts'
import { withRealPostgres } from './helpers/real-postgres.ts'

const shared = 'https://cdn.example.test/shared.jpg'
const replacement = 'https://cdn.example.test/replacement.jpg'
const checksum = 'a'.repeat(64)

test('media ledger preserves positions, isolates tenants, fences workers, and retains valid assets during replacement', async () => {
  await withRealPostgres(async ({ runtimePool, mediaWorkerPool, inspectionPool }) => {
    const organizations = new OrganizationService(new PostgresOrganizationRepository(runtimePool), () => 'org-media', () => new Date())
    await organizations.create({ name: 'Media', actorUserId: 'media-admin' })
    await withVerifiedUserContext(runtimePool, 'media-admin', async (connection) => {
      await connection.query(`INSERT INTO products(id,organization_id,name) VALUES ('product-media','org-media','Product')`)
      await connection.query(`INSERT INTO competitors(id,organization_id,product_id,name) VALUES ('competitor-media','org-media','product-media','Competitor')`)
      await connection.query(`INSERT INTO competitor_ads(
        id,ingestion_token,organization_id,product_id,competitor_id,provider_name,platform,external_id,advertiser_name,body,
        started_at,is_active,media,media_urls,source_url,first_seen_at,last_seen_at
      ) VALUES ('ad-media','token','org-media','product-media','competitor-media','apify-meta-ads','meta','external','Advertiser','Body',
        clock_timestamp(),true,$1::jsonb,$2::jsonb,'https://example.test/ad',clock_timestamp(),clock_timestamp())`, [JSON.stringify([
        { kind: 'image', sourceUrl: shared, posterUrl: null, cardIndex: 0, order: 0 },
        { kind: 'video', sourceUrl: shared, posterUrl: 'https://cdn.example.test/poster.jpg', cardIndex: 1, order: 1 },
      ]), JSON.stringify([shared])])
    })

    assert.deepEqual((await inspectionPool.query(`SELECT slot_kind,position,desired_source_url,card_index,status
      FROM competitor_ad_media_positions WHERE organization_id='org-media' ORDER BY slot_kind,position`)).rows, [
      { slot_kind: 'legacy', position: 0, desired_source_url: shared, card_index: null, status: 'queued' },
      { slot_kind: 'structured_poster', position: 1, desired_source_url: 'https://cdn.example.test/poster.jpg', card_index: 1, status: 'queued' },
      { slot_kind: 'structured_source', position: 0, desired_source_url: shared, card_index: 0, status: 'queued' },
      { slot_kind: 'structured_source', position: 1, desired_source_url: shared, card_index: 1, status: 'queued' },
    ])
    const outsider = await withVerifiedUserContext(runtimePool, 'outsider', async (connection) =>
      await connection.query(`SELECT 1 FROM competitor_ad_media_positions WHERE organization_id='org-media'`))
    assert.equal(outsider.rowCount, 0)
    await assert.rejects(() => mediaWorkerPool.query(`SELECT id FROM competitor_ads`), /permission denied/i)
    await assert.rejects(() => mediaWorkerPool.query(`UPDATE competitor_ad_media_positions SET status='failed'`), /permission denied/i)

    const [claimedA, claimedB] = await Promise.all([
      mediaWorkerPool.query(`SELECT * FROM app_claim_media_mirror_jobs('worker-a',30,2)`),
      mediaWorkerPool.query(`SELECT * FROM app_claim_media_mirror_jobs('worker-b',30,2)`),
    ])
    const claimed = [...claimedA.rows, ...claimedB.rows]
    assert.equal(claimed.length, 4)
    assert.equal(new Set(claimed.map((row) => row.id)).size, 4)

    const target = claimed.find((row) => row.slot_kind === 'structured_source' && row.position === 0)!
    assert.equal((await mediaWorkerPool.query(`SELECT app_finish_media_mirror_success($1,$2,$3,$4,$5,$6) AS ok`,
      [target.id, target.lease_owner, target.fence_token, checksum, 123, 'image/jpeg'])).rows[0]?.ok, true)
    assert.equal((await mediaWorkerPool.query(`SELECT app_finish_media_mirror_success($1,$2,$3,$4,$5,$6) AS ok`,
      [target.id, target.lease_owner, target.fence_token, checksum, 123, 'image/jpeg'])).rows[0]?.ok, false)
    const unclaimedChecksum = 'b'.repeat(64)
    assert.equal((await mediaWorkerPool.query(`SELECT app_finish_media_mirror_success($1,$2,$3,$4,$5,$6) AS ok`,
      ['00000000-0000-0000-0000-000000000000', 'attacker', 'invalid-fence', unclaimedChecksum, 1, 'image/jpeg'])).rows[0]?.ok, false)
    assert.equal((await inspectionPool.query(`SELECT 1 FROM creative_media_blobs WHERE checksum=$1`, [unclaimedChecksum])).rowCount, 0)
    const apiAds = await new PostgresCatalogRepository(runtimePool, true).pageAds('media-admin', 'org-media', { limit: 10 })
    assert.equal(apiAds[0]?.media?.[0]?.sourceUrl, shared)
    assert.equal(apiAds[0]?.media?.[0]?.mirroredUrl, `/media/sha256/${checksum}`)
    assert.equal(apiAds[0]?.media?.[1]?.mirroredUrl, undefined)

    await inspectionPool.query(`UPDATE competitor_ads SET media=jsonb_set(media,'{0,sourceUrl}',to_jsonb($1::text)) WHERE id='ad-media'`, [replacement])
    const pending = (await inspectionPool.query(`SELECT desired_source_url,active_source_url,active_checksum,status,attempt
      FROM competitor_ad_media_positions WHERE ad_id='ad-media' AND slot_kind='structured_source' AND position=0`)).rows[0]
    assert.deepEqual(pending, { desired_source_url: replacement, active_source_url: shared, active_checksum: checksum, status: 'queued', attempt: 0 })

    const replacementJob = (await mediaWorkerPool.query(`SELECT * FROM app_claim_media_mirror_jobs('worker-c',30,1)`)).rows[0]
    assert.equal(replacementJob.desired_source_url, replacement)
    assert.equal((await mediaWorkerPool.query(`SELECT app_finish_media_mirror_failure($1,$2,$3,'mime',0,true) AS ok`,
      [replacementJob.id, replacementJob.lease_owner, replacementJob.fence_token])).rows[0]?.ok, true)
    assert.deepEqual((await inspectionPool.query(`SELECT active_source_url,active_checksum,status FROM competitor_ad_media_positions WHERE id=$1`, [replacementJob.id])).rows[0],
      { active_source_url: shared, active_checksum: checksum, status: 'failed' })
  })
})

test('expired leases recover and bounded backfill resumes without direct table access', async () => {
  await withRealPostgres(async ({ runtimePool, mediaWorkerPool, inspectionPool }) => {
    const organizations = new OrganizationService(new PostgresOrganizationRepository(runtimePool), () => 'org-backfill', () => new Date())
    await organizations.create({ name: 'Backfill', actorUserId: 'backfill-admin' })
    await withVerifiedUserContext(runtimePool, 'backfill-admin', async (connection) => {
      await connection.query(`INSERT INTO products(id,organization_id,name) VALUES ('product-backfill','org-backfill','Product')`)
      await connection.query(`INSERT INTO competitors(id,organization_id,product_id,name) VALUES ('competitor-backfill','org-backfill','product-backfill','Competitor')`)
      for (const id of ['ad-a','ad-b','ad-c']) await connection.query(`INSERT INTO competitor_ads(
        id,ingestion_token,organization_id,product_id,competitor_id,provider_name,platform,external_id,advertiser_name,body,
        started_at,is_active,media_urls,source_url,first_seen_at,last_seen_at
      ) VALUES ($1,$1,'org-backfill','product-backfill','competitor-backfill','manual-meta','meta',$1,'A','B',clock_timestamp(),true,$2::jsonb,'https://example.test/ad',clock_timestamp(),clock_timestamp())`, [id, JSON.stringify([`https://cdn.example.test/${id}.jpg`])])
    })
    await inspectionPool.query(`DELETE FROM competitor_ad_media_positions`)
    await assert.rejects(() => mediaWorkerPool.query(`SELECT * FROM app_enqueue_media_backfill('skip-everything',2)`), /invalid media backfill cursor/i)

    const first = (await mediaWorkerPool.query(`SELECT * FROM app_enqueue_media_backfill(NULL,2)`)).rows[0]
    assert.deepEqual(first, { next_cursor: 'ad-b', enqueued: 2 })
    const second = (await mediaWorkerPool.query(`SELECT * FROM app_enqueue_media_backfill(NULL,2)`)).rows[0]
    assert.deepEqual(second, { next_cursor: null, enqueued: 1 })
    assert.equal((await inspectionPool.query(`SELECT 1 FROM competitor_ad_media_positions`)).rowCount, 3)

    const crashed = (await mediaWorkerPool.query(`SELECT * FROM app_claim_media_mirror_jobs('crashed',10,3)`)).rows
    assert.equal(crashed.length, 3)
    await inspectionPool.query(`UPDATE competitor_ad_media_positions SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE status='running'`)
    const recoveredRows = (await mediaWorkerPool.query(`SELECT * FROM app_claim_media_mirror_jobs('recovery',10,1)`)).rows
    assert.equal(recoveredRows.length, 1)
    const recovered = recoveredRows[0]!
    const claimed = crashed.find((row) => row.id === recovered.id)!
    assert.equal(recovered.attempt, 2)
    assert.notEqual(recovered.fence_token, claimed.fence_token)
    assert.equal((await inspectionPool.query(`SELECT count(*)::integer AS count FROM competitor_ad_media_positions WHERE status='running' AND lease_owner='crashed'`)).rows[0]?.count, 2)
    assert.equal((await mediaWorkerPool.query(`SELECT app_finish_media_mirror_failure($1,$2,$3,'network',1,false) AS ok`,
      [claimed.id, claimed.lease_owner, claimed.fence_token])).rows[0]?.ok, false)
  })
})
