import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { DataType, newDb } from 'pg-mem'

import { readPgMemMigration } from './helpers/pg-mem-migrations.ts'
import type { FastifyRequest } from 'fastify'
import { AuthenticationError, RateLimitError } from '../src/domain/errors.ts'
import { buildApi } from '../src/http/build-api.ts'

async function testApi(
  ids = ['org-1', 'product-1', 'competitor-1', 'ad-1'],
  authenticate?: (request: FastifyRequest) => Promise<string>,
  apifyFetch?: typeof fetch,
  stagingLogin?: { login(password: string, remoteAddress: string): Promise<string> },
  trustedProxies?: string[],
) {
  const db = newDb()
  db.public.registerFunction({ name: 'length', args: [DataType.text], returns: DataType.integer, implementation: (value: string) => value.length })
  db.public.registerFunction({ name: 'trim', args: [DataType.text], returns: DataType.text, implementation: (value: string) => value.trim() })
  db.public.registerFunction({ name: 'set_config', args: [DataType.text, DataType.text, DataType.bool], returns: DataType.text, implementation: (_key: string, value: string) => value })
  db.public.registerFunction({ name: 'jsonb_typeof', args: [DataType.jsonb], returns: DataType.text, implementation: (value: unknown) => Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value })
  db.public.registerFunction({ name: 'clock_timestamp', returns: DataType.timestamptz, implementation: () => new Date('2026-10-26T00:00:00.000Z') })
  const { Pool } = db.adapters.createPg()
  const pool = new Pool()
  await pool.query(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'))
  await pool.query(await readPgMemMigration(new URL('../migrations/006_ad_intelligence.sql', import.meta.url)))
  await pool.query(await readPgMemMigration(new URL('../migrations/008_brief_workflow.sql', import.meta.url)))
  await pool.query(await readFile(new URL('../migrations/003_provider_sync_limits.sql', import.meta.url), 'utf8'))
  const app = buildApi({
    pool,
    cursorSigningKey: 'test-cursor-signing-key-at-least-32-bytes',
    createId: () => ids.shift() ?? 'unexpected-id',
    now: () => new Date('2026-10-26T00:00:00.000Z'),
    authenticate: authenticate ?? (async (request) => {
      const userId = request.headers['x-user-id']
      if (typeof userId !== 'string') throw new Error('Authentication is required')
      return userId
    }),
    ...(stagingLogin ? { stagingLogin, stagingOrganizationId: 'staging-org' } : {}),
    ...(trustedProxies ? { trustedProxies } : {}),
    ...(apifyFetch ? { apify: {
      apiToken: 'fixture-apify-credential', timeoutMs: 1_000, maxResponseBytes: 100_000,
      limit: 10, countryCode: 'ALL', activeStatus: 'active' as const, maxConcurrency: 1, fetch: apifyFetch,
    } } : {}),
  })
  return { app, pool }
}

test('REST API persists organization, product, competitor, and manual Meta ad', async () => {
  const { app, pool } = await testApi()
  const auth = { 'x-user-id': 'admin-1' }

  const organization = await app.inject({ method: 'POST', url: '/organizations', headers: auth, payload: { name: 'Creative Team' } })
  assert.equal(organization.statusCode, 201)
  assert.equal(organization.json().id, 'org-1')

  const product = await app.inject({
    method: 'POST', url: '/organizations/org-1/products', headers: auth,
    payload: { name: 'Focus Timer', markets: ['US'], platforms: ['web'], targetAudiences: ['students'], uniqueSellingPoints: ['focus'] },
  })
  assert.equal(product.statusCode, 201)
  assert.equal(product.json().id, 'product-1')

  const competitor = await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/competitors', headers: auth,
    payload: { name: 'Study Buddy' },
  })
  assert.equal(competitor.statusCode, 201)

  const imported = await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/competitors/competitor-1/ads/manual-meta', headers: auth,
    payload: { records: [{
      externalId: 'meta-1', advertiserName: 'Study Buddy', body: 'Focus now',
      startedAt: '2026-10-01', isActive: true, mediaUrls: [],
      sourceUrl: 'https://www.facebook.com/ads/library/?id=meta-1',
    }] },
  })
  assert.equal(imported.statusCode, 200)
  assert.deepEqual(imported.json(), { inserted: 1, duplicates: 0 })

  const ads = await app.inject({
    method: 'GET', url: '/organizations/org-1/competitors/competitor-1/ads', headers: auth,
  })
  assert.equal(ads.statusCode, 200)
  assert.equal(ads.json().items.length, 1)
  assert.equal(ads.json().items[0].providerName, 'manual-meta')
  assert.equal(ads.json().items[0].startedAt, '2026-10-01T00:00:00.000Z')
  assert.equal(ads.json().nextCursor, null)

  await app.close()
  await pool.end()
})

