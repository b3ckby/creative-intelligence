import assert from 'node:assert/strict'
import test from 'node:test'

import { OrganizationService } from '../../src/organizations/organization-service.ts'
import { PostgresOrganizationRepository } from '../../src/persistence/postgres-organization-repository.ts'
import { withVerifiedUserContext } from '../../src/persistence/verified-user-context.ts'
import { PostgresProviderAdImportService } from '../../src/persistence/postgres-provider-ad-import-service.ts'
import { buildApi } from '../../src/http/build-api.ts'
import { withRealPostgres } from './helpers/real-postgres.ts'

test('scheduled sync claims are single-flight, lease-recoverable, tenant scoped, and fail closed for revoked actors', async () => {
  await withRealPostgres(async ({ runtimePool, workerPool, inspectionPool }) => {
    const organizations = new OrganizationService(new PostgresOrganizationRepository(runtimePool), () => 'org-sync', () => new Date())
    await organizations.create({ name: 'Sync', actorUserId: 'sync-admin' })
    await withVerifiedUserContext(runtimePool, 'sync-admin', async (connection) => {
      await connection.query(`INSERT INTO products (id,organization_id,name) VALUES ('product-sync','org-sync','Product')`)
      await connection.query(`INSERT INTO competitors (id,organization_id,product_id,name,meta_page_url) VALUES ('competitor-sync','org-sync','product-sync','Competitor','https://facebook.com/orbit')`)
      await connection.query(`INSERT INTO competitor_ad_sync_schedules (id,organization_id,product_id,competitor_id,actor_user_id,interval_seconds,next_run_at) VALUES ('schedule-sync','org-sync','product-sync','competitor-sync','sync-admin',60,'2026-01-01T00:00:00Z')`)
    })

    await assert.rejects(() => runtimePool.query('SELECT * FROM app_claim_due_ad_sync_runs($1,$2,$3,$4)', ['attacker', 30, 3, 10]), /permission denied/i)
    const claim = (owner: string) => workerPool.query('SELECT id,status,lease_owner,fence_token,attempt FROM app_claim_due_ad_sync_runs($1,$2,$3,$4)', [owner, 30, 3, 10])
    const [first, second] = await Promise.all([claim('worker-one'), claim('worker-two')])
    assert.equal((first.rowCount ?? 0) + (second.rowCount ?? 0), 1)
    const original = [...first.rows, ...second.rows][0]
    assert.equal(original.status, 'running')
    assert.equal(original.attempt, 1)
    await assert.rejects(() => workerPool.query('SELECT id FROM competitor_ads'), /permission denied/i)
    await assert.rejects(() => workerPool.query('SELECT competitor_id FROM competitor_analytics_snapshots'), /permission denied/i)
    await assert.rejects(() => workerPool.query(`INSERT INTO competitor_ads(id,ingestion_token,organization_id,product_id,competitor_id,provider_name,platform,external_id,advertiser_name,body,started_at,is_active,media_urls,source_url,first_seen_at,last_seen_at) VALUES ('forged','forged','org-sync','product-sync','competitor-sync','apify-meta-ads','meta','forged','Forged','Forged',clock_timestamp(),true,'[]','https://example.test',clock_timestamp(),clock_timestamp())`), /permission denied/i)
    await assert.rejects(() => runtimePool.query(`UPDATE competitor_ad_sync_runs SET status='cancelled'`), /permission denied/i)

    await inspectionPool.query(`UPDATE competitor_ad_sync_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [original.id])
    const recovered = await claim('worker-three')
    assert.equal(recovered.rowCount, 1)
    assert.equal(recovered.rows[0]?.id, original.id)
    assert.equal(recovered.rows[0]?.attempt, 2)

    await withVerifiedUserContext(runtimePool, 'sync-admin', async (connection) => {
      await connection.query(`INSERT INTO organization_members (organization_id,user_id,role) VALUES ('org-sync','replacement-admin','admin')`)
      await connection.query(`UPDATE organization_members SET role='member' WHERE organization_id='org-sync' AND user_id='sync-admin'`)
    })
    await inspectionPool.query(`UPDATE competitor_ad_sync_runs SET status='failed', completed_at=clock_timestamp(), lease_owner=NULL, lease_expires_at=NULL, fence_token=NULL, last_error_category='authorization' WHERE id=$1`, [original.id])
    await inspectionPool.query(`UPDATE competitor_ad_sync_schedules SET next_run_at=clock_timestamp()-interval '1 second' WHERE id='schedule-sync'`)
    assert.equal((await claim('worker-four')).rowCount, 0)
    const active = await inspectionPool.query(`SELECT id FROM competitor_ad_sync_runs WHERE status IN ('queued','running','retry_wait')`)
    assert.equal(active.rowCount, 0)

    const outsider = await withVerifiedUserContext(runtimePool, 'outsider', async (connection) => await connection.query('SELECT id FROM competitor_ad_sync_schedules'))
    assert.equal(outsider.rowCount, 0)
  })
})

test('a reclaimed run fences stale ad mutations and ledger completion', async () => {
  await withRealPostgres(async ({ runtimePool, workerPool, inspectionPool }) => {
    const organizations = new OrganizationService(new PostgresOrganizationRepository(runtimePool), () => 'org-fence', () => new Date())
    await organizations.create({ name: 'Fence', actorUserId: 'admin-fence' })
    await withVerifiedUserContext(runtimePool, 'admin-fence', async (connection) => {
      await connection.query(`INSERT INTO products(id,organization_id,name) VALUES ('product-fence','org-fence','Product')`)
      await connection.query(`INSERT INTO competitors(id,organization_id,product_id,name) VALUES ('competitor-fence','org-fence','product-fence','Competitor')`)
      await connection.query(`INSERT INTO competitor_ad_sync_schedules(id,organization_id,product_id,competitor_id,actor_user_id,interval_seconds,next_run_at) VALUES ('schedule-fence','org-fence','product-fence','competitor-fence','admin-fence',60,clock_timestamp()-interval '1 second')`)
    })
    const first = (await workerPool.query(`SELECT id,fence_token FROM app_claim_due_ad_sync_runs('worker-a',30,3,1)`)).rows[0]!
    await inspectionPool.query(`UPDATE competitor_ad_sync_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [first.id])
    const second = (await workerPool.query(`SELECT id,fence_token FROM app_claim_due_ad_sync_runs('worker-b',30,3,1)`)).rows[0]!
    assert.equal(second.id, first.id)
    assert.notEqual(second.fence_token, first.fence_token)
    const imports = new PostgresProviderAdImportService(workerPool, () => 'stale-ad', () => new Date())
    const staleProvider = { collect: async () => [{
      platform: 'meta' as const, externalId: 'stale', advertiserName: 'Stale', body: 'Must not commit', callToAction: null,
      startedAt: new Date().toISOString(), isActive: true, mediaUrls: [], sourceUrl: 'https://example.test/stale',
    }] }
    await assert.rejects(() => imports.importWithDetails('admin-fence', 'apify-meta-ads', {
      organizationId: 'org-fence', productId: 'product-fence', competitorId: 'competitor-fence',
    }, staleProvider, { runId: first.id, owner: 'worker-a', token: first.fence_token }), /lease was lost/i)
    assert.equal((await inspectionPool.query(`SELECT id FROM competitor_ads WHERE external_id='stale'`)).rowCount, 0)
    assert.equal((await inspectionPool.query(`SELECT 1 FROM competitor_analytics_snapshots WHERE organization_id='org-fence'`)).rowCount, 0)
    assert.equal((await workerPool.query(`SELECT app_finish_ad_sync_run_failure($1,$2,$3,'internal',1) AS changed`, [first.id, 'worker-a', first.fence_token])).rows[0]?.changed, false)
    const ledger = (await inspectionPool.query(`SELECT status,lease_owner,fence_token FROM competitor_ad_sync_runs WHERE id=$1`, [first.id])).rows[0]
    assert.equal(ledger.status, 'running')
    assert.equal(ledger.lease_owner, 'worker-b')
    assert.equal(ledger.fence_token, second.fence_token)
    await assert.rejects(() => workerPool.query(`UPDATE competitor_ads SET body='forged'`), /permission denied/i)
    await assert.rejects(() => workerPool.query(`SELECT * FROM app_upsert_scheduled_competitor_ad('missing','worker-b','bad','id','token','{}'::jsonb,NULL)`), /lease was lost/i)
    const scopeKey = 'apify-meta-ads:v1:country=ALL;active=all'
    await inspectionPool.query(`INSERT INTO competitor_ads(id,ingestion_token,organization_id,product_id,competitor_id,provider_name,platform,external_id,advertiser_name,body,started_at,is_active,media_urls,source_url,first_seen_at,last_seen_at,snapshot_scope_key)
      VALUES ('old-ad','old-token','org-fence','product-fence','competitor-fence','apify-meta-ads','meta','old','Old','Old',clock_timestamp(),true,'[]','https://example.test/old',clock_timestamp(),clock_timestamp(),$1)`, [scopeKey])
    const collected = [{
      platform: 'meta' as const, externalId: 'valid', advertiserName: 'Valid', body: 'Committed', callToAction: null,
      startedAt: new Date().toISOString(), isActive: true, mediaUrls: [], sourceUrl: 'https://example.test/valid',
    }]
    const validProvider = {
      collect: async () => collected,
      collectSnapshot: async () => ({ items: collected, completeness: 'complete' as const, scopeKey }),
    }
    const result = await imports.importWithDetails('admin-fence', 'apify-meta-ads', {
      organizationId: 'org-fence', productId: 'product-fence', competitorId: 'competitor-fence',
    }, validProvider, { runId: second.id, owner: 'worker-b', token: second.fence_token })
    assert.deepEqual(result, { inserted: 1, duplicates: 0, retired: 1, complete: true })
    assert.equal((await inspectionPool.query(`SELECT is_active FROM competitor_ads WHERE id='old-ad'`)).rows[0]?.is_active, false)
    assert.deepEqual((await inspectionPool.query(`SELECT competitor_id,active_ad_count FROM competitor_analytics_snapshots WHERE organization_id='org-fence'`)).rows,
      [{ competitor_id: 'competitor-fence', active_ad_count: 1 }])
    assert.equal((await inspectionPool.query(`SELECT status FROM competitor_ad_sync_runs WHERE id=$1`, [second.id])).rows[0]?.status, 'succeeded')
  })
})

