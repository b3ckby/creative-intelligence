import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

import type { FastifyRequest } from 'fastify'
import { DataType, newDb } from 'pg-mem'

import { readPgMemMigration, readPgMemPoint3AdEvolution } from './helpers/pg-mem-migrations.ts'
import { buildApi } from '../src/http/build-api.ts'

async function testApi(ids: string[], beforeQuery?: (sql: string) => Promise<void>) {
  const db = newDb()
  db.public.registerFunction({ name: 'length', args: [DataType.text], returns: DataType.integer, implementation: (value: string) => value.length })
  db.public.registerFunction({ name: 'trim', args: [DataType.text], returns: DataType.text, implementation: (value: string) => value.trim() })
  db.public.registerFunction({ name: 'set_config', args: [DataType.text, DataType.text, DataType.bool], returns: DataType.text, implementation: (_key: string, value: string) => value })
  db.public.registerFunction({ name: 'jsonb_typeof', args: [DataType.jsonb], returns: DataType.text, implementation: (value: unknown) => Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value })
  const { Pool } = db.adapters.createPg()
  const pool = new Pool()
  await pool.query(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'))
  await pool.query(await readPgMemMigration(new URL('../migrations/006_ad_intelligence.sql', import.meta.url)))
  await pool.query(await readPgMemPoint3AdEvolution())
  await pool.query(await readPgMemMigration(new URL('../migrations/008_brief_workflow.sql', import.meta.url)))
  const appPool = beforeQuery ? {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect()
      return {
        query: async (sql: string, values?: unknown[]) => {
          await beforeQuery(sql)
          return client.query(sql, values)
        },
        release: (error?: Error) => client.release(error),
      }
    },
  } : pool
  const app = buildApi({
    pool: appPool,
    cursorSigningKey: 'test-cursor-signing-key-at-least-32-bytes',
    createId: () => ids.shift() ?? 'unexpected-id',
    now: () => new Date('2026-10-26T00:00:00.000Z'),
    authenticate: async (request: FastifyRequest) => {
      const userId = request.headers['x-user-id']
      if (typeof userId !== 'string') throw new Error('missing')
      return userId
    },
  })
  return { app, pool }
}

const auth = { 'x-user-id': 'admin-1' }
const productPayload = (name: string) => ({ name, markets: [], platforms: ['web'], targetAudiences: [], uniqueSellingPoints: [] })

async function createOrganization(app: Awaited<ReturnType<typeof testApi>>['app']) {
  assert.equal((await app.inject({ method: 'POST', url: '/organizations', headers: auth, payload: { name: 'Team' } })).statusCode, 201)
}

test('product get/list uses an explicit bounded cursor page and excludes archived by default', async () => {
  const { app, pool } = await testApi(['org-1', 'product-b', 'product-a', 'product-z'])
  await createOrganization(app)
  for (const name of ['B', 'A', 'Archived']) {
    assert.equal((await app.inject({ method: 'POST', url: '/organizations/org-1/products', headers: auth, payload: productPayload(name) })).statusCode, 201)
  }
  await pool.query(`UPDATE products SET archived_at = '2026-10-27T00:00:00Z' WHERE id = 'product-z'`)

  const first = await app.inject({ method: 'GET', url: '/organizations/org-1/products?limit=1', headers: auth })
  assert.equal(first.statusCode, 200)
  assert.deepEqual(first.json().items.map((item: { id: string }) => item.id), ['product-a'])
  assert.equal(typeof first.json().nextCursor, 'string')

  const second = await app.inject({ method: 'GET', url: `/organizations/org-1/products?limit=1&cursor=${encodeURIComponent(first.json().nextCursor)}`, headers: auth })
  assert.deepEqual(second.json(), { items: [second.json().items[0]], nextCursor: null })
  assert.equal(second.json().items[0].id, 'product-b')

  const included = await app.inject({ method: 'GET', url: '/organizations/org-1/products?includeArchived=true&limit=10', headers: auth })
  assert.deepEqual(included.json().items.map((item: { id: string }) => item.id), ['product-a', 'product-b', 'product-z'])

  const found = await app.inject({ method: 'GET', url: '/organizations/org-1/products/product-a', headers: auth })
  assert.equal(found.statusCode, 200)
  assert.equal(found.json().id, 'product-a')
  const hidden = await app.inject({ method: 'GET', url: '/organizations/org-1/products/product-z', headers: auth })
  assert.equal(hidden.statusCode, 404)
  const foundArchived = await app.inject({ method: 'GET', url: '/organizations/org-1/products/product-z?includeArchived=true', headers: auth })
  assert.equal(foundArchived.statusCode, 200)

  await app.close()
  await pool.end()
})

