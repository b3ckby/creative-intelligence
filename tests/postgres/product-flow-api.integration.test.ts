import assert from 'node:assert/strict'
import test from 'node:test'

import { buildApi } from '../../src/http/build-api.ts'
import { withRealPostgres } from './helpers/real-postgres.ts'

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