test('scheduled ad upsert rejects malformed worker payloads before mutating a row', async () => {
  await withRealPostgres(async ({ runtimePool, workerPool, inspectionPool }) => {
    const organizations = new OrganizationService(new PostgresOrganizationRepository(runtimePool), () => 'org-payload', () => new Date())
    await organizations.create({ name: 'Payload', actorUserId: 'payload-admin' })
    await withVerifiedUserContext(runtimePool, 'payload-admin', async (connection) => {
      await connection.query(`INSERT INTO products(id,organization_id,name) VALUES ('product-payload','org-payload','Product')`)
      await connection.query(`INSERT INTO competitors(id,organization_id,product_id,name) VALUES ('competitor-payload','org-payload','product-payload','Competitor')`)
      await connection.query(`INSERT INTO competitor_ad_sync_schedules(id,organization_id,product_id,competitor_id,actor_user_id,interval_seconds,next_run_at) VALUES ('schedule-payload','org-payload','product-payload','competitor-payload','payload-admin',60,clock_timestamp()-interval '1 second')`)
    })
    const run = (await workerPool.query(`SELECT id,fence_token FROM app_claim_due_ad_sync_runs('payload-worker',30,3,1)`)).rows[0]!
    const valid = {
      platform: 'meta', externalId: 'guarded', pageId: null, advertiserName: 'Advertiser', body: 'Original',
      headline: null, description: null, callToAction: null, displayFormat: null, adType: null,
      startedAt: '2026-01-01T00:00:00.000Z', endedAt: null, isActive: true, publisherPlatforms: null,
      impressionsLowerBound: null, impressionsUpperBound: null, spendLowerBound: null, spendUpperBound: null,
      currency: null, media: null, mediaUrls: [], sourceUrl: 'https://example.test/ad',
    }
    const upsert = async (payload: Record<string, unknown>, id = 'payload-ad', ingestionToken = `${id}-token`) => await workerPool.query(
      `SELECT * FROM app_upsert_scheduled_competitor_ad($1,'payload-worker',$2,$3,$4,$5::jsonb,NULL)`,
      [run.id, run.fence_token, id, ingestionToken, JSON.stringify(payload)],
    )
    assert.equal((await upsert(valid)).rowCount, 1)

    const malformed: Array<[string, Record<string, unknown>]> = [
      ['media object', { ...valid, media: {} }],
      ['mediaUrls object', { ...valid, mediaUrls: {} }],
      ['publisherPlatforms object', { ...valid, publisherPlatforms: {} }],
      ['HTTP source URL', { ...valid, sourceUrl: 'http://example.test/ad' }],
      ['credential source URL', { ...valid, sourceUrl: 'https://user@example.test/ad' }],
      ['fragment source URL', { ...valid, sourceUrl: 'https://example.test/ad#secret' }],
      ['malformed IPv4 source URL', { ...valid, sourceUrl: 'https://999.999.999.999/ad' }],
      ['malformed bracketed IPv6 media URL', { ...valid, mediaUrls: ['https://[:::1]/creative.jpg'] }],
      ['malformed IPv4 structured media source URL', { ...valid, media: [{ kind: 'image', sourceUrl: 'https://example.test/creative.jpg', posterUrl: null, cardIndex: null, order: 0 }, { kind: 'video', sourceUrl: 'https://999.999.999.999/creative.mp4', posterUrl: null, cardIndex: null, order: 1 }] }],
      ['malformed bracketed IPv6 structured media poster URL', { ...valid, media: [{ kind: 'video', sourceUrl: 'https://example.test/creative.mp4', posterUrl: 'https://[:::1]/poster.jpg', cardIndex: null, order: 0 }] }],
      ['noncanonical text', { ...valid, advertiserName: ' Advertiser' }],
      ['oversized text', { ...valid, body: 'x'.repeat(20_001) }],
      ['unknown key', { ...valid, body: 'Mutated', tenantSecret: 'leak' }],
      ['missing key', Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'callToAction'))],
      ['negative numeric bound', { ...valid, impressionsLowerBound: -1 }],
      ['reversed numeric bounds', { ...valid, spendLowerBound: 2, spendUpperBound: 1 }],
      ['noncanonical timestamp', { ...valid, startedAt: '2026-01-01' }],
      ['ended before started', { ...valid, endedAt: '2025-12-31T23:59:59.999Z' }],
      ['bad enum', { ...valid, adType: 'animation' }],
      ['bad media shape', { ...valid, media: [{ kind: 'image', sourceUrl: 'https://example.test/x', posterUrl: null, cardIndex: null, order: 1 }] }],
    ]
    for (const [name, payload] of malformed) {
      await assert.rejects(() => upsert(payload, `rejected-${name.replaceAll(' ', '-')}`), (error: unknown) => {
        assert.equal((error as { code?: string }).code, '22023', name)
        assert.equal((error as Error).message, 'invalid scheduled ad payload', name)
        return true
      })
      const stored = await inspectionPool.query(`SELECT body FROM competitor_ads WHERE organization_id='org-payload' AND external_id='guarded'`)
      assert.deepEqual(stored.rows, [{ body: 'Original' }], name)
      assert.equal((await inspectionPool.query(`SELECT id FROM competitor_ads WHERE id LIKE 'rejected-%'`)).rowCount, 0, name)
    }

    const controlIdPayload = { ...valid, externalId: 'control-id', body: 'Must not persist' }
    await assert.rejects(() => upsert(controlIdPayload, 'control\nid'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, '22023')
      assert.equal((error as Error).message, 'invalid scheduled ad parameters')
      return true
    })
    assert.equal((await inspectionPool.query(`SELECT id FROM competitor_ads WHERE external_id='control-id'`)).rowCount, 0)

    for (const [id, externalId] of [[' leading-id', 'leading-id'], ['trailing-id ', 'trailing-id']]) {
      await assert.rejects(() => upsert({ ...valid, externalId, body: 'Must not persist' }, id), (error: unknown) => {
        assert.equal((error as { code?: string }).code, '22023')
        assert.equal((error as Error).message, 'invalid scheduled ad parameters')
        return true
      })
      assert.equal((await inspectionPool.query('SELECT id FROM competitor_ads WHERE external_id=$1', [externalId])).rowCount, 0)
    }

    await assert.rejects(() => upsert({ ...valid, externalId: 'oversized-token', body: 'Must not persist' }, 'oversized-token-id', 't'.repeat(129)), (error: unknown) => {
      assert.equal((error as { code?: string }).code, '22023')
      assert.equal((error as Error).message, 'invalid scheduled ad parameters')
      return true
    })
    assert.equal((await inspectionPool.query(`SELECT id FROM competitor_ads WHERE external_id='oversized-token'`)).rowCount, 0)
  })
})

