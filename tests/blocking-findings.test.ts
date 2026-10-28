import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

import { DataType, newDb } from 'pg-mem'

import { readPgMemMigration, readPgMemPoint3AdEvolution, registerPgMemPoint4AnalyticsCapture } from './helpers/pg-mem-migrations.ts'
import type { FastifyRequest } from 'fastify'
import { decodeAdRow, decodeCompetitorRow, decodeProductRow } from '../src/persistence/catalog-row-decoders.ts'
import { buildApi } from '../src/http/build-api.ts'
import { cursorScope, decodeCursor, encodeCursor } from '../src/http/pagination.ts'

async function testApi(ids = ['org-1', 'product-1', 'competitor-1', 'ad-1', 'ad-2']) {
  const db = newDb()
  registerPgMemPoint4AnalyticsCapture(db)
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
  const app = buildApi({
    pool,
    cursorSigningKey: 'test-cursor-signing-key-at-least-32-bytes',
    createId: () => ids.shift() ?? 'unexpected-id',
    now: () => new Date('2026-10-26T00:00:00.000Z'),
    authenticate: async (request: FastifyRequest) => {
      const value = request.headers['x-user-id']
      if (typeof value !== 'string') throw new Error('missing identity')
      return value
    },
  })
  return { app, pool }
}

async function seedCatalog(app: Awaited<ReturnType<typeof testApi>>['app']) {
  const headers = { 'x-user-id': 'admin-1' }
  await app.inject({ method: 'POST', url: '/organizations', headers, payload: { name: 'Team' } })
  await app.inject({ method: 'POST', url: '/organizations/org-1/products', headers, payload: {
    name: 'Product', markets: [], platforms: ['web'], targetAudiences: [], uniqueSellingPoints: [],
  } })
  await app.inject({ method: 'POST', url: '/organizations/org-1/products/product-1/competitors', headers, payload: { name: 'Competitor' } })
  return headers
}

test('raw JSON parsing rejects duplicate keys at every object depth with a fixed 400 response', async () => {
  const { app, pool } = await testApi()
  const headers = { 'content-type': 'application/json', 'x-user-id': 'admin-1' }
  for (const payload of [
    '{"name":"Team","name":"Other"}',
    '{"name":"Team","nested":{"x":1,"x":2}}',
  ]) {
    const response = await app.inject({ method: 'POST', url: '/organizations', headers, payload })
    assert.equal(response.statusCode, 400)
    assert.deepEqual(response.json(), { error: 'Invalid request' })
  }
  await app.close()
  await pool.end()
})

test('raw JSON parsing is standards-conforming and rejects dangerous, malformed, and bounded-complexity bodies', async () => {
  const headers = { 'content-type': 'application/json', 'x-user-id': 'admin-1' }
  const invalidBodies = [
    '{"name":"Team"} trailing',
    '{"name":"Team"}{"name":"Other"}',
    '{"name":"bad\\xescape"}',
    '{"name":"raw\u0001control"}',
    '{"name":"Team","nested":{"__proto__":{"polluted":true}}}',
    '{"name":"Team","nested":{"prototype":1}}',
    '{"name":"Team","nested":{"constructor":1}}',
    JSON.stringify({ name: 'Team', nested: Object.fromEntries(Array.from({ length: 1_001 }, (_, index) => [`key-${index}`, index])) }),
    JSON.stringify(Array.from({ length: 11 }, (_, group) => Object.fromEntries(Array.from({ length: 1_000 }, (__, index) => [`key-${group}-${index}`, index])))),
    `${'['.repeat(65)}null${']'.repeat(65)}`,
  ]
  for (const payload of invalidBodies) {
    const { app, pool } = await testApi()
    const response = await app.inject({ method: 'POST', url: '/organizations', headers, payload })
    assert.equal(response.statusCode, 400, payload.slice(0, 100))
    assert.deepEqual(response.json(), { error: 'Invalid request' })
    await app.close()
    await pool.end()
  }

  const { app, pool } = await testApi()
  const valid = await app.inject({ method: 'POST', url: '/organizations', headers, payload: '{"name":"\\u0054eam"}' })
  assert.equal(valid.statusCode, 201)
  assert.equal(valid.json().name, 'Team')
  assert.equal(({} as { polluted?: boolean }).polluted, undefined)
  await app.close()
  await pool.end()
})