test('REST API synchronizes a competitor through the configured Apify actor', async () => {
  const { app, pool } = await testApi(['org-1', 'product-1', 'competitor-1', 'ad-1'], undefined, async () => new Response(JSON.stringify([{
    ad_archive_id: 'apify-1', page_name: 'Study Buddy', is_active: true, start_date: 1760227200,
    snapshot: { body: { text: 'Focus from Apify' }, images: [] },
  }]), { status: 200, headers: { 'content-type': 'application/json' } }))
  const auth = { 'x-user-id': 'admin-1' }
  await app.inject({ method: 'POST', url: '/organizations', headers: auth, payload: { name: 'Creative Team' } })
  await app.inject({
    method: 'POST', url: '/organizations/org-1/products', headers: auth,
    payload: { name: 'Focus Timer', markets: ['US'], platforms: ['web'], targetAudiences: ['students'], uniqueSellingPoints: ['focus'] },
  })
  await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/competitors', headers: auth,
    payload: { name: 'Study Buddy', metaPageUrl: 'https://www.facebook.com/studybuddy' },
  })

  const response = await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/competitors/competitor-1/ads/apify-meta/sync', headers: auth,
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { inserted: 1, duplicates: 0 })
  const stored = await pool.query(`SELECT provider_name, external_id FROM competitor_ads`)
  assert.deepEqual(stored.rows, [{ provider_name: 'apify-meta-ads', external_id: 'apify-1' }])
  await app.close()
  await pool.end()
})

test('REST API coalesces concurrent sync requests for the same competitor', async () => {
  let apifyCalls = 0
  let release: (() => void) | undefined
  const pending = new Promise<void>((resolve) => { release = resolve })
  const apifyFetch: typeof fetch = async () => {
    apifyCalls += 1
    await pending
    return new Response(JSON.stringify([{
      ad_archive_id: 'apify-1', page_name: 'Study Buddy', is_active: true, start_date: 1760227200,
      snapshot: { body: { text: 'Focus from Apify' }, images: [] },
    }]), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const { app, pool } = await testApi(['org-1', 'product-1', 'competitor-1', 'ad-1'], undefined, apifyFetch)
  const auth = { 'x-user-id': 'admin-1' }
  await app.inject({ method: 'POST', url: '/organizations', headers: auth, payload: { name: 'Creative Team' } })
  await app.inject({ method: 'POST', url: '/organizations/org-1/products', headers: auth, payload: { name: 'Focus Timer', markets: [], platforms: ['web'], targetAudiences: [], uniqueSellingPoints: [] } })
  await app.inject({ method: 'POST', url: '/organizations/org-1/products/product-1/competitors', headers: auth, payload: { name: 'Study Buddy', metaPageUrl: 'https://www.facebook.com/studybuddy' } })
  const request = { method: 'POST' as const, url: '/organizations/org-1/products/product-1/competitors/competitor-1/ads/apify-meta/sync', headers: auth }

  const first = app.inject(request)
  const second = app.inject(request)
  while (apifyCalls === 0) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(apifyCalls, 1)
  release?.()
  const responses = await Promise.all([first, second])
  assert.ok(responses.every((response) => response.statusCode === 200))
  assert.equal(apifyCalls, 1)
  await app.close()
  await pool.end()
})

test('REST API durably rate-limits sequential paid Apify syncs', async () => {
  let apifyCalls = 0
  const apifyFetch: typeof fetch = async () => {
    apifyCalls += 1
    return new Response(JSON.stringify([{
      ad_archive_id: 'apify-1', page_name: 'Study Buddy', is_active: true, start_date: 1760227200,
      snapshot: { body: { text: 'Focus from Apify' }, images: [] },
    }]), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const { app, pool } = await testApi(['org-1', 'product-1', 'competitor-1', 'ad-1'], undefined, apifyFetch)
  const auth = { 'x-user-id': 'admin-1' }
  await app.inject({ method: 'POST', url: '/organizations', headers: auth, payload: { name: 'Creative Team' } })
  await app.inject({ method: 'POST', url: '/organizations/org-1/products', headers: auth, payload: { name: 'Focus Timer', markets: [], platforms: ['web'], targetAudiences: [], uniqueSellingPoints: [] } })
  await app.inject({ method: 'POST', url: '/organizations/org-1/products/product-1/competitors', headers: auth, payload: { name: 'Study Buddy', metaPageUrl: 'https://www.facebook.com/studybuddy' } })
  const request = { method: 'POST' as const, url: '/organizations/org-1/products/product-1/competitors/competitor-1/ads/apify-meta/sync', headers: auth }

  const first = await app.inject(request)
  const limited = await app.inject(request)

  assert.equal(first.statusCode, 200)
  assert.equal(limited.statusCode, 409)
  assert.deepEqual(limited.json(), { error: 'Resource conflict' })
  assert.equal(apifyCalls, 1)
  await app.close()
  await pool.end()
})

test('REST API rejects non-Facebook competitor sync URLs as a fixed 400 before calling Apify', async () => {
  let apifyCalls = 0
  const apifyFetch: typeof fetch = async () => { apifyCalls += 1; throw new Error('must not be called') }
  const { app, pool } = await testApi(['org-1', 'product-1', 'competitor-1'], undefined, apifyFetch)
  const auth = { 'x-user-id': 'admin-1' }
  await app.inject({ method: 'POST', url: '/organizations', headers: auth, payload: { name: 'Creative Team' } })
  await app.inject({
    method: 'POST', url: '/organizations/org-1/products', headers: auth,
    payload: { name: 'Focus Timer', markets: [], platforms: ['web'], targetAudiences: [], uniqueSellingPoints: [] },
  })
  await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/competitors', headers: auth,
    payload: { name: 'Study Buddy', metaPageUrl: 'https://example.com/studybuddy' },
  })

  const response = await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/competitors/competitor-1/ads/apify-meta/sync', headers: auth,
  })
  assert.equal(response.statusCode, 400)
  assert.deepEqual(response.json(), { error: 'Competitor Meta page URL is invalid' })
  assert.equal(apifyCalls, 0)
  await app.close()
  await pool.end()
})