test('scheduled worker rejects ECMAScript trim and C1 characters before ad or scope mutation', async () => {
  await withRealPostgres(async ({ runtimePool, workerPool, inspectionPool }) => {
    const organizations = new OrganizationService(new PostgresOrganizationRepository(runtimePool), () => 'org-unicode', () => new Date())
    await organizations.create({ name: 'Unicode guards', actorUserId: 'unicode-admin' })
    await withVerifiedUserContext(runtimePool, 'unicode-admin', async (connection) => {
      await connection.query(`INSERT INTO products(id,organization_id,name) VALUES ('product-unicode','org-unicode','Product')`)
      await connection.query(`INSERT INTO competitors(id,organization_id,product_id,name) VALUES ('competitor-unicode','org-unicode','product-unicode','Competitor')`)
      await connection.query(`INSERT INTO competitor_ad_sync_schedules(id,organization_id,product_id,competitor_id,actor_user_id,interval_seconds,next_run_at) VALUES ('schedule-unicode','org-unicode','product-unicode','competitor-unicode','unicode-admin',60,clock_timestamp()-interval '1 second')`)
    })
    const run = (await workerPool.query(`SELECT id,fence_token FROM app_claim_due_ad_sync_runs('unicode-worker',30,3,1)`)).rows[0]!
    await assert.rejects(() => workerPool.query(`SELECT app_is_canonical_stored_text('x',1,false)`), /permission denied/i)
    await assert.rejects(() => workerPool.query(`SELECT app_is_canonical_scheduled_https_url('https://example.test',2048)`), /permission denied/i)
    const valid = {
      platform: 'meta', externalId: 'unicode-guarded', pageId: null, advertiserName: 'Advertiser', body: 'Original',
      headline: null, description: null, callToAction: null, displayFormat: null, adType: null,
      startedAt: '2026-01-01T00:00:00.000Z', endedAt: null, isActive: true, publisherPlatforms: null,
      impressionsLowerBound: null, impressionsUpperBound: null, spendLowerBound: null, spendUpperBound: null,
      currency: null, media: null, mediaUrls: [], sourceUrl: 'https://example.test/ad',
    }
    const upsert = async (payload: Record<string, unknown>, id: string, scope = 'scope-canonical') => await workerPool.query(
      `SELECT * FROM app_upsert_scheduled_competitor_ad($1,'unicode-worker',$2,$3,$4,$5::jsonb,$6)`,
      [run.id, run.fence_token, id, `${id}-token`, JSON.stringify(payload), scope],
    )
    assert.equal((await upsert(valid, 'unicode-ad')).rowCount, 1)

    const rejectedPayloads: Array<[string, Record<string, unknown>, string]> = []
    for (const [characterName, character] of [['NBSP', '\u00a0'], ['BOM', '\ufeff'], ['C1', '\u0085']] as const) {
      rejectedPayloads.push(
        [`${characterName} externalId prefix`, { ...valid, externalId: `${character}external`, body: 'Mutated' }, `rejected-${characterName}-external-prefix`],
        [`${characterName} externalId suffix`, { ...valid, externalId: `external${character}`, body: 'Mutated' }, `rejected-${characterName}-external-suffix`],
        [`${characterName} advertiserName prefix`, { ...valid, advertiserName: `${character}Advertiser`, body: 'Mutated' }, `rejected-${characterName}-name-prefix`],
        [`${characterName} advertiserName suffix`, { ...valid, advertiserName: `Advertiser${character}`, body: 'Mutated' }, `rejected-${characterName}-name-suffix`],
        [`${characterName} sourceUrl path prefix`, { ...valid, sourceUrl: `https://example.test/${character}path`, body: 'Mutated' }, `rejected-${characterName}-url-path-prefix`],
        [`${characterName} sourceUrl path suffix`, { ...valid, sourceUrl: `https://example.test/path${character}`, body: 'Mutated' }, `rejected-${characterName}-url-path-suffix`],
        [`${characterName} sourceUrl query prefix`, { ...valid, sourceUrl: `https://example.test/path?value=${character}x`, body: 'Mutated' }, `rejected-${characterName}-url-query-prefix`],
        [`${characterName} sourceUrl query suffix`, { ...valid, sourceUrl: `https://example.test/path?value=x${character}`, body: 'Mutated' }, `rejected-${characterName}-url-query-suffix`],
        [`${characterName} mediaUrls prefix`, { ...valid, mediaUrls: [`${character}https://example.test/asset`], body: 'Mutated' }, `rejected-${characterName}-media-urls-prefix`],
        [`${characterName} mediaUrls suffix`, { ...valid, mediaUrls: [`https://example.test/asset${character}`], body: 'Mutated' }, `rejected-${characterName}-media-urls-suffix`],
        [`${characterName} media sourceUrl prefix`, { ...valid, media: [{ kind: 'image', sourceUrl: `${character}https://example.test/asset`, posterUrl: null, cardIndex: null, order: 0 }], body: 'Mutated' }, `rejected-${characterName}-media-source-prefix`],
        [`${characterName} media sourceUrl suffix`, { ...valid, media: [{ kind: 'image', sourceUrl: `https://example.test/asset${character}`, posterUrl: null, cardIndex: null, order: 0 }], body: 'Mutated' }, `rejected-${characterName}-media-source-suffix`],
        [`${characterName} media posterUrl prefix`, { ...valid, media: [{ kind: 'video', sourceUrl: 'https://example.test/video', posterUrl: `${character}https://example.test/poster`, cardIndex: null, order: 0 }], body: 'Mutated' }, `rejected-${characterName}-media-poster-prefix`],
        [`${characterName} media posterUrl suffix`, { ...valid, media: [{ kind: 'video', sourceUrl: 'https://example.test/video', posterUrl: `https://example.test/poster${character}`, cardIndex: null, order: 0 }], body: 'Mutated' }, `rejected-${characterName}-media-poster-suffix`],
      )
    }
    for (const [name, payload, id] of rejectedPayloads) {
      await assert.rejects(() => upsert(payload, id), (error: unknown) => {
        assert.equal((error as { code?: string }).code, '22023', name)
        return true
      })
      assert.deepEqual((await inspectionPool.query(`SELECT id,body,snapshot_scope_key,is_active FROM competitor_ads WHERE organization_id='org-unicode'`)).rows,
        [{ id: 'unicode-ad', body: 'Original', snapshot_scope_key: 'scope-canonical', is_active: true }], name)
    }

    for (const [characterName, character] of [['NBSP', '\u00a0'], ['BOM', '\ufeff'], ['C1', '\u0085']] as const) {
      for (const [position, proposedId] of [['prefix', `${character}unicode-id`], ['suffix', `unicode-id${character}`]] as const) {
        await assert.rejects(() => upsert({ ...valid, externalId: `${characterName}-${position}`, body: 'Mutated' }, proposedId), (error: unknown) => {
          assert.equal((error as { code?: string }).code, '22023', `${characterName} proposed_id ${position}`)
          return true
        })
        assert.equal((await inspectionPool.query(`SELECT count(*)::integer AS count FROM competitor_ads WHERE organization_id='org-unicode'`)).rows[0]?.count, 1)
      }
      for (const [position, scope] of [['prefix', `${character}scope-canonical`], ['suffix', `scope-canonical${character}`]] as const) {
        await assert.rejects(() => upsert({ ...valid, body: 'Mutated' }, 'unicode-ad', scope), (error: unknown) => {
          assert.equal((error as { code?: string }).code, '22023', `${characterName} upsert scope ${position}`)
          return true
        })
        await inspectionPool.query(`UPDATE competitor_ads SET snapshot_scope_key=$1,is_active=true,ended_at=NULL WHERE id='unicode-ad'`, [scope])
        await assert.rejects(() => workerPool.query(
          `SELECT app_retire_scheduled_competitor_ads($1,'unicode-worker',$2,$3,$4)`, [run.id, run.fence_token, scope, []],
        ), (error: unknown) => {
          assert.equal((error as { code?: string }).code, '22023', `${characterName} retire scope ${position}`)
          return true
        })
        assert.equal((await inspectionPool.query(`SELECT is_active FROM competitor_ads WHERE id='unicode-ad'`)).rows[0]?.is_active, true)
        await inspectionPool.query(`UPDATE competitor_ads SET snapshot_scope_key='scope-canonical' WHERE id='unicode-ad'`)
      }
    }
  })
})