test('product PATCH returns its documented oversized and unsupported media errors', async () => {
  const { app, pool } = await testApi([])
  const unsupported = await app.inject({
    method: 'PATCH', url: '/organizations/org-1/products/product-1',
    headers: { ...auth, 'content-type': 'application/xml' }, payload: '<name>Renamed</name>',
  })
  assert.equal(unsupported.statusCode, 415)
  assert.deepEqual(unsupported.json(), { error: 'Unsupported media type' })

  const oversized = await app.inject({
    method: 'PATCH', url: '/organizations/org-1/products/product-1',
    headers: { ...auth, 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'x'.repeat(1_100_000) }),
  })
  assert.equal(oversized.statusCode, 413)
  assert.deepEqual(oversized.json(), { error: 'Payload too large' })
  await app.close()
  await pool.end()
})

test('product PATCH updates canonical fields and preserves identity and lifecycle timestamps', async () => {
  const { app, pool } = await testApi(['org-1', 'product-1'])
  await createOrganization(app)
  await app.inject({ method: 'POST', url: '/organizations/org-1/products', headers: auth, payload: productPayload('Original') })

  const response = await app.inject({
    method: 'PATCH', url: '/organizations/org-1/products/product-1', headers: auth,
    payload: { name: ' Updated ', markets: [' US '], platforms: ['ios'], targetAudiences: [' teams '], uniqueSellingPoints: [' fast '] },
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), {
    id: 'product-1', organizationId: 'org-1', name: 'Updated', markets: ['US'], platforms: ['ios'],
    targetAudiences: ['teams'], uniqueSellingPoints: ['fast'], archivedAt: null, createdAt: '2026-10-26T00:00:00.000Z',
  })
  await app.close()
  await pool.end()
})