test('REST schemas preserve domain canonical URL semantics', async () => {
  const { app, pool } = await testApi()
  const auth = { 'x-user-id': 'admin-1' }
  const organization = await app.inject({
    method: 'POST', url: '/organizations', headers: auth, payload: { name: 'Team' },
  })
  assert.equal(organization.statusCode, 201)
  await app.inject({
    method: 'POST', url: '/organizations/org-1/products', headers: auth,
    payload: { name: 'Product', markets: [], platforms: ['web'], targetAudiences: [], uniqueSellingPoints: [] },
  })
  const competitor = await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/competitors', headers: auth,
    payload: { name: 'Competitor', metaPageUrl: 'https://münich.example/%zz' },
  })
  assert.equal(competitor.statusCode, 201)
  await app.close()
  await pool.end()
})

test('REST API returns sanitized conflict errors', async () => {
  const { app, pool } = await testApi(['org-1', 'product-1', 'product-1'])
  const auth = { 'x-user-id': 'admin-1' }
  await app.inject({ method: 'POST', url: '/organizations', headers: auth, payload: { name: 'Creative Team' } })
  const payload = { name: 'Product', markets: [], platforms: ['web'], targetAudiences: [], uniqueSellingPoints: [] }
  await app.inject({ method: 'POST', url: '/organizations/org-1/products', headers: auth, payload })

  const conflict = await app.inject({ method: 'POST', url: '/organizations/org-1/products', headers: auth, payload })
  assert.equal(conflict.statusCode, 409)
  assert.deepEqual(conflict.json(), { error: 'Resource conflict' })

  await app.close()
  await pool.end()
})

test('REST API enforces authentication before request-schema validation', async () => {
  const { app, pool } = await testApi()
  const response = await app.inject({ method: 'POST', url: '/organizations', payload: { unexpected: true } })
  assert.equal(response.statusCode, 401)
  assert.deepEqual(response.json(), { error: 'Authentication is required' })
  await app.close()
  await pool.end()
})

