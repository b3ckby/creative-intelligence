import assert from 'node:assert/strict'
import test from 'node:test'

import type { AdSourceProvider, CollectedAd } from '../../src/ad-ingestion/ad-source-provider.ts'
import type { ManualMetaAdRecord } from '../../src/ad-ingestion/manual-meta-ads-provider.ts'
import { OrganizationService } from '../../src/organizations/organization-service.ts'
import { PostgresManualAdImportService } from '../../src/persistence/postgres-manual-ad-import-service.ts'
import { PostgresProviderAdImportService } from '../../src/persistence/postgres-provider-ad-import-service.ts'
import { PostgresOrganizationRepository } from '../../src/persistence/postgres-organization-repository.ts'
import { withVerifiedUserContext } from '../../src/persistence/verified-user-context.ts'
import { withRealPostgres } from './helpers/real-postgres.ts'

function record(externalId: string): ManualMetaAdRecord {
  return {
    externalId,
    advertiserName: 'Snapshot competitor',
    body: 'Snapshot copy',
    startedAt: '2026-10-01T00:00:00.000Z',
    isActive: true,
    mediaUrls: [],
    sourceUrl: `https://example.test/${externalId}`,
  }
}

test('successful manual ingestion transactionally captures one daily product snapshot per competitor', async () => {
  await withRealPostgres(async ({ runtimePool, inspectionPool }) => {
    const organizations = new OrganizationService(new PostgresOrganizationRepository(runtimePool), () => 'org-snapshot', () => new Date())
    await organizations.create({ name: 'Snapshots', actorUserId: 'snapshot-admin' })
    await withVerifiedUserContext(runtimePool, 'snapshot-admin', async (connection) => {
      await connection.query(`INSERT INTO products(id,organization_id,name) VALUES ('product-snapshot','org-snapshot','Product')`)
      await connection.query(`INSERT INTO competitors(id,organization_id,product_id,name) VALUES
        ('competitor-snapshot','org-snapshot','product-snapshot','Imported'),
        ('competitor-peer','org-snapshot','product-snapshot','Peer')`)
    })

    const imports = new PostgresManualAdImportService(runtimePool, () => 'ad-snapshot', () => new Date('2001-01-01T00:00:00.000Z'))
    assert.deepEqual(await imports.import('snapshot-admin', {
      organizationId: 'org-snapshot', productId: 'product-snapshot', competitorId: 'competitor-snapshot',
    }, [record('external-snapshot')]), { inserted: 1, duplicates: 0 })

    const snapshots = await inspectionPool.query<{
      competitor_id: string; active_ad_count: number; snapshot_is_utc_day: boolean; uses_database_clock: boolean
    }>(`SELECT competitor_id,active_ad_count,
          snapshot_date=(captured_at AT TIME ZONE 'UTC')::date AS snapshot_is_utc_day,
          captured_at>='2020-01-01'::timestamptz AS uses_database_clock
        FROM competitor_analytics_snapshots WHERE organization_id='org-snapshot' ORDER BY competitor_id`)
    assert.deepEqual(snapshots.rows, [
      { competitor_id: 'competitor-peer', active_ad_count: 0, snapshot_is_utc_day: true, uses_database_clock: true },
      { competitor_id: 'competitor-snapshot', active_ad_count: 1, snapshot_is_utc_day: true, uses_database_clock: true },
    ])

    assert.deepEqual(await imports.import('snapshot-admin', {
      organizationId: 'org-snapshot', productId: 'product-snapshot', competitorId: 'competitor-snapshot',
    }, [record('external-snapshot')]), { inserted: 0, duplicates: 1 })
    assert.equal((await inspectionPool.query(`SELECT 1 FROM competitor_analytics_snapshots WHERE organization_id='org-snapshot'`)).rowCount, 2)
    const outsiderRows = await withVerifiedUserContext(runtimePool, 'snapshot-outsider', async (connection) =>
      await connection.query(`SELECT 1 FROM competitor_analytics_snapshots WHERE organization_id='org-snapshot'`))
    assert.equal(outsiderRows.rowCount, 0)

    await inspectionPool.query(`CREATE FUNCTION fail_snapshot_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'snapshot write failed'; END $$`)
    await inspectionPool.query(`CREATE TRIGGER fail_snapshot_write BEFORE INSERT OR UPDATE ON competitor_analytics_snapshots FOR EACH ROW EXECUTE FUNCTION fail_snapshot_write()`)
    const failing = new PostgresManualAdImportService(runtimePool, () => 'ad-rolled-back', () => new Date())
    await assert.rejects(() => failing.import('snapshot-admin', {
      organizationId: 'org-snapshot', productId: 'product-snapshot', competitorId: 'competitor-snapshot',
    }, [record('external-rolled-back')]), /snapshot write failed/i)
    assert.equal((await inspectionPool.query(`SELECT 1 FROM competitor_ads WHERE id='ad-rolled-back'`)).rowCount, 0)
    assert.equal((await inspectionPool.query(`SELECT 1 FROM competitor_analytics_snapshots WHERE organization_id='org-snapshot'`)).rowCount, 2)
  })
})