test('scheduled worker rejects overlong URL hosts before insert or update mutation', async () => {
  await withRealPostgres(async ({ runtimePool, workerPool, inspectionPool }) => {
    const organizations = new OrganizationService(new PostgresOrganizationRepository(runtimePool), () => 'org-hostname', () => new Date())
    await organizations.create({ name: 'Hostname guards', actorUserId: 'hostname-admin' })
    await withVerifiedUserContext(runtimePool, 'hostname-admin', async (connection) => {
      await connection.query(`INSERT INTO products(id,organization_id,name) VALUES ('product-hostname','org-hostname','Product')`)
      await connection.query(`INSERT INTO competitors(id,organization_id,product_id,name) VALUES ('competitor-hostname','org-hostname','product-hostname','Competitor')`)
      await connection.query(`INSERT INTO competitor_ad_sync_schedules(id,organization_id,product_id,competitor_id,actor_user_id,interval_seconds,next_run_at) VALUES ('schedule-hostname','org-hostname','product-hostname','competitor-hostname','hostname-admin',60,clock_timestamp()-interval '1 second')`)
    })
    const run = (await workerPool.query(`SELECT id,fence_token FROM app_claim_due_ad_sync_runs('hostname-worker',30,3,1)`)).rows[0]!
    const valid = {
      platform: 'meta', externalId: 'hostname-guarded', pageId: null, advertiserName: 'Advertiser', body: 'Original',
      headline: null, description: null, callToAction: null, displayFormat: null, adType: null,
      startedAt: '2026-01-01T00:00:00.000Z', endedAt: null, isActive: true, publisherPlatforms: null,
      impressionsLowerBound: null, impressionsUpperBound: null, spendLowerBound: null, spendUpperBound: null,
      currency: null, media: null, mediaUrls: [], sourceUrl: 'https://example.test/ad',
    }
    const upsert = async (payload: Record<string, unknown>, id: string) => await workerPool.query(
      `SELECT * FROM app_upsert_scheduled_competitor_ad($1,'hostname-worker',$2,$3,$4,$5::jsonb,'scope-canonical')`,
      [run.id, run.fence_token, id, `${id}-token`, JSON.stringify(payload)],
    )
    assert.equal((await upsert(valid, 'hostname-ad')).rowCount, 1)
    const overlongHost = `${Array.from({ length: 5 }, () => 'a'.repeat(60)).join('.')}.test`
    assert.ok(Buffer.byteLength(overlongHost) > 253)
    const invalidUrls: Array<[string, Record<string, unknown>]> = [
      ['sourceUrl', { ...valid, sourceUrl: `https://${overlongHost}/ad`, body: 'Mutated' }],
      ['mediaUrls', { ...valid, mediaUrls: [`https://${overlongHost}/asset`], body: 'Mutated' }],
      ['media sourceUrl', { ...valid, media: [{ kind: 'image', sourceUrl: `https://${overlongHost}/asset`, posterUrl: null, cardIndex: null, order: 0 }], body: 'Mutated' }],
      ['media posterUrl', { ...valid, media: [{ kind: 'video', sourceUrl: 'https://example.test/video', posterUrl: `https://${overlongHost}/poster`, cardIndex: null, order: 0 }], body: 'Mutated' }],
    ]
    for (const [name, payload] of invalidUrls) {
      await assert.rejects(() => upsert(payload, `rejected-overlong-${name.replaceAll(' ', '-')}`), (error: unknown) => {
        assert.equal((error as { code?: string }).code, '22023', name)
        return true
      })
      assert.deepEqual((await inspectionPool.query(`SELECT id,body,source_url,media_urls,media FROM competitor_ads WHERE organization_id='org-hostname'`)).rows,
        [{ id: 'hostname-ad', body: 'Original', source_url: 'https://example.test/ad', media_urls: [], media: null }], name)
    }
  })
})

