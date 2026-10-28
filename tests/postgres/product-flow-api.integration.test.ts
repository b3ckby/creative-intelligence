import assert from 'node:assert/strict'
import test from 'node:test'

import { buildApi } from '../../src/http/build-api.ts'
import { withRealPostgres } from './helpers/real-postgres.ts'

test('real PostgreSQL preserves concurrent disjoint PATCH fields and archive-then-restore ordering', async () => {
  await withRealPostgres(async ({ runtimePool, inspectionPool }) => {
    let reads = 0
    let gatePatchReads = true
    let releaseReads!: () => void
    const bothReadsStarted = new Promise<void>((resolve) => { releaseReads = resolve })
    const controlledPool = {
      query: runtimePool.query.bind(runtimePool),
      connect: async () => {
        const client = await runtimePool.connect()
        return {
          query: async (sql: string, values?: unknown[]) => {
            if (gatePatchReads && /^SELECT \* FROM products WHERE/.test(sql)) {
              reads += 1
              if (reads === 2) releaseReads()
              await bothReadsStarted
            }
            return client.query(sql, values)
          },
          release: (error?: Error) => client.release(error),
        }
      },
    }
    const ids = ['org-concurrent', 'product-concurrent']
    const app = buildApi({
      pool: controlledPool,
      cursorSigningKey: 'test-cursor-signing-key-at-least-32-bytes',
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => new Date('2026-10-28T00:00:00.000Z'),
      authenticate: async () => 'admin-concurrent',
    })
    const headers = { 'x-user-id': 'admin-concurrent' }
    const payload = { name: 'Original', markets: [], platforms: ['web'], targetAudiences: [], uniqueSellingPoints: [] }
    assert.equal((await app.inject({ method: 'POST', url: '/organizations', headers, payload: { name: 'Concurrent' } })).statusCode, 201)
    assert.equal((await app.inject({ method: 'POST', url: '/organizations/org-concurrent/products', headers, payload })).statusCode, 201)

    const [renamed, retargeted] = await Promise.all([
      app.inject({ method: 'PATCH', url: '/organizations/org-concurrent/products/product-concurrent', headers, payload: { name: 'Renamed' } }),
      app.inject({ method: 'PATCH', url: '/organizations/org-concurrent/products/product-concurrent', headers, payload: { markets: ['Washington, D.C.'] } }),
    ])
    gatePatchReads = false
    assert.equal(renamed.statusCode, 200)
    assert.equal(retargeted.statusCode, 200)
    const patched = await inspectionPool.query(`SELECT name, markets FROM products WHERE id = 'product-concurrent'`)
    assert.deepEqual(patched.rows, [{ name: 'Renamed', markets: ['Washington, D.C.'] }])

    const archived = await app.inject({ method: 'POST', url: '/organizations/org-concurrent/products/product-concurrent/archive', headers })
    const restored = await app.inject({ method: 'POST', url: '/organizations/org-concurrent/products/product-concurrent/restore', headers })
    assert.equal(archived.json().archivedAt, '2026-10-28T00:00:00.000Z')
    assert.equal(restored.json().archivedAt, null)
    const lifecycle = await inspectionPool.query(`SELECT archived_at FROM products WHERE id = 'product-concurrent'`)
    assert.equal(lifecycle.rows[0].archived_at, null)
    await app.close()
  })
})

test('real PostgreSQL product lifecycle mutations remain tenant-scoped and preserve child archive state', async () => {
  await withRealPostgres(async ({ runtimePool, inspectionPool }) => {
    const ids = ['org-life-a', 'product-life-a', 'competitor-life-a', 'org-life-b']
    const app = buildApi({
      pool: runtimePool,
      cursorSigningKey: 'test-cursor-signing-key-at-least-32-bytes',
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => new Date('2026-10-28T00:00:00.000Z'),
      authenticate: async (request) => {
        const value = request.headers['x-user-id']
        if (typeof value !== 'string') throw new Error('missing identity')
        return value
      },
    })
    const adminA = { 'x-user-id': 'admin-life-a' }
    const adminB = { 'x-user-id': 'admin-life-b' }
    const payload = { name: 'Product', markets: [], platforms: ['web'], targetAudiences: [], uniqueSellingPoints: [] }
    await app.inject({ method: 'POST', url: '/organizations', headers: adminA, payload: { name: 'A' } })
    await app.inject({ method: 'POST', url: '/organizations/org-life-a/products', headers: adminA, payload })
    await app.inject({ method: 'POST', url: '/organizations/org-life-a/products/product-life-a/competitors', headers: adminA, payload: { name: 'Child' } })
    await app.inject({ method: 'POST', url: '/organizations', headers: adminB, payload: { name: 'B' } })

    const denied = await app.inject({ method: 'POST', url: '/organizations/org-life-a/products/product-life-a/archive', headers: adminB })
    assert.equal(denied.statusCode, 403)
    const archived = await app.inject({ method: 'POST', url: '/organizations/org-life-a/products/product-life-a/archive', headers: adminA })
    assert.equal(archived.statusCode, 200)
    await inspectionPool.query(`UPDATE competitors SET archived_at = '2026-10-29T00:00:00Z' WHERE id = 'competitor-life-a'`)
    const restored = await app.inject({ method: 'POST', url: '/organizations/org-life-a/products/product-life-a/restore', headers: adminA })
    assert.equal(restored.statusCode, 200)
    const child = await inspectionPool.query(`SELECT archived_at FROM competitors WHERE id = 'competitor-life-a'`)
    assert.equal(child.rows[0].archived_at.toISOString(), '2026-10-29T00:00:00.000Z')
    await app.close()
  })
})