function collected(externalId: string): CollectedAd {
  return {
    platform: 'meta', externalId, advertiserName: 'Completeness competitor', body: externalId, callToAction: null,
    startedAt: '2026-10-01T00:00:00.000Z', isActive: true, mediaUrls: [], sourceUrl: `https://example.test/${externalId}`,
  }
}

test('partial snapshots preserve missing ads while complete snapshots retire them before analytics capture', async () => {
  await withRealPostgres(async ({ runtimePool, inspectionPool }) => {
    const organizations = new OrganizationService(new PostgresOrganizationRepository(runtimePool), () => 'org-complete', () => new Date())
    await organizations.create({ name: 'Completeness', actorUserId: 'complete-admin' })
    await withVerifiedUserContext(runtimePool, 'complete-admin', async (connection) => {
      await connection.query(`INSERT INTO products(id,organization_id,name) VALUES ('product-complete','org-complete','Product')`)
      await connection.query(`INSERT INTO competitors(id,organization_id,product_id,name) VALUES ('competitor-complete','org-complete','product-complete','Competitor')`)
    })
    const ids = ['ad-old', 'ad-new', 'unused-reimport']
    const imports = new PostgresProviderAdImportService(runtimePool, () => ids.shift() ?? 'unexpected', () => new Date())
    const context = { organizationId: 'org-complete', productId: 'product-complete', competitorId: 'competitor-complete' }
    const scopeKey = 'apify-meta-ads:v1:country=ALL;active=all'
    const provider = (items: CollectedAd[], completeness: 'complete' | 'partial'): AdSourceProvider => ({
      collect: async () => items,
      collectSnapshot: async () => ({ items, completeness, scopeKey }),
    })

    await imports.importWithDetails('complete-admin', 'apify-meta-ads', context, provider([collected('old')], 'complete'))
    await imports.importWithDetails('complete-admin', 'apify-meta-ads', context, provider([collected('new')], 'partial'))
    assert.deepEqual((await inspectionPool.query(`SELECT external_id,is_active FROM competitor_ads WHERE organization_id='org-complete' ORDER BY external_id`)).rows,
      [{ external_id: 'new', is_active: true }, { external_id: 'old', is_active: true }])
    assert.equal((await inspectionPool.query(`SELECT active_ad_count FROM competitor_analytics_snapshots WHERE organization_id='org-complete'`)).rows[0]?.active_ad_count, 2)

    const result = await imports.importWithDetails('complete-admin', 'apify-meta-ads', context, provider([collected('new')], 'complete'))
    assert.deepEqual(result, { inserted: 0, duplicates: 1, retired: 1, complete: true })
    assert.deepEqual((await inspectionPool.query(`SELECT external_id,is_active FROM competitor_ads WHERE organization_id='org-complete' ORDER BY external_id`)).rows,
      [{ external_id: 'new', is_active: true }, { external_id: 'old', is_active: false }])
    assert.deepEqual((await inspectionPool.query(`SELECT active_ad_count FROM competitor_analytics_snapshots WHERE organization_id='org-complete'`)).rows,
      [{ active_ad_count: 1 }])
  })
})