test('organizations and members reject unknown body fields and every route rejects unknown or duplicate query parameters', async () => {
  const { app, pool } = await testApi()
  const headers = { 'x-user-id': 'admin-1' }

  for (const request of [
    { method: 'POST' as const, url: '/organizations', payload: { name: 'Team', unexpected: true } },
    { method: 'POST' as const, url: '/organizations?unexpected=1', payload: { name: 'Team' } },
  ]) {
    const response = await app.inject({ ...request, headers })
    assert.equal(response.statusCode, 400)
    assert.deepEqual(response.json(), { error: 'Invalid request' })
  }

  assert.equal((await app.inject({ method: 'POST', url: '/organizations', headers, payload: { name: 'Team' } })).statusCode, 201)
  for (const request of [
    { url: '/organizations/org-1/members', payload: { userId: 'member-1', role: 'member', unexpected: true } },
    { url: '/organizations/org-1/members?role=admin', payload: { userId: 'member-1', role: 'member' } },
    { url: '/organizations/org-1/members?x=1&x=2', payload: { userId: 'member-1', role: 'member' } },
  ]) {
    const response = await app.inject({ method: 'POST', ...request, headers })
    assert.equal(response.statusCode, 400)
    assert.deepEqual(response.json(), { error: 'Invalid request' })
  }

  await app.close()
  await pool.end()
})

test('manual ad import rejects an empty batch', async () => {
  const { app, pool } = await testApi()
  const headers = await seedCatalog(app)
  const response = await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/competitors/competitor-1/ads/manual-meta', headers,
    payload: { records: [] },
  })
  assert.equal(response.statusCode, 400)
  assert.deepEqual(response.json(), { error: 'Invalid request' })
  await app.close()
  await pool.end()
})

test('ads under archived parents are hidden by default and only explicit includeArchived routes reveal them', async () => {
  const { app, pool } = await testApi()
  const headers = await seedCatalog(app)
  await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/competitors/competitor-1/ads/manual-meta', headers,
    payload: { records: [{ externalId: 'one', advertiserName: 'A', body: 'B', startedAt: '2026-10-01T00:00:00.000Z', isActive: true, mediaUrls: [], sourceUrl: 'https://example.test/one' }] },
  })
  await pool.query("UPDATE competitors SET archived_at = '2026-10-26T01:00:00Z' WHERE id = 'competitor-1'")

  const tenantDefault = await app.inject({ method: 'GET', url: '/organizations/org-1/ads', headers })
  assert.deepEqual(tenantDefault.json().items, [])
  const legacyDefault = await app.inject({ method: 'GET', url: '/organizations/org-1/competitors/competitor-1/ads', headers })
  assert.deepEqual(legacyDefault.json().items, [])
  const explicit = await app.inject({ method: 'GET', url: '/organizations/org-1/competitors/competitor-1/ads?includeArchived=true', headers })
  assert.equal(explicit.json().items.length, 1)
  const unsupported = await app.inject({ method: 'GET', url: '/organizations/org-1/ads?includeArchived=true', headers })
  assert.equal(unsupported.statusCode, 400)

  await app.close()
  await pool.end()
})