test('real PostgreSQL product-flow API preserves tenant denial and pagination/filter semantics', async () => {
  await withRealPostgres(async ({ runtimePool }) => {
    const ids = ['org-api-a', 'product-api-a', 'competitor-api-a', 'ad-api-b', 'ad-api-a', 'brief-api-a', 'org-api-b']
    const app = buildApi({
      pool: runtimePool,
      cursorSigningKey: 'test-cursor-signing-key-at-least-32-bytes',
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => new Date('2026-10-26T00:00:00.000Z'),
      authenticate: async (request) => {
        const value = request.headers['x-user-id']
        if (typeof value !== 'string') throw new Error('missing identity')
        return value
      },
    })
    const adminA = { 'x-user-id': 'admin-api-a' }
    const adminB = { 'x-user-id': 'admin-api-b' }
    const productPayload = { name: 'Product', markets: [], platforms: ['web'], targetAudiences: [], uniqueSellingPoints: [] }
    assert.equal((await app.inject({ method: 'POST', url: '/organizations', headers: adminA, payload: { name: 'A' } })).statusCode, 201)
    assert.equal((await app.inject({ method: 'POST', url: '/organizations/org-api-a/products', headers: adminA, payload: productPayload })).statusCode, 201)
    assert.equal((await app.inject({
      method: 'POST', url: '/organizations/org-api-a/products/product-api-a/competitors', headers: adminA, payload: { name: 'Competitor' },
    })).statusCode, 201)
    const ad = (externalId: string, isActive: boolean) => ({ records: [{
      externalId, advertiserName: 'Advertiser', body: externalId, startedAt: '2026-10-01T00:00:00.000Z',
      isActive, mediaUrls: [], sourceUrl: `https://example.test/${externalId}`,
    }] })
    for (const [externalId, isActive] of [['external-b', true], ['external-a', false]] as const) {
      assert.equal((await app.inject({
        method: 'POST',
        url: '/organizations/org-api-a/products/product-api-a/competitors/competitor-api-a/ads/manual-meta',
        headers: adminA,
        payload: ad(externalId, isActive),
      })).statusCode, 200)
    }
    assert.equal((await app.inject({
      method: 'POST', url: '/organizations/org-api-a/products/product-api-a/briefs', headers: adminA,
      payload: { title: 'Brief', hook: 'Hook', dimensions: { audience: 'a', market: 'm', angle: 'x', format: 'f' } },
    })).statusCode, 201)
    assert.equal((await app.inject({ method: 'POST', url: '/organizations', headers: adminB, payload: { name: 'B' } })).statusCode, 201)

    const first = await app.inject({
      method: 'GET',
      url: '/organizations/org-api-a/ads?limit=1&productId=product-api-a&provider=manual-meta',
      headers: adminA,
    })
    assert.equal(first.statusCode, 200)
    assert.equal(first.json().items[0].id, 'ad-api-a')
    assert.equal(typeof first.json().nextCursor, 'string')
    const second = await app.inject({
      method: 'GET',
      url: `/organizations/org-api-a/ads?limit=1&productId=product-api-a&provider=manual-meta&cursor=${first.json().nextCursor}`,
      headers: adminA,
    })
    assert.deepEqual(second.json().items.map((item: { id: string }) => item.id), ['ad-api-b'])
    assert.equal(second.json().nextCursor, null)
    const inactive = await app.inject({ method: 'GET', url: '/organizations/org-api-a/ads?isActive=false', headers: adminA })
    assert.deepEqual(inactive.json().items.map((item: { id: string }) => item.id), ['ad-api-a'])

    const foreignList = await app.inject({ method: 'GET', url: '/organizations/org-api-a/products', headers: adminB })
    assert.equal(foreignList.statusCode, 403)
    assert.deepEqual(foreignList.json(), { error: 'Access denied' })
    const foreignBrief = await app.inject({ method: 'GET', url: '/organizations/org-api-a/briefs/brief-api-a', headers: adminB })
    assert.equal(foreignBrief.statusCode, 404)
    assert.deepEqual(foreignBrief.json(), { error: 'Not found' })

    await app.close()
  })
})