test('REST API preserves normalized member identifiers accepted by the domain', async () => {
  const { app, pool } = await testApi()
  const auth = { 'x-user-id': 'admin-1' }
  await app.inject({ method: 'POST', url: '/organizations', headers: auth, payload: { name: 'Creative Team' } })
  const response = await app.inject({
    method: 'POST',
    url: '/organizations/org-1/members',
    headers: auth,
    payload: { userId: '  member-1  ', role: 'member' },
  })
  assert.equal(response.statusCode, 204)
  await app.close()
  await pool.end()
})

test('REST API enforces authentication and organization membership', async () => {
  const { app, pool } = await testApi()
  await app.inject({ method: 'POST', url: '/organizations', headers: { 'x-user-id': 'admin-1' }, payload: { name: 'Creative Team' } })

  const unauthenticated = await app.inject({ method: 'GET', url: '/organizations/org-1/products' })
  assert.equal(unauthenticated.statusCode, 401)

  const outsider = await app.inject({
    method: 'GET', url: '/organizations/org-1/products', headers: { 'x-user-id': 'outsider' },
  })
  assert.equal(outsider.statusCode, 403)

  await app.close()
  await pool.end()
})

test('REST API sanitizes not-found and unsupported media-type responses', async () => {
  const { app, pool } = await testApi()

  const missing = await app.inject({ method: 'GET', url: '/private/missing/path?secret=value' })
  assert.equal(missing.statusCode, 404)
  assert.deepEqual(missing.json(), { error: 'Not found' })
  assert.doesNotMatch(missing.body, /private|missing|secret|Fastify/i)

  const unsupportedMethod = await app.inject({ method: 'DELETE', url: '/organizations/org-1/products' })
  assert.equal(unsupportedMethod.statusCode, 404)
  assert.deepEqual(unsupportedMethod.json(), { error: 'Not found' })

  const mediaType = await app.inject({
    method: 'POST',
    url: '/organizations',
    headers: { 'content-type': 'application/xml', 'x-user-id': 'admin-1' },
    payload: '<name>Team</name>',
  })
  assert.equal(mediaType.statusCode, 415)
  assert.deepEqual(mediaType.json(), { error: 'Unsupported media type' })

  await app.close()
  await pool.end()
})

test('REST API sanitizes malformed and oversized HTTP request errors', async () => {
  const { app, pool } = await testApi()

  const malformed = await app.inject({
    method: 'POST',
    url: '/organizations',
    headers: { 'content-type': 'application/json', 'x-user-id': 'admin-1' },
    payload: '{"name":',
  })
  assert.equal(malformed.statusCode, 400)
  assert.deepEqual(malformed.json(), { error: 'Invalid request' })

  const oversized = await app.inject({
    method: 'POST',
    url: '/organizations',
    headers: { 'content-type': 'application/json', 'x-user-id': 'admin-1' },
    payload: JSON.stringify({ name: 'x'.repeat(1_100_000) }),
  })
  assert.equal(oversized.statusCode, 413)
  assert.deepEqual(oversized.json(), { error: 'Payload too large' })

  await app.close()
  await pool.end()
})

test('REST API never exposes authentication failure details', async () => {
  const { app, pool } = await testApi(undefined, async () => {
    throw new Error('identity provider rejected secret token abc123')
  })

  const response = await app.inject({ method: 'POST', url: '/organizations', payload: { name: 'Team' } })
  assert.equal(response.statusCode, 401)
  assert.deepEqual(response.json(), { error: 'Authentication is required' })
  assert.doesNotMatch(response.body, /identity provider|abc123/i)

  await app.close()
  await pool.end()
})

test('REST API returns a fixed validation error for unsafe provider URLs', async () => {
  const { app, pool } = await testApi()
  const auth = { 'x-user-id': 'admin-1' }
  await app.inject({ method: 'POST', url: '/organizations', headers: auth, payload: { name: 'Team' } })
  await app.inject({
    method: 'POST', url: '/organizations/org-1/products', headers: auth,
    payload: { name: 'Product', markets: [], platforms: ['web'], targetAudiences: [], uniqueSellingPoints: [] },
  })
  await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/competitors', headers: auth,
    payload: { name: 'Competitor' },
  })

  const response = await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/competitors/competitor-1/ads/manual-meta', headers: auth,
    payload: { records: [{
      externalId: 'meta-1', advertiserName: 'Competitor', body: 'Copy',
      startedAt: '2026-10-01T00:00:00.000Z', isActive: true, mediaUrls: [],
      sourceUrl: 'http://internal.example/ad',
    }] },
  })
  assert.equal(response.statusCode, 400)
  assert.deepEqual(response.json(), { error: 'Invalid manual ad records' })
  assert.doesNotMatch(response.body, /HTTPS|internal\.example/i)

  await app.close()
  await pool.end()
})

