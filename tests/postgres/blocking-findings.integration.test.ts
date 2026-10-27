import assert from 'node:assert/strict'
import test from 'node:test'

import { buildApi } from '../../src/http/build-api.ts'
import { withRealPostgres } from './helpers/real-postgres.ts'

function appFor(pool: Parameters<typeof buildApi>[0]['pool'], ids: string[]) {
  return buildApi({
    pool,
    cursorSigningKey: 'test-cursor-signing-key-at-least-32-bytes',
    createId: () => ids.shift() ?? 'unexpected-id',
    now: () => new Date('2026-10-26T00:00:00.000Z'),
    authenticate: async (request) => {
      const value = request.headers['x-user-id']
      if (typeof value !== 'string') throw new Error('missing identity')
      return value
    },
  })
}

const productPayload = { name: 'Product', markets: [], platforms: ['web'], targetAudiences: [], uniqueSellingPoints: [] }

test('real PostgreSQL pagination preserves microseconds, equal timestamps, and cursor filter context', async () => {
  await withRealPostgres(async ({ runtimePool, inspectionPool }) => {
    const app = appFor(runtimePool, ['org-page', 'product-z', 'product-a', 'product-b', 'org-page-other'])
    const headers = { 'x-user-id': 'admin-page' }
    assert.equal((await app.inject({ method: 'POST', url: '/organizations', headers, payload: { name: 'Team' } })).statusCode, 201)
    for (const id of ['product-z', 'product-a', 'product-b']) {
      assert.equal((await app.inject({ method: 'POST', url: '/organizations/org-page/products', headers, payload: { ...productPayload, name: id } })).statusCode, 201)
    }
    await inspectionPool.query(`
      UPDATE products SET created_at = CASE id
        WHEN 'product-z' THEN '2026-10-26T00:00:00.000100Z'::timestamptz
        WHEN 'product-a' THEN '2026-10-26T00:00:00.000200Z'::timestamptz
        WHEN 'product-b' THEN '2026-10-26T00:00:00.000200Z'::timestamptz
      END
      WHERE organization_id = 'org-page'
    `)

    const seen: string[] = []
    let cursor: string | null = null
    for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
      const response: Awaited<ReturnType<typeof app.inject>> = await app.inject({
        method: 'GET',
        url: `/organizations/org-page/products?limit=1${cursor ? `&cursor=${cursor}` : ''}`,
        headers,
      })
      assert.equal(response.statusCode, 200)
      seen.push(...response.json().items.map((item: { id: string }) => item.id))
      cursor = response.json().nextCursor
      if (!cursor) break
    }
    assert.deepEqual(seen, ['product-z', 'product-a', 'product-b'])

    const filtered = await app.inject({ method: 'GET', url: '/organizations/org-page/products?limit=1&includeArchived=true', headers })
    const reused = await app.inject({ method: 'GET', url: `/organizations/org-page/products?limit=1&cursor=${filtered.json().nextCursor}`, headers })
    assert.equal(reused.statusCode, 400)
    assert.deepEqual(reused.json(), { error: 'Invalid request' })

    await app.inject({ method: 'POST', url: '/organizations', headers, payload: { name: 'Other' } })
    const crossTenant = await app.inject({
      method: 'GET',
      url: `/organizations/org-page-other/products?limit=1&includeArchived=true&cursor=${filtered.json().nextCursor}`,
      headers,
    })
    assert.equal(crossTenant.statusCode, 400)
    assert.deepEqual(crossTenant.json(), { error: 'Invalid request' })
    await app.close()
  })
})