test('scheduled SECURITY DEFINER functions reject NULL parameters before ledger or ad mutation', async () => {
  await withRealPostgres(async ({ runtimePool, workerPool, inspectionPool }) => {
    const organizations = new OrganizationService(new PostgresOrganizationRepository(runtimePool), () => 'org-null', () => new Date())
    await organizations.create({ name: 'Null guards', actorUserId: 'null-admin' })
    await withVerifiedUserContext(runtimePool, 'null-admin', async (connection) => {
      await connection.query(`INSERT INTO products(id,organization_id,name) VALUES ('product-null','org-null','Product')`)
      await connection.query(`INSERT INTO competitors(id,organization_id,product_id,name) VALUES ('competitor-null','org-null','product-null','Competitor')`)
      await connection.query(`INSERT INTO competitor_ad_sync_schedules(id,organization_id,product_id,competitor_id,actor_user_id,interval_seconds,next_run_at) VALUES ('schedule-null','org-null','product-null','competitor-null','null-admin',60,clock_timestamp()-interval '1 second')`)
    })
    const expectInvalid = async (sql: string, parameters: unknown[] = []) => {
      await assert.rejects(() => workerPool.query(sql, parameters), (error: unknown) => {
        assert.equal((error as { code?: string }).code, '22023')
        return true
      })
    }

    for (const parameters of [
      [null, 30, 3, 1], ['null-worker', null, 3, 1], ['null-worker', 30, null, 1], ['null-worker', 30, 3, null],
    ]) await expectInvalid('SELECT * FROM app_claim_due_ad_sync_runs($1,$2,$3,$4)', parameters)
    assert.equal((await inspectionPool.query(`SELECT id FROM competitor_ad_sync_runs`)).rowCount, 0)

    const run = (await workerPool.query(`SELECT id,fence_token FROM app_claim_due_ad_sync_runs('null-worker',30,3,1)`)).rows[0]!
    const successCases = [
      [null, 'null-worker', run.fence_token, 0, 0, 0], [run.id, null, run.fence_token, 0, 0, 0],
      [run.id, 'null-worker', null, 0, 0, 0], [run.id, 'null-worker', run.fence_token, null, 0, 0],
      [run.id, 'null-worker', run.fence_token, 0, null, 0], [run.id, 'null-worker', run.fence_token, 0, 0, null],
    ]
    for (const parameters of successCases) await expectInvalid('SELECT app_finish_ad_sync_run_success($1,$2,$3,$4,$5,$6)', parameters)
    const failureCases = [
      [null, 'null-worker', run.fence_token, 'internal', 1], [run.id, null, run.fence_token, 'internal', 1],
      [run.id, 'null-worker', null, 'internal', 1], [run.id, 'null-worker', run.fence_token, null, 1],
      [run.id, 'null-worker', run.fence_token, 'internal', null],
    ]
    for (const parameters of failureCases) await expectInvalid('SELECT app_finish_ad_sync_run_failure($1,$2,$3,$4,$5)', parameters)

    const validPayload = {
      platform: 'meta', externalId: 'null-guarded', pageId: null, advertiserName: 'Advertiser', body: 'Body',
      headline: null, description: null, callToAction: null, displayFormat: null, adType: null,
      startedAt: '2026-01-01T00:00:00.000Z', endedAt: null, isActive: true, publisherPlatforms: null,
      impressionsLowerBound: null, impressionsUpperBound: null, spendLowerBound: null, spendUpperBound: null,
      currency: null, media: null, mediaUrls: [], sourceUrl: 'https://example.test/ad',
    }
    const upsertBase: unknown[] = [run.id, 'null-worker', run.fence_token, 'null-ad', 'null-token', JSON.stringify(validPayload), null]
    for (const index of [0, 1, 2, 3, 4, 5]) {
      const parameters = [...upsertBase]
      parameters[index] = null
      await expectInvalid('SELECT * FROM app_upsert_scheduled_competitor_ad($1,$2,$3,$4,$5,$6::jsonb,$7)', parameters)
    }
    assert.equal((await inspectionPool.query('SELECT app_validate_scheduled_competitor_ad(NULL) AS valid')).rows[0]?.valid, false)

    const retirementBase: unknown[] = [run.id, 'null-worker', run.fence_token, 'scope', ['meta:null-guarded']]
    for (const index of [0, 1, 2, 3, 4]) {
      const parameters = [...retirementBase]
      parameters[index] = null
      await expectInvalid('SELECT app_retire_scheduled_competitor_ads($1,$2,$3,$4,$5)', parameters)
    }
    await expectInvalid('SELECT app_retire_scheduled_competitor_ads($1,$2,$3,$4,$5)', [run.id, 'null-worker', run.fence_token, 'scope', ['meta:null-guarded', null]])
    assert.deepEqual((await inspectionPool.query(`SELECT status,lease_owner FROM competitor_ad_sync_runs WHERE id=$1`, [run.id])).rows, [{ status: 'running', lease_owner: 'null-worker' }])
    assert.equal((await inspectionPool.query(`SELECT id FROM competitor_ads WHERE organization_id='org-null'`)).rowCount, 0)

    for (const parameters of [[null, 'product-null', 'competitor-null'], ['org-null', null, 'competitor-null'], ['org-null', 'product-null', null]]) {
      await withVerifiedUserContext(runtimePool, 'null-admin', async (connection) => {
        await assert.rejects(() => connection.query('SELECT * FROM app_admin_disable_ad_sync_schedule($1,$2,$3)', parameters), (error: unknown) => {
          assert.equal((error as { code?: string }).code, '22023')
          return true
        })
      })
    }
    assert.equal((await inspectionPool.query(`SELECT enabled FROM competitor_ad_sync_schedules WHERE id='schedule-null'`)).rows[0]?.enabled, true)
  })
})

