import assert from 'node:assert/strict'
import test from 'node:test'

import { OrganizationService } from '../../src/organizations/organization-service.ts'
import { PostgresBriefRepository } from '../../src/persistence/postgres-brief-repository.ts'
import { PostgresIterationMapRepository } from '../../src/persistence/postgres-iteration-map-repository.ts'
import { PostgresOrganizationRepository } from '../../src/persistence/postgres-organization-repository.ts'
import type { SqlConnection, SqlPool } from '../../src/persistence/postgres-organization-repository.ts'
import { withVerifiedUserContext } from '../../src/persistence/verified-user-context.ts'
import { withRealPostgres } from './helpers/real-postgres.ts'

const dimensions = { audience: ' students ', market: ' US ', angle: ' focus ', format: ' video ' }
const now = () => new Date('2026-10-26T12:00:00.000Z')

test('real PostgreSQL persists tenant-safe briefs and analyzes iteration maps', async () => {
  await withRealPostgres(async ({ runtimePool, inspectionPool }) => {
    const organizationIds = ['org-brief-one', 'org-brief-two']
    const organizations = new OrganizationService(
      new PostgresOrganizationRepository(runtimePool),
      () => organizationIds.shift() ?? 'unexpected-org',
      now,
    )
    await organizations.create({ name: 'One', actorUserId: 'admin-one' })
    await organizations.create({ name: 'Two', actorUserId: 'admin-two' })

    await withVerifiedUserContext(runtimePool, 'admin-one', async (client) => {
      await client.query(`INSERT INTO products (id, organization_id, name) VALUES ('product-one', 'org-brief-one', 'One')`)
      await client.query(`INSERT INTO competitors (id, organization_id, product_id, name)
                          VALUES ('competitor-one', 'org-brief-one', 'product-one', 'One')`)
      await client.query(`INSERT INTO competitor_ads (
        id, ingestion_token, organization_id, product_id, competitor_id, provider_name,
        platform, external_id, advertiser_name, body, call_to_action, started_at,
        is_active, source_url, first_seen_at, last_seen_at
      ) VALUES (
        'ad-one', 'token-one', 'org-brief-one', 'product-one', 'competitor-one', 'manual-meta',
        'meta', 'external-one', 'Advertiser', 'Winning hook', 'Install', '2026-10-01',
        true, 'https://example.test/ad-one', '2026-10-01', '2026-10-01'
      )`)
    })
    await withVerifiedUserContext(runtimePool, 'admin-two', async (client) => {
      await client.query(`INSERT INTO products (id, organization_id, name) VALUES ('product-two', 'org-brief-two', 'Two')`)
      await client.query(`INSERT INTO competitors (id, organization_id, product_id, name)
                          VALUES ('competitor-two', 'org-brief-two', 'product-two', 'Two')`)
      await client.query(`INSERT INTO competitor_ads (
        id, ingestion_token, organization_id, product_id, competitor_id, provider_name,
        platform, external_id, advertiser_name, body, started_at, is_active,
        source_url, first_seen_at, last_seen_at
      ) VALUES (
        'ad-two', 'token-two', 'org-brief-two', 'product-two', 'competitor-two', 'manual-meta',
        'meta', 'external-two', 'Private', 'Private hook', '2026-10-01', true,
        'https://example.test/ad-two', '2026-10-01', '2026-10-01'
      )`)
    })

    const ids = ['brief-manual', 'brief-ad', 'brief-archived', 'brief-manual']
    const briefs = new PostgresBriefRepository(runtimePool, now, () => ids.shift() ?? 'unexpected-brief')
    const manual = await briefs.createManual('admin-one', {
      organizationId: 'org-brief-one', productId: 'product-one', title: ' Manual ',
      hook: ' Hook ', callToAction: ' Install ', dimensions,
    })
    const fromAd = await briefs.createFromAd('admin-one', {
      organizationId: 'org-brief-one', productId: 'product-one', adId: 'ad-one',
      title: ' From ad ', dimensions: { ...dimensions, audience: 'professionals' },
    })
    const archived = await briefs.createManual('admin-one', {
      organizationId: 'org-brief-one', productId: 'product-one', title: ' Archived ', hook: '',
      dimensions: { ...dimensions, audience: 'archived-audience' },
    })
    await briefs.update('admin-one', 'org-brief-one', archived.id, {
      expectedVersion: 1, title: archived.title, status: 'archived', hook: archived.hook,
      callToAction: archived.callToAction, dimensions: archived.dimensions,
    })

    const updatedManual = await briefs.update('admin-one', 'org-brief-one', manual.id, {
      expectedVersion: 1, title: 'Ready manual', status: 'triage', hook: 'Revised hook',
      callToAction: null, dimensions: manual.dimensions,
    })
    assert.equal(updatedManual.version, 2)
    assert.equal(updatedManual.status, 'triage')
    const versions = await briefs.listVersions('admin-one', 'org-brief-one', manual.id, 100)
    assert.deepEqual(versions.map(({ version }) => version), [2, 1])
    assert.ok(versions.every(({ changedBy }) => changedBy === 'admin-one'))
    await assert.rejects(briefs.update('admin-one', 'org-brief-one', manual.id, {
      expectedVersion: 1, title: 'Stale', status: 'draft', hook: '', callToAction: null, dimensions: manual.dimensions,
    }), /stale/i)
    await assert.rejects(briefs.listVersions('admin-two', 'org-brief-one', manual.id, 100), /not found/i)

    assert.deepEqual(manual.dimensions, { audience: 'students', market: 'US', angle: 'focus', format: 'video' })
    assert.equal(fromAd.hook, 'Winning hook')
    assert.equal(fromAd.callToAction, 'Install')
    assert.deepEqual((await briefs.pageForProduct('admin-one', 'org-brief-one', 'product-one', { limit: 100, includeArchived: true })).map(({ id }) => id),
      ['brief-ad', 'brief-archived', 'brief-manual'])
    await assert.rejects(briefs.pageForProduct('admin-two', 'org-brief-one', 'product-one', { limit: 100, includeArchived: true }), /product does not belong/i)
    assert.equal(await briefs.findById('admin-two', 'org-brief-one', manual.id), undefined)

    await assert.rejects(briefs.createManual('admin-one', {
      organizationId: 'org-brief-one', productId: 'product-two', title: 'Foreign product', hook: '', dimensions,
    }), /product does not belong/i)
    await assert.rejects(briefs.createFromAd('admin-one', {
      organizationId: 'org-brief-one', productId: 'product-one', adId: 'ad-two', title: 'Foreign ad', dimensions,
    }), /ad does not belong/i)
    await assert.rejects(briefs.createManual('admin-two', {
      organizationId: 'org-brief-one', productId: 'product-one', title: 'Cross tenant', hook: '', dimensions,
    }), /product does not belong/i)

    await assert.rejects(briefs.createManual('admin-two', {
      organizationId: 'org-brief-two', productId: 'product-two', title: 'Collision', hook: '', dimensions,
    }), /collision/i)
    const collisionRows = await inspectionPool.query<{ id: string; organization_id: string; title: string }>(
      `SELECT id, organization_id, title FROM creative_briefs WHERE id = 'brief-manual'`,
    )
    assert.deepEqual(collisionRows.rows, [{ id: 'brief-manual', organization_id: 'org-brief-one', title: 'Ready manual' }])

    const maps = new PostgresIterationMapRepository(runtimePool)
    const map = await maps.analyze('admin-one', {
      organizationId: 'org-brief-one', productId: 'product-one',
      axes: {
        audience: ['students', 'professionals', 'archived-audience', 'missing'],
        market: ['US'], angle: ['focus'], format: ['video'],
      },
    })
    assert.equal(map.totalCombinations, 4)
    assert.deepEqual(map.covered.map(({ briefIds }) => briefIds), [['brief-manual'], ['brief-ad']])
    assert.deepEqual(map.missing.map(({ dimensions: cell }) => cell.audience), ['archived-audience', 'missing'])
    await assert.rejects(maps.analyze('admin-two', {
      organizationId: 'org-brief-one', productId: 'product-one',
      axes: { audience: ['a'], market: ['m'], angle: ['x'], format: ['f'] },
    }), /product does not belong/i)

    const ten = Array.from({ length: 10 }, (_, index) => `value-${index}`)
    const atCap = await maps.analyze('admin-one', {
      organizationId: 'org-brief-one', productId: 'product-one',
      axes: { audience: ten, market: ten, angle: ten, format: ten },
    })
    assert.equal(atCap.totalCombinations, 10_000)
    await assert.rejects(maps.analyze('admin-one', {
      organizationId: 'org-brief-one', productId: 'product-one',
      axes: { audience: [...ten, 'value-10'], market: ten, angle: ten, format: ten },
    }), /maximum is 10000/i)
  })
})