test('catalog row decoders reject whitespace identifiers, malformed URLs, arrays, enums, and timestamps', () => {
  const product = {
    id: 'product-1', organization_id: 'org-1', name: 'Product', markets: [], platforms: ['web'],
    target_audiences: [], unique_selling_points: [], archived_at: null, created_at: new Date('2026-10-26T00:00:00Z'),
  }
  const competitor = {
    id: 'competitor-1', organization_id: 'org-1', product_id: 'product-1', name: 'Competitor',
    meta_page_url: 'https://example.test/page', archived_at: null, created_at: new Date('2026-10-26T00:00:00Z'),
  }
  const ad = {
    id: 'ad-1', organization_id: 'org-1', product_id: 'product-1', competitor_id: 'competitor-1',
    provider_name: 'manual-meta', platform: 'meta', external_id: 'external-1', advertiser_name: 'A', body: 'B',
    call_to_action: null, started_at: new Date('2026-10-01T00:00:00Z'), is_active: true,
    media_urls: ['https://cdn.example.test/ad.mp4'], source_url: 'https://example.test/ad',
    first_seen_at: new Date('2026-10-26T00:00:00Z'), last_seen_at: new Date('2026-10-26T00:00:00Z'),
  }
  for (const decode of [
    () => decodeProductRow({ ...product, id: ' product-1 ' }),
    () => decodeProductRow({ ...product, markets: [' valid '] }),
    () => decodeProductRow({ ...product, created_at: 'not-a-date' }),
    () => decodeCompetitorRow({ ...competitor, meta_page_url: 'javascript:alert(1)' }),
    () => decodeAdRow({ ...ad, provider_name: ' manual-meta ' }),
    () => decodeAdRow({ ...ad, platform: 'other' }),
    () => decodeAdRow({ ...ad, media_urls: ['file:///etc/passwd'] }),
    () => decodeAdRow({ ...ad, source_url: 'http://example.test/ad' }),
  ]) assert.throws(decode, /Stored .* failed data-integrity validation/)
})

test('catalog reads fail closed with a fixed data-integrity error for malformed JSONB', async () => {
  const { app, pool } = await testApi()
  const headers = await seedCatalog(app)
  await pool.query("UPDATE products SET markets = '{\"not\":\"an array\"}'::jsonb WHERE id = 'product-1'")
  const response = await app.inject({ method: 'GET', url: '/organizations/org-1/products', headers })
  assert.equal(response.statusCode, 500)
  assert.deepEqual(response.json(), { error: 'Internal server error' })
  await app.close()
  await pool.end()
})

test('archived parents reject descendant creation import and analysis, and archived brief detail is opt-in', async () => {
  const { app, pool } = await testApi(['org-1', 'product-1', 'competitor-1', 'ad-1', 'brief-1', 'later'])
  const headers = await seedCatalog(app)
  const dimensions = { audience: 'a', market: 'm', angle: 'x', format: 'f' }
  const brief = await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/briefs', headers,
    payload: { title: 'Brief', hook: 'Hook', dimensions },
  })
  assert.equal(brief.statusCode, 201)
  await pool.query("UPDATE creative_briefs SET status = 'archived' WHERE id = 'ad-1'")
  const hidden = await app.inject({ method: 'GET', url: '/organizations/org-1/briefs/ad-1', headers })
  assert.equal(hidden.statusCode, 404)
  const included = await app.inject({ method: 'GET', url: '/organizations/org-1/briefs/ad-1?includeArchived=true', headers })
  assert.equal(included.statusCode, 200)

  await pool.query("UPDATE products SET archived_at = '2026-10-26T01:00:00Z' WHERE id = 'product-1'")
  await pool.query("UPDATE creative_briefs SET status = 'draft' WHERE id = 'ad-1'")
  const hiddenByArchivedParent = await app.inject({ method: 'GET', url: '/organizations/org-1/briefs/ad-1', headers })
  assert.equal(hiddenByArchivedParent.statusCode, 404)
  for (const request of [
    { method: 'POST' as const, url: '/organizations/org-1/products/product-1/competitors', payload: { name: 'Later competitor' } },
    { method: 'POST' as const, url: '/organizations/org-1/products/product-1/briefs', payload: { title: 'Later brief', hook: 'Hook', dimensions } },
    { method: 'POST' as const, url: '/organizations/org-1/products/product-1/iteration-map/analyze', payload: { axes: ['audience'] } },
    { method: 'POST' as const, url: '/organizations/org-1/products/product-1/competitors/competitor-1/ads/manual-meta', payload: { records: [{ externalId: 'later', advertiserName: 'A', body: 'B', startedAt: '2026-10-01T00:00:00.000Z', isActive: true, mediaUrls: [], sourceUrl: 'https://example.test/later' }] } },
  ]) {
    const response = await app.inject({ ...request, headers })
    assert.equal(response.statusCode, 400, `${request.url}: ${response.body}`)
    assert.deepEqual(response.json(), {
      error: request.url.endsWith('/ads/manual-meta') ? 'Invalid manual ad records' : 'Invalid request',
    })
  }

  await pool.query("UPDATE products SET archived_at = NULL WHERE id = 'product-1'")
  await pool.query("UPDATE competitors SET archived_at = '2026-10-26T01:00:00Z' WHERE id = 'competitor-1'")
  const archivedCompetitorImport = await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/competitors/competitor-1/ads/manual-meta', headers,
    payload: { records: [{ externalId: 'later', advertiserName: 'A', body: 'B', startedAt: '2026-10-01T00:00:00.000Z', isActive: true, mediaUrls: [], sourceUrl: 'https://example.test/later' }] },
  })
  assert.equal(archivedCompetitorImport.statusCode, 400)
  assert.deepEqual(archivedCompetitorImport.json(), { error: 'Invalid manual ad records' })

  await app.close()
  await pool.end()
})