test('product PATCH accepts a bounded partial field update with canonical validation', async () => {
  const { app, pool } = await testApi(['org-1', 'product-1'])
  await createOrganization(app)
  await app.inject({ method: 'POST', url: '/organizations/org-1/products', headers: auth, payload: productPayload('Original') })

  const response = await app.inject({
    method: 'PATCH', url: '/organizations/org-1/products/product-1', headers: auth, payload: { name: ' Renamed ' },
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json().markets, [])
  assert.equal(response.json().name, 'Renamed')

  const empty = await app.inject({ method: 'PATCH', url: '/organizations/org-1/products/product-1', headers: auth, payload: {} })
  assert.equal(empty.statusCode, 400)
  assert.deepEqual(empty.json(), { error: 'Invalid request' })
  await app.close()
  await pool.end()
})

test('concurrent disjoint product PATCH requests preserve both field updates', async () => {
  let reads = 0
  let gatePatchReads = true
  let releaseReads!: () => void
  const bothReadsStarted = new Promise<void>((resolve) => { releaseReads = resolve })
  const { app, pool } = await testApi(['org-1', 'product-1'], async (sql) => {
    if (!gatePatchReads || !/^SELECT \* FROM products WHERE/.test(sql)) return
    reads += 1
    if (reads === 2) releaseReads()
    await bothReadsStarted
  })
  await createOrganization(app)
  await app.inject({ method: 'POST', url: '/organizations/org-1/products', headers: auth, payload: productPayload('Original') })

  const [renamed, retargeted] = await Promise.all([
    app.inject({ method: 'PATCH', url: '/organizations/org-1/products/product-1', headers: auth, payload: { name: 'Renamed' } }),
    app.inject({ method: 'PATCH', url: '/organizations/org-1/products/product-1', headers: auth, payload: { markets: ['Washington, D.C.'] } }),
  ])
  assert.equal(renamed.statusCode, 200)
  assert.equal(retargeted.statusCode, 200)
  gatePatchReads = false

  const current = await app.inject({ method: 'GET', url: '/organizations/org-1/products/product-1', headers: auth })
  assert.equal(current.statusCode, 200)
  assert.equal(current.json().name, 'Renamed')
  assert.deepEqual(current.json().markets, ['Washington, D.C.'])
  await app.close()
  await pool.end()
})

test('product archive and restore reject non-empty JSON request bodies', async () => {
  const { app, pool } = await testApi(['org-1', 'product-1'])
  await createOrganization(app)
  await app.inject({ method: 'POST', url: '/organizations/org-1/products', headers: auth, payload: productPayload('Product') })

  for (const action of ['archive', 'restore']) {
    const response = await app.inject({
      method: 'POST', url: `/organizations/org-1/products/product-1/${action}`, headers: auth, payload: { ignored: true },
    })
    assert.equal(response.statusCode, 400, action)
    assert.deepEqual(response.json(), { error: 'Invalid request' }, action)
  }
  await app.close()
  await pool.end()
})

test('product archive preserves descendants and blocks new competitors', async () => {
  const { app, pool } = await testApi(['org-1', 'product-1', 'competitor-1', 'unexpected-competitor'])
  await createOrganization(app)
  await app.inject({ method: 'POST', url: '/organizations/org-1/products', headers: auth, payload: productPayload('Product') })
  await app.inject({ method: 'POST', url: '/organizations/org-1/products/product-1/competitors', headers: auth, payload: { name: 'Existing' } })

  const archived = await app.inject({ method: 'POST', url: '/organizations/org-1/products/product-1/archive', headers: auth })
  assert.equal(archived.statusCode, 200)
  assert.equal(archived.json().archivedAt, '2026-10-26T00:00:00.000Z')
  const descendants = await pool.query(`SELECT id, archived_at FROM competitors WHERE product_id = 'product-1'`)
  assert.deepEqual(descendants.rows, [{ id: 'competitor-1', archived_at: null }])
  const rejected = await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/competitors', headers: auth, payload: { name: 'Rejected' },
  })
  assert.equal(rejected.statusCode, 400)
  await app.close()
  await pool.end()
})

test('product restore reactivates only the product and leaves child archive state unchanged', async () => {
  const { app, pool } = await testApi(['org-1', 'product-1', 'competitor-1'])
  await createOrganization(app)
  await app.inject({ method: 'POST', url: '/organizations/org-1/products', headers: auth, payload: productPayload('Product') })
  await app.inject({ method: 'POST', url: '/organizations/org-1/products/product-1/competitors', headers: auth, payload: { name: 'Competitor' } })
  await pool.query(`UPDATE products SET archived_at = '2026-10-27T00:00:00Z' WHERE id = 'product-1'`)
  await pool.query(`UPDATE competitors SET archived_at = '2026-10-28T00:00:00Z' WHERE id = 'competitor-1'`)

  const restored = await app.inject({ method: 'POST', url: '/organizations/org-1/products/product-1/restore', headers: auth })
  assert.equal(restored.statusCode, 200)
  assert.equal(restored.json().archivedAt, null)
  const child = await pool.query(`SELECT archived_at FROM competitors WHERE id = 'competitor-1'`)
  assert.equal(new Date(child.rows[0].archived_at).toISOString(), '2026-10-28T00:00:00.000Z')
  await app.close()
  await pool.end()
})