test('real PostgreSQL brief reads remain authorized while membership removal races', async () => {
  await withRealPostgres(async ({ runtimePool }) => {
    const organizations = new OrganizationService(
      new PostgresOrganizationRepository(runtimePool),
      () => 'org-read-race',
      now,
    )
    await organizations.create({ name: 'Read race', actorUserId: 'admin-read-race' })
    await organizations.addMember({
      organizationId: 'org-read-race', actorUserId: 'admin-read-race', userId: 'reader', role: 'member',
    })
    await withVerifiedUserContext(runtimePool, 'admin-read-race', async (client) => {
      await client.query(`INSERT INTO products (id, organization_id, name) VALUES ('product-read-race', 'org-read-race', 'Product')`)
    })
    const writer = new PostgresBriefRepository(runtimePool, now, () => 'brief-read-race')
    await writer.createManual('admin-read-race', {
      organizationId: 'org-read-race', productId: 'product-read-race', title: 'Brief', hook: '', dimensions,
    })

    const reachedBriefQuery = deferred<void>()
    const continueBriefQuery = deferred<void>()
    const pausedPool: SqlPool = {
      async connect() {
        const connection = await runtimePool.connect()
        return {
          async query(text: string, values?: unknown[]) {
            if (text.includes('FROM creative_briefs')) {
              reachedBriefQuery.resolve()
              await continueBriefQuery.promise
            }
            return connection.query(text, values)
          },
          release() { connection.release() },
        } as SqlConnection
      },
      async query(text: string, values?: unknown[]) { return runtimePool.query(text, values) },
    }
    const reader = new PostgresBriefRepository(pausedPool, now, () => 'unused')
    const read = reader.pageForProduct('reader', 'org-read-race', 'product-read-race', { limit: 100, includeArchived: true })
    await reachedBriefQuery.promise

    let removalFinished = false
    const removal = organizations.removeMember({
      organizationId: 'org-read-race', actorUserId: 'admin-read-race', userId: 'reader',
    }).then(() => { removalFinished = true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(removalFinished, true, 'membership removal may commit after the repeatable-read snapshot is established')
    continueBriefQuery.resolve()
    assert.deepEqual((await read).map(({ id }) => id), ['brief-read-race'])
    await removal
    await assert.rejects(writer.pageForProduct('reader', 'org-read-race', 'product-read-race', { limit: 100, includeArchived: true }), /product does not belong/i)
  })
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