test('schema validation never coerces request-body domain values', async () => {
  const { app, pool } = await testApi()
  const auth = { 'x-user-id': 'admin-1' }
  await app.inject({ method: 'POST', url: '/organizations', headers: auth, payload: { name: 'Team' } })
  await app.inject({
    method: 'POST', url: '/organizations/org-1/products', headers: auth,
    payload: { name: 'Product', markets: [], platforms: ['web'], targetAudiences: [], uniqueSellingPoints: [] },
  })
  await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/competitors', headers: auth,
    payload: { name: 'Competitor' },
  })

  const response = await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/competitors/competitor-1/ads/manual-meta', headers: auth,
    payload: { records: [{
      externalId: 'meta-1', advertiserName: 'Competitor', body: 'Copy',
      startedAt: '2026-10-01T00:00:00.000Z', isActive: 'true', mediaUrls: [],
      sourceUrl: 'https://example.test/ad',
    }] },
  })
  assert.equal(response.statusCode, 400)
  assert.deepEqual(response.json(), { error: 'Invalid manual ad records' })

  await app.close()
  await pool.end()
})

test('staging password login returns a bearer token without invoking OIDC authentication', async () => {
  let oidcCalls = 0
  const loginCalls: Array<{ password: string; remoteAddress: string }> = []
  const { app, pool } = await testApi(
    undefined,
    async () => { oidcCalls += 1; throw new Error('must not authenticate the login route') },
    undefined,
    {
      login: async (password, remoteAddress) => {
        loginCalls.push({ password, remoteAddress })
        return 'signed.jwt.value'
      },
    },
    ['127.0.0.1'],
  )

  const response = await app.inject({
    method: 'POST',
    url: '/auth/staging-login',
    payload: { password: 'correct horse battery staple' },
    headers: { 'x-forwarded-for': '203.0.113.10' },
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { accessToken: 'signed.jwt.value', organizationId: 'staging-org' })
  assert.deepEqual(loginCalls, [{ password: 'correct horse battery staple', remoteAddress: '203.0.113.10' }])
  assert.equal(oidcCalls, 0)
  await app.close()
  await pool.end()
})

test('staging password login ignores forwarded addresses from untrusted peers', async () => {
  const remoteAddresses: string[] = []
  const { app, pool } = await testApi(
    undefined,
    async () => { throw new Error('OIDC should not be used') },
    undefined,
    { login: async (_password, remoteAddress) => {
      remoteAddresses.push(remoteAddress)
      return 'signed.jwt.value'
    } },
  )

  const response = await app.inject({
    method: 'POST',
    url: '/auth/staging-login',
    payload: { password: 'fixture password' },
    headers: { 'x-forwarded-for': '203.0.113.99' },
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(remoteAddresses, ['127.0.0.1'])
  await app.close()
  await pool.end()
})

test('staging password login fails closed when disabled or rejected without exposing password details', async () => {
  const disabled = await testApi()
  const unavailable = await disabled.app.inject({ method: 'POST', url: '/auth/staging-login', payload: { password: 'secret value' } })
  assert.equal(unavailable.statusCode, 404)
  assert.deepEqual(unavailable.json(), { error: 'Not found' })
  await disabled.app.close()
  await disabled.pool.end()

  for (const [failure, statusCode, publicMessage] of [
    [new AuthenticationError(), 401, 'Authentication is required'],
    [new RateLimitError(), 429, 'Too many login attempts'],
  ] as const) {
    const rejected = await testApi(undefined, undefined, undefined, { login: async () => { throw failure } })
    const response = await rejected.app.inject({ method: 'POST', url: '/auth/staging-login', payload: { password: 'secret value' } })
    assert.equal(response.statusCode, statusCode)
    assert.deepEqual(response.json(), { error: publicMessage })
    assert.doesNotMatch(response.body, /secret value/u)
    await rejected.app.close()
    await rejected.pool.end()
  }
})