test('competitor get/list is product-scoped, paginated, and archive-aware', async () => {
  const { app, pool } = await testApi(['org-1', 'product-1', 'competitor-b', 'competitor-a', 'competitor-z'])
  await createOrganization(app)
  await app.inject({ method: 'POST', url: '/organizations/org-1/products', headers: auth, payload: productPayload('Product') })
  for (const name of ['B', 'A', 'Archived']) {
    await app.inject({ method: 'POST', url: '/organizations/org-1/products/product-1/competitors', headers: auth, payload: { name } })
  }
  await pool.query(`UPDATE competitors SET archived_at = '2026-10-27T00:00:00Z' WHERE id = 'competitor-z'`)

  const first = await app.inject({ method: 'GET', url: '/organizations/org-1/products/product-1/competitors?limit=1', headers: auth })
  assert.equal(first.statusCode, 200)
  assert.deepEqual(first.json().items.map((item: { id: string }) => item.id), ['competitor-a'])
  const second = await app.inject({ method: 'GET', url: `/organizations/org-1/products/product-1/competitors?limit=1&cursor=${first.json().nextCursor}`, headers: auth })
  assert.equal(second.json().items[0].id, 'competitor-b')
  assert.equal(second.json().nextCursor, null)
  const included = await app.inject({ method: 'GET', url: '/organizations/org-1/products/product-1/competitors?includeArchived=true', headers: auth })
  assert.deepEqual(included.json().items.map((item: { id: string }) => item.id), ['competitor-a', 'competitor-b', 'competitor-z'])

  const found = await app.inject({ method: 'GET', url: '/organizations/org-1/products/product-1/competitors/competitor-a', headers: auth })
  assert.equal(found.statusCode, 200)
  const hidden = await app.inject({ method: 'GET', url: '/organizations/org-1/products/product-1/competitors/competitor-z', headers: auth })
  assert.equal(hidden.statusCode, 404)

  await app.close()
  await pool.end()
})

test('tenant Ad Library supports bounded cursor pagination and combined filters', async () => {
  const { app, pool } = await testApi(['org-1', 'product-1', 'competitor-1', 'competitor-2', 'ad-b', 'ad-a'])
  await createOrganization(app)
  await app.inject({ method: 'POST', url: '/organizations/org-1/products', headers: auth, payload: productPayload('Product') })
  await app.inject({ method: 'POST', url: '/organizations/org-1/products/product-1/competitors', headers: auth, payload: { name: 'One' } })
  await app.inject({ method: 'POST', url: '/organizations/org-1/products/product-1/competitors', headers: auth, payload: { name: 'Two' } })
  const adPayload = (externalId: string, isActive: boolean) => ({ records: [{
    externalId, advertiserName: 'Advertiser', body: 'Copy', startedAt: '2026-10-01T00:00:00.000Z',
    isActive, mediaUrls: [], sourceUrl: `https://example.test/${externalId}`,
  }] })
  await app.inject({ method: 'POST', url: '/organizations/org-1/products/product-1/competitors/competitor-1/ads/manual-meta', headers: auth, payload: adPayload('external-b', true) })
  await app.inject({ method: 'POST', url: '/organizations/org-1/products/product-1/competitors/competitor-2/ads/manual-meta', headers: auth, payload: adPayload('external-a', false) })

  const first = await app.inject({ method: 'GET', url: '/organizations/org-1/ads?limit=1&productId=product-1&provider=manual-meta', headers: auth })
  assert.equal(first.statusCode, 200)
  assert.equal(first.json().items[0].id, 'ad-a')
  assert.equal(typeof first.json().nextCursor, 'string')
  const next = await app.inject({ method: 'GET', url: `/organizations/org-1/ads?limit=1&productId=product-1&provider=manual-meta&cursor=${first.json().nextCursor}`, headers: auth })
  assert.equal(next.json().items[0].id, 'ad-b')
  assert.equal(next.json().nextCursor, null)

  const active = await app.inject({ method: 'GET', url: '/organizations/org-1/ads?isActive=true', headers: auth })
  assert.deepEqual(active.json().items.map((item: { id: string }) => item.id), ['ad-b'])
  const competitor = await app.inject({ method: 'GET', url: '/organizations/org-1/ads?competitorId=competitor-2', headers: auth })
  assert.deepEqual(competitor.json().items.map((item: { id: string }) => item.id), ['ad-a'])
  await app.close()
  await pool.end()
})