test('real PostgreSQL competitor creation rejects cross-tenant, archived-parent, and archive races with typed errors', async () => {
  await withRealPostgres(async ({ runtimePool, inspectionPool }) => {
    const app = appFor(runtimePool, ['org-race-a', 'product-race-a', 'org-race-b', 'competitor-archived', 'competitor-race'])
    const adminA = { 'x-user-id': 'admin-race-a' }
    const adminB = { 'x-user-id': 'admin-race-b' }
    await app.inject({ method: 'POST', url: '/organizations', headers: adminA, payload: { name: 'A' } })
    await app.inject({ method: 'POST', url: '/organizations/org-race-a/products', headers: adminA, payload: productPayload })
    await app.inject({ method: 'POST', url: '/organizations', headers: adminB, payload: { name: 'B' } })

    const foreign = await app.inject({
      method: 'POST', url: '/organizations/org-race-a/products/product-race-a/competitors', headers: adminB, payload: { name: 'Foreign' },
    })
    assert.equal(foreign.statusCode, 403)
    assert.deepEqual(foreign.json(), { error: 'Access denied' })

    await inspectionPool.query("UPDATE products SET archived_at = now() WHERE id = 'product-race-a'")
    const archived = await app.inject({
      method: 'POST', url: '/organizations/org-race-a/products/product-race-a/competitors', headers: adminA, payload: { name: 'Archived' },
    })
    assert.equal(archived.statusCode, 400)
    assert.deepEqual(archived.json(), { error: 'Invalid request' })

    await inspectionPool.query("UPDATE products SET archived_at = NULL WHERE id = 'product-race-a'")
    const blocker = await inspectionPool.connect()
    await blocker.query('BEGIN')
    await blocker.query("UPDATE products SET archived_at = now() WHERE id = 'product-race-a'")
    const racedRequest = app.inject({
      method: 'POST', url: '/organizations/org-race-a/products/product-race-a/competitors', headers: adminA, payload: { name: 'Raced' },
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    await blocker.query('COMMIT')
    blocker.release()
    const raced = await racedRequest
    assert.equal(raced.statusCode, 400)
    assert.deepEqual(raced.json(), { error: 'Invalid request' })

    const rows = await inspectionPool.query("SELECT id FROM competitors WHERE organization_id = 'org-race-a'")
    assert.equal(rows.rowCount, 0)
    await app.close()
  })
})

test('real PostgreSQL serializes archive races against manual import, manual brief, and from-ad brief writes', async () => {
  await withRealPostgres(async ({ runtimePool, inspectionPool }) => {
    const app = appFor(runtimePool, ['org-write-race', 'product-write-race', 'competitor-write-race', 'ad-source'])
    const headers = { 'x-user-id': 'admin-write-race' }
    const dimensions = { audience: 'a', market: 'm', angle: 'x', format: 'f' }
    await app.inject({ method: 'POST', url: '/organizations', headers, payload: { name: 'Team' } })
    await app.inject({ method: 'POST', url: '/organizations/org-write-race/products', headers, payload: productPayload })
    await app.inject({
      method: 'POST', url: '/organizations/org-write-race/products/product-write-race/competitors', headers,
      payload: { name: 'Competitor' },
    })
    await app.inject({
      method: 'POST', url: '/organizations/org-write-race/products/product-write-race/competitors/competitor-write-race/ads/manual-meta', headers,
      payload: { records: [{ externalId: 'source', advertiserName: 'A', body: 'B', startedAt: '2026-10-01T00:00:00Z', isActive: true, mediaUrls: [], sourceUrl: 'https://example.test/source' }] },
    })

    const race = async (archiveSql: string, request: {
      method: 'POST'
      url: string
      headers: Record<string, string>
      payload: Record<string, unknown>
    }) => {
      const blocker = await inspectionPool.connect()
      await blocker.query('BEGIN')
      await blocker.query(archiveSql)
      const pending = Promise.resolve(app.inject(request)).finally(() => { settled = true })
      let settled = false
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      const settledBeforeArchiveCommitted = settled
      await blocker.query('COMMIT')
      blocker.release()
      const response = await pending
      assert.equal(settledBeforeArchiveCommitted, false, 'write did not wait for the archive transaction')
      assert.equal(response.statusCode, 400, response.body)
    }

    await race("UPDATE products SET archived_at = now() WHERE id = 'product-write-race'", {
      method: 'POST', url: '/organizations/org-write-race/products/product-write-race/competitors/competitor-write-race/ads/manual-meta', headers,
      payload: { records: [{ externalId: 'raced', advertiserName: 'A', body: 'B', startedAt: '2026-10-01T00:00:00Z', isActive: true, mediaUrls: [], sourceUrl: 'https://example.test/raced' }] },
    })
    await inspectionPool.query("UPDATE products SET archived_at = NULL WHERE id = 'product-write-race'")
    await race("UPDATE products SET archived_at = now() WHERE id = 'product-write-race'", {
      method: 'POST', url: '/organizations/org-write-race/products/product-write-race/briefs', headers,
      payload: { title: 'Raced manual', hook: 'Hook', dimensions },
    })
    await inspectionPool.query("UPDATE products SET archived_at = NULL WHERE id = 'product-write-race'")
    await race("UPDATE competitors SET archived_at = now() WHERE id = 'competitor-write-race'", {
      method: 'POST', url: '/organizations/org-write-race/products/product-write-race/briefs/from-ad', headers,
      payload: { adId: 'ad-source', title: 'Raced from ad', dimensions },
    })

    assert.equal((await inspectionPool.query("SELECT id FROM competitor_ads WHERE external_id = 'raced'")).rowCount, 0)
    assert.equal((await inspectionPool.query("SELECT id FROM creative_briefs WHERE title LIKE 'Raced%'")).rowCount, 0)
    await app.close()
  })
})

test('real PostgreSQL malformed catalog JSONB returns a fixed data-integrity error', async () => {
  await withRealPostgres(async ({ runtimePool, inspectionPool }) => {
    const app = appFor(runtimePool, ['org-data', 'product-data'])
    const headers = { 'x-user-id': 'admin-data' }
    await app.inject({ method: 'POST', url: '/organizations', headers, payload: { name: 'Team' } })
    await app.inject({ method: 'POST', url: '/organizations/org-data/products', headers, payload: productPayload })
    await inspectionPool.query("UPDATE products SET markets = '{\"wrong\":true}'::jsonb WHERE id = 'product-data'")
    const response = await app.inject({ method: 'GET', url: '/organizations/org-data/products', headers })
    assert.equal(response.statusCode, 500)
    assert.deepEqual(response.json(), { error: 'Internal server error' })
    await app.close()
  })
})