test('archive matrix reveals descendants only by opt-in and rejects from-ad briefs for archived competitors', async () => {
  const { app, pool } = await testApi(['org-1', 'product-1', 'competitor-1', 'ad-1', 'brief-1'])
  const headers = await seedCatalog(app)
  const dimensions = { audience: 'a', market: 'm', angle: 'x', format: 'f' }
  assert.equal((await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/briefs', headers,
    payload: { title: 'Brief', hook: 'Hook', dimensions },
  })).statusCode, 201)
  assert.equal((await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/competitors/competitor-1/ads/manual-meta', headers,
    payload: { records: [{ externalId: 'one', advertiserName: 'A', body: 'Body', startedAt: '2026-10-01T00:00:00.000Z', isActive: true, mediaUrls: [], sourceUrl: 'https://example.test/one' }] },
  })).statusCode, 200)

  await pool.query("UPDATE products SET archived_at = '2026-10-26T01:00:00Z' WHERE id = 'product-1'")
  const hidden = await app.inject({ method: 'GET', url: '/organizations/org-1/products/product-1/briefs', headers })
  assert.equal(hidden.statusCode, 200)
  assert.deepEqual(hidden.json().items, [])
  const included = await app.inject({ method: 'GET', url: '/organizations/org-1/products/product-1/briefs?includeArchived=true', headers })
  assert.equal(included.statusCode, 200)
  assert.equal(included.json().items.length, 1)

  await pool.query("UPDATE products SET archived_at = NULL WHERE id = 'product-1'")
  await pool.query("UPDATE competitors SET archived_at = '2026-10-26T01:00:00Z' WHERE id = 'competitor-1'")
  const fromArchivedCompetitor = await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/briefs/from-ad', headers,
    payload: { adId: 'ad-1', title: 'From ad', dimensions },
  })
  assert.equal(fromArchivedCompetitor.statusCode, 400)
  assert.deepEqual(fromArchivedCompetitor.json(), { error: 'Invalid request' })

  await app.close()
  await pool.end()
})