test('brief flow creates manual/from-ad briefs and provides tenant-scoped archive-aware pages', async () => {
  const { app, pool } = await testApi(['org-1', 'product-1', 'competitor-1', 'ad-1', 'brief-b', 'brief-a', 'brief-z'])
  await createOrganization(app)
  await app.inject({ method: 'POST', url: '/organizations/org-1/products', headers: auth, payload: productPayload('Product') })
  await app.inject({ method: 'POST', url: '/organizations/org-1/products/product-1/competitors', headers: auth, payload: { name: 'Competitor' } })
  await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/competitors/competitor-1/ads/manual-meta', headers: auth,
    payload: { records: [{ externalId: 'external-1', advertiserName: 'Ad', body: 'Winning hook', callToAction: 'Install', startedAt: '2026-10-01T00:00:00.000Z', isActive: true, mediaUrls: [], sourceUrl: 'https://example.test/ad' }] },
  })
  const dimensions = { audience: ' students ', market: ' US ', angle: ' focus ', format: ' video ' }
  const manual = await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/briefs', headers: auth,
    payload: { title: ' Manual ', hook: ' Hook ', callToAction: ' Try ', dimensions },
  })
  assert.equal(manual.statusCode, 201)
  assert.equal(manual.json().id, 'brief-b')
  assert.deepEqual(manual.json().dimensions, { audience: 'students', market: 'US', angle: 'focus', format: 'video' })
  const fromAd = await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/briefs/from-ad', headers: auth,
    payload: { adId: 'ad-1', title: ' From ad ', dimensions: { ...dimensions, audience: 'pros' } },
  })
  assert.equal(fromAd.statusCode, 201)
  assert.equal(fromAd.json().hook, 'Winning hook')
  assert.equal(fromAd.json().sourceAdId, 'ad-1')
  await app.inject({ method: 'POST', url: '/organizations/org-1/products/product-1/briefs', headers: auth, payload: { title: 'Archived', hook: '', dimensions } })
  await pool.query(`UPDATE creative_briefs SET status = 'archived' WHERE id = 'brief-z'`)

  const first = await app.inject({ method: 'GET', url: '/organizations/org-1/products/product-1/briefs?limit=1', headers: auth })
  assert.equal(first.statusCode, 200)
  assert.equal(first.json().items[0].id, 'brief-a')
  const second = await app.inject({ method: 'GET', url: `/organizations/org-1/products/product-1/briefs?limit=1&cursor=${first.json().nextCursor}`, headers: auth })
  assert.equal(second.json().items[0].id, 'brief-b')
  assert.equal(second.json().nextCursor, null)
  const included = await app.inject({ method: 'GET', url: '/organizations/org-1/products/product-1/briefs?includeArchived=true', headers: auth })
  assert.deepEqual(included.json().items.map((item: { id: string }) => item.id), ['brief-a', 'brief-b', 'brief-z'])

  const found = await app.inject({ method: 'GET', url: '/organizations/org-1/briefs/brief-b', headers: auth })
  assert.equal(found.statusCode, 200)
  const missing = await app.inject({ method: 'GET', url: '/organizations/org-1/briefs/not-there', headers: auth })
  assert.equal(missing.statusCode, 404)
  await app.close()
  await pool.end()
})

test('brief HTTP workflow updates with optimistic concurrency and exposes version history', async () => {
  const { app, pool } = await testApi(['org-1', 'product-1', 'brief-1'])
  await createOrganization(app)
  await app.inject({ method: 'POST', url: '/organizations/org-1/products', headers: auth, payload: productPayload('Product') })
  const dimensions = { audience: 'students', market: 'US', angle: 'focus', format: 'video' }
  const created = await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/briefs', headers: auth,
    payload: { title: 'Draft', hook: 'Hook', dimensions },
  })
  assert.equal(created.statusCode, 201)
  assert.equal(created.json().version, 1)

  const updated = await app.inject({
    method: 'PATCH', url: '/organizations/org-1/briefs/brief-1', headers: auth,
    payload: { expectedVersion: 1, title: 'Ready', status: 'triage', hook: 'New hook', callToAction: 'Try', dimensions },
  })
  assert.equal(updated.statusCode, 200)
  assert.equal(updated.json().version, 2)
  assert.equal(updated.json().status, 'triage')

  const stale = await app.inject({
    method: 'PATCH', url: '/organizations/org-1/briefs/brief-1', headers: auth,
    payload: { expectedVersion: 1, title: 'Stale', status: 'draft', hook: '', callToAction: null, dimensions },
  })
  assert.equal(stale.statusCode, 409)

  const history = await app.inject({ method: 'GET', url: '/organizations/org-1/briefs/brief-1/versions?limit=10', headers: auth })
  assert.equal(history.statusCode, 200)
  assert.deepEqual(history.json().items.map((item: { version: number }) => item.version), [2, 1])
  assert.equal(history.json().items[0].changedBy, 'admin-1')
  await app.close()
  await pool.end()
})