test('concurrent imports for different competitors serialize product-relative snapshots before ad mutation', async () => {
  await withRealPostgres(async ({ runtimePool, inspectionPool }) => {
    const organizations = new OrganizationService(new PostgresOrganizationRepository(runtimePool), () => 'org-concurrent-snapshot', () => new Date())
    await organizations.create({ name: 'Concurrent snapshots', actorUserId: 'concurrent-admin' })
    await withVerifiedUserContext(runtimePool, 'concurrent-admin', async (connection) => {
      await connection.query(`INSERT INTO products(id,organization_id,name) VALUES ('product-concurrent-snapshot','org-concurrent-snapshot','Product')`)
      await connection.query(`INSERT INTO competitors(id,organization_id,product_id,name) VALUES
        ('competitor-concurrent-a','org-concurrent-snapshot','product-concurrent-snapshot','A'),
        ('competitor-concurrent-b','org-concurrent-snapshot','product-concurrent-snapshot','B')`)
    })
    await inspectionPool.query(`
      CREATE FUNCTION coordinate_concurrent_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM competitor_ads WHERE external_id='concurrent-a-1') THEN
          PERFORM pg_advisory_xact_lock(810001);
        ELSE
          PERFORM pg_advisory_xact_lock(810002);
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER coordinate_concurrent_snapshot BEFORE INSERT OR UPDATE ON competitor_analytics_snapshots
        FOR EACH ROW EXECUTE FUNCTION coordinate_concurrent_snapshot();
    `)

    const coordinator = await inspectionPool.connect()
    await coordinator.query(`SELECT pg_advisory_lock(810001),pg_advisory_lock(810002)`)
    const aItems = [
      { ...collected('concurrent-a-1'), startedAt: '2020-01-01T00:00:00.000Z', impressionsLowerBound: 100, impressionsUpperBound: 100 },
      { ...collected('concurrent-a-2'), startedAt: '2020-01-01T00:00:00.000Z', impressionsLowerBound: 200, impressionsUpperBound: 200 },
    ]
    const bItems = [{ ...collected('concurrent-b-1'), startedAt: new Date().toISOString(), impressionsLowerBound: 10, impressionsUpperBound: 10 }]
    let nextA = 0
    let nextB = 0
    const importsA = new PostgresProviderAdImportService(runtimePool, () => `concurrent-a-id-${++nextA}`, () => new Date())
    const importsB = new PostgresProviderAdImportService(runtimePool, () => `concurrent-b-id-${++nextB}`, () => new Date())
    const importA = importsA.import('concurrent-admin', 'manual-meta', {
      organizationId: 'org-concurrent-snapshot', productId: 'product-concurrent-snapshot', competitorId: 'competitor-concurrent-a',
    }, { collect: async () => aItems })
    const importB = importsB.import('concurrent-admin', 'manual-meta', {
      organizationId: 'org-concurrent-snapshot', productId: 'product-concurrent-snapshot', competitorId: 'competitor-concurrent-b',
    }, { collect: async () => bItems })

    let advisoryWaiters = 0
    for (let attempt = 0; attempt < 20 && advisoryWaiters < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      advisoryWaiters = Number((await runtimePool.query(`SELECT count(*)::integer AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted`)).rows[0]?.count ?? 0)
    }
    assert.ok(advisoryWaiters >= 1, 'at least one import reached snapshot capture')
    const adMutators = Number((await runtimePool.query(`
      SELECT count(DISTINCT l.pid)::integer AS count
      FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
      WHERE c.relname='competitor_ads' AND l.mode='RowExclusiveLock' AND l.granted
    `)).rows[0]?.count ?? 0)
    await coordinator.query(`SELECT pg_advisory_unlock(810001),pg_advisory_unlock(810002)`)
    coordinator.release()
    assert.equal(adMutators, 1, 'the second product import must wait before mutating ads')
    await Promise.all([importA, importB])

    assert.deepEqual((await inspectionPool.query(`
      SELECT competitor_id,active_ad_count,scale_score
      FROM competitor_analytics_snapshots
      WHERE organization_id='org-concurrent-snapshot'
      ORDER BY competitor_id
    `)).rows, [
      { competitor_id: 'competitor-concurrent-a', active_ad_count: 2, scale_score: 70 },
      { competitor_id: 'competitor-concurrent-b', active_ad_count: 1, scale_score: 0 },
    ])
  })
})

test('scheduled worker cannot use tenant identity to invoke unfenced analytics capture', async () => {
  await withRealPostgres(async ({ runtimePool, workerPool, inspectionPool }) => {
    const organizations = new OrganizationService(new PostgresOrganizationRepository(runtimePool), () => 'org-capture-privilege', () => new Date())
    await organizations.create({ name: 'Capture privilege', actorUserId: 'capture-admin' })
    await withVerifiedUserContext(runtimePool, 'capture-admin', async (connection) => {
      await connection.query(`INSERT INTO products(id,organization_id,name) VALUES ('product-capture-privilege','org-capture-privilege','Product')`)
      await connection.query(`INSERT INTO competitors(id,organization_id,product_id,name) VALUES ('competitor-capture-privilege','org-capture-privilege','product-capture-privilege','Competitor')`)
      await connection.query(`INSERT INTO competitor_ad_sync_schedules(id,organization_id,product_id,competitor_id,actor_user_id,interval_seconds,next_run_at)
        VALUES ('schedule-capture-privilege','org-capture-privilege','product-capture-privilege','competitor-capture-privilege','capture-admin',60,clock_timestamp()-interval '1 second')`)
    })
    const run = (await workerPool.query(`SELECT id FROM app_claim_due_ad_sync_runs('capture-worker',30,3,1)`)).rows[0]!
    await workerPool.query(`SELECT set_config('app.user_id','capture-admin',false)`)

    const assertUnfencedDenied = async (): Promise<void> => {
      await assert.rejects(
        () => workerPool.query(`SELECT app_capture_ingestion_analytics_snapshot(
          'org-capture-privilege','product-capture-privilege','competitor-capture-privilege')`),
        /permission denied/i,
      )
      assert.equal((await inspectionPool.query(`SELECT 1 FROM competitor_analytics_snapshots WHERE organization_id='org-capture-privilege'`)).rowCount, 0)
    }

    await inspectionPool.query(`UPDATE competitor_ad_sync_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [run.id])
    await assertUnfencedDenied()
    await inspectionPool.query(`UPDATE competitor_ad_sync_schedules SET enabled=false WHERE id='schedule-capture-privilege'`)
    await assertUnfencedDenied()
  })
})