test('schedule REST API is tenant-admin scoped and disable cancels active work', async () => {
  await withRealPostgres(async ({ runtimePool, workerPool, inspectionPool }) => {
    const organizations = new OrganizationService(new PostgresOrganizationRepository(runtimePool), () => 'org-api', () => new Date())
    await organizations.create({ name: 'API', actorUserId: 'api-admin' })
    await withVerifiedUserContext(runtimePool, 'api-admin', async (connection) => {
      await connection.query(`INSERT INTO organization_members(organization_id,user_id,role) VALUES ('org-api','api-member','member')`)
      await connection.query(`INSERT INTO products(id,organization_id,name) VALUES ('product-api','org-api','Product')`)
      await connection.query(`INSERT INTO competitors(id,organization_id,product_id,name) VALUES ('competitor-api','org-api','product-api','Competitor')`)
      await connection.query(`INSERT INTO competitors(id,organization_id,product_id,name) VALUES ('competitor-api-two','org-api','product-api','Competitor Two')`)
    })
    let ids = 0
    const app = buildApi({ pool: runtimePool, createId: () => `schedule-api-${++ids}`, now: () => new Date(),
      authenticate: async (request) => String(request.headers['x-test-user']), cursorSigningKey: 'test-cursor-signing-key-at-least-32-bytes' })
    const url = '/organizations/org-api/products/product-api/competitors/competitor-api/ad-sync-schedule'
    const admin = { 'x-test-user': 'api-admin' }
    const created = await app.inject({ method: 'POST', url, headers: admin, payload: { intervalSeconds: 60, enabled: true } })
    assert.equal(created.statusCode, 200, created.body)
    assert.equal(created.json().actorUserId, 'api-admin')
    assert.equal((await app.inject({ method: 'POST', url, headers: { 'x-test-user': 'api-member' }, payload: { intervalSeconds: 120, enabled: true } })).statusCode, 403)
    assert.equal((await app.inject({ method: 'GET', url, headers: { 'x-test-user': 'api-member' } })).statusCode, 403)
    assert.equal((await app.inject({ method: 'GET', url, headers: { 'x-test-user': 'outsider' } })).statusCode, 403)
    const intervalOnly = await app.inject({ method: 'PATCH', url, headers: admin, payload: { intervalSeconds: 120 } })
    assert.equal(intervalOnly.statusCode, 200, intervalOnly.body)
    assert.equal(intervalOnly.json().intervalSeconds, 120)
    assert.equal(intervalOnly.json().enabled, true)
    const patchDisabled = await app.inject({ method: 'PATCH', url, headers: admin, payload: { enabled: false } })
    assert.equal(patchDisabled.statusCode, 200, patchDisabled.body)
    assert.equal(patchDisabled.json().intervalSeconds, 120)
    assert.equal(patchDisabled.json().enabled, false)
    assert.equal((await app.inject({ method: 'PATCH', url, headers: admin, payload: {} })).statusCode, 400)
    await workerPool.query(`SELECT * FROM app_claim_due_ad_sync_runs('api-worker',30,3,1)`)
    const reenabled = await app.inject({ method: 'PATCH', url, headers: admin, payload: { enabled: true } })
    assert.equal(reenabled.statusCode, 200, reenabled.body)
    assert.equal(reenabled.json().actorUserId, 'api-admin')
    const disabledWithBody = await app.inject({ method: 'POST', url: `${url}/disable`, headers: admin, payload: {} })
    assert.equal(disabledWithBody.statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url: `${url}/disable`, headers: { ...admin, 'content-type': 'application/xml' }, payload: '<x/>' })).statusCode, 415)
    assert.equal((await app.inject({ method: 'POST', url: `${url}/disable`, headers: admin, payload: { value: 'x'.repeat(1_100_000) } })).statusCode, 413)
    const disabled = await app.inject({ method: 'POST', url: `${url}/disable`, headers: admin })
    assert.equal(disabled.statusCode, 200, disabled.body)
    assert.equal(disabled.json().enabled, false)
    assert.equal((await inspectionPool.query(`SELECT id FROM competitor_ad_sync_runs WHERE status IN ('queued','running','retry_wait')`)).rowCount, 0)
    const missingUrl = '/organizations/org-api/products/product-api/competitors/missing/ad-sync-schedule'
    assert.equal((await app.inject({ method: 'GET', url: missingUrl, headers: admin })).statusCode, 404)
    assert.equal((await app.inject({ method: 'POST', url: `${missingUrl}/disable`, headers: admin })).statusCode, 404)
    const collisionApp = buildApi({ pool: runtimePool, createId: () => created.json().id, now: () => new Date(),
      authenticate: async (request) => String(request.headers['x-test-user']), cursorSigningKey: 'test-cursor-signing-key-at-least-32-bytes' })
    const collisionUrl = '/organizations/org-api/products/product-api/competitors/competitor-api-two/ad-sync-schedule'
    assert.equal((await collisionApp.inject({ method: 'POST', url: collisionUrl, headers: admin, payload: { intervalSeconds: 60, enabled: true } })).statusCode, 409)
    await collisionApp.close()
    await app.close()
  })
})