test('Iteration Map endpoint analyzes active briefs with shared normalization', async () => {
  const { app, pool } = await testApi(['org-1', 'product-1', 'brief-1'])
  await createOrganization(app)
  await app.inject({ method: 'POST', url: '/organizations/org-1/products', headers: auth, payload: productPayload('Product') })
  await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/briefs', headers: auth,
    payload: { title: 'Brief', hook: '', dimensions: { audience: 'students', market: 'US', angle: 'focus', format: 'video' } },
  })
  const response = await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/iteration-map/analyze', headers: auth,
    payload: { axes: { audience: [' students ', 'pros'], market: ['US'], angle: ['focus'], format: ['video'] } },
  })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().totalCombinations, 2)
  assert.deepEqual(response.json().covered[0].briefIds, ['brief-1'])
  assert.equal(response.json().missing[0].dimensions.audience, 'pros')
  await app.close()
  await pool.end()
})

test('product-flow routes reject ambiguous or malformed input with fixed public errors', async () => {
  const { app, pool } = await testApi(['org-1', 'product-1'])
  await createOrganization(app)
  const invalidUrls = [
    '/organizations/org-1/products?limit=0',
    '/organizations/org-1/products?limit=101',
    '/organizations/org-1/products?limit=1&limit=2',
    '/organizations/org-1/products?includeArchived=TRUE',
    '/organizations/org-1/products?cursor=not-a-cursor',
    '/organizations/org-1/products?unknown=value',
    '/organizations/org-1/ads?includeArchived=true',
    '/organizations/org-1/ads?isActive=yes',
    '/organizations/org-1/ads?provider=%20',
  ]
  for (const url of invalidUrls) {
    const response = await app.inject({ method: 'GET', url, headers: auth })
    assert.equal(response.statusCode, 400, url)
    assert.deepEqual(response.json(), { error: 'Invalid request' }, url)
  }
  const unknownBody = await app.inject({
    method: 'POST', url: '/organizations/org-1/products', headers: auth,
    payload: { ...productPayload('Product'), unexpected: true },
  })
  assert.equal(unknownBody.statusCode, 400)
  assert.deepEqual(unknownBody.json(), { error: 'Invalid request' })
  const oversized = await app.inject({
    method: 'POST', url: '/organizations/org-1/products', headers: auth,
    payload: { ...productPayload('Product'), markets: Array.from({ length: 101 }, (_, index) => `m${index}`) },
  })
  assert.equal(oversized.statusCode, 400)
  const sparse = new Array(2)
  sparse[1] = 'US'
  const sparseResponse = await app.inject({
    method: 'POST', url: '/organizations/org-1/products', headers: auth,
    payload: { ...productPayload('Product'), markets: sparse },
  })
  assert.equal(sparseResponse.statusCode, 400)
  await app.close()
  await pool.end()
})

test('product-flow write routes reject unknown fields before persistence', async () => {
  const { app, pool } = await testApi(['org-1', 'product-1', 'competitor-1'])
  await createOrganization(app)
  await app.inject({ method: 'POST', url: '/organizations/org-1/products', headers: auth, payload: productPayload('Product') })

  const competitor = await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/competitors', headers: auth,
    payload: { name: 'Competitor', unknown: true },
  })
  assert.equal(competitor.statusCode, 400)
  const stored = await pool.query(`SELECT id FROM competitors`)
  assert.equal(stored.rowCount, 0)

  await app.close()
  await pool.end()
})