test('pagination cursors authenticate canonical payload, scope, timestamp, and id', () => {
  const key = Buffer.from('cursor-test-key-with-at-least-32-bytes')
  const context = '{"endpoint":"products","organizationId":"org-1"}'
  const cursor = encodeCursor({ createdAt: '1792972800.123456', id: 'product-1' }, context, key)
  assert.deepEqual(decodeCursor(cursor, context, key), { createdAt: '1792972800.123456', id: 'product-1' })

  const unicodeId = '😀'.repeat(256)
  const unicodeContext = cursorScope('products', { organizationId: '😀'.repeat(256), includeArchived: false })
  const unicodeCursor = encodeCursor({ createdAt: '1792972800.123456', id: unicodeId }, unicodeContext, key)
  assert.ok(unicodeCursor.length > 2_048)
  assert.deepEqual(decodeCursor(unicodeCursor, unicodeContext, key), { createdAt: '1792972800.123456', id: unicodeId })
  assert.throws(
    () => encodeCursor({ createdAt: '1792972800.123456', id: unicodeId }, 'x'.repeat(8_192), key),
    /cursor/i,
  )

  const [payload, signature] = cursor.split('.')
  assert.ok(payload && signature)
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
  for (const mutation of [
    { ...parsed, context: `${context}-other` },
    { ...parsed, at: '1792972801.123456' },
    { ...parsed, id: 'product-2' },
    { ...parsed, v: 2 },
  ]) {
    const forged = `${Buffer.from(JSON.stringify(mutation)).toString('base64url')}.${signature}`
    assert.throws(() => decodeCursor(forged, context, key), /Cursor is invalid/)
  }
  assert.throws(() => decodeCursor(cursor, `${context}-other`, key), /Cursor is invalid/)
  assert.throws(() => decodeCursor(`${payload}.${`${signature.slice(0, -1)}A`}`, context, key), /Cursor is invalid/)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const lastSignatureIndex = alphabet.indexOf(signature.at(-1) ?? '')
  const aliasIndex = (lastSignatureIndex & 60) | ((lastSignatureIndex + 1) & 3)
  const nonCanonicalSignature = `${signature.slice(0, -1)}${alphabet[aliasIndex]}`
  assert.notEqual(nonCanonicalSignature, signature)
  assert.throws(() => decodeCursor(`${payload}.${nonCanonicalSignature}`, context, key), /Cursor is invalid/)
  const nonCanonicalPayload = Buffer.from(`{ "v":1,"context":${JSON.stringify(context)},"at":"1792972800.123456","id":"product-1"}`).toString('base64url')
  assert.throws(() => decodeCursor(`${nonCanonicalPayload}.${signature}`, context, key), /Cursor is invalid/)
  assert.throws(() => decodeCursor(`A${payload}.${signature}`, context, key), /Cursor is invalid/)
})

test('pagination cursors are versioned and bound to endpoint tenant and filter context', async () => {
  const { app, pool } = await testApi()
  const headers = await seedCatalog(app)
  for (const externalId of ['one', 'two']) {
    await app.inject({
      method: 'POST', url: '/organizations/org-1/products/product-1/competitors/competitor-1/ads/manual-meta', headers,
      payload: { records: [{ externalId, advertiserName: 'A', body: externalId, startedAt: '2026-10-01T00:00:00.000Z', isActive: true, mediaUrls: [], sourceUrl: `https://example.test/${externalId}` }] },
    })
  }
  const first = await app.inject({ method: 'GET', url: '/organizations/org-1/ads?limit=1&provider=manual-meta', headers })
  assert.equal(first.statusCode, 200)
  const cursor = first.json().nextCursor
  assert.equal(typeof cursor, 'string')

  for (const url of [
    `/organizations/org-1/ads?limit=1&cursor=${cursor}`,
    `/organizations/org-1/competitors/competitor-1/ads?limit=1&cursor=${cursor}`,
  ]) {
    const response = await app.inject({ method: 'GET', url, headers })
    assert.equal(response.statusCode, 400)
    assert.deepEqual(response.json(), { error: 'Invalid request' })
  }
  await app.close()
  await pool.end()
})

test('legacy competitor ads route is bounded and rejects unknown or duplicate query parameters', async () => {
  const { app, pool } = await testApi()
  const headers = await seedCatalog(app)
  for (const externalId of ['one', 'two']) {
    assert.equal((await app.inject({
      method: 'POST',
      url: '/organizations/org-1/products/product-1/competitors/competitor-1/ads/manual-meta',
      headers,
      payload: { records: [{ externalId, advertiserName: 'A', body: externalId, startedAt: '2026-10-01T00:00:00.000Z', isActive: true, mediaUrls: [], sourceUrl: `https://example.test/${externalId}` }] },
    })).statusCode, 200)
  }

  const page = await app.inject({ method: 'GET', url: '/organizations/org-1/competitors/competitor-1/ads?limit=1', headers })
  assert.equal(page.statusCode, 200)
  assert.equal(page.json().items.length, 1)
  assert.equal(typeof page.json().nextCursor, 'string')
  for (const url of [
    '/organizations/org-1/competitors/competitor-1/ads?unknown=1',
    '/organizations/org-1/competitors/competitor-1/ads?limit=1&limit=2',
  ]) {
    const response = await app.inject({ method: 'GET', url, headers })
    assert.equal(response.statusCode, 400)
    assert.deepEqual(response.json(), { error: 'Invalid request' })
  }

  await app.close()
  await pool.end()
})
