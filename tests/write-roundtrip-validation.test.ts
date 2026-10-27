import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

import { DataType, newDb } from 'pg-mem'
import type { FastifyRequest } from 'fastify'
import { buildApi } from '../src/http/build-api.ts'
import { CreativeIntelligence } from '../src/creative-intelligence.ts'
import { AD_BODY_MAX_LENGTH } from '../src/domain/types.ts'
import { OrganizationService } from '../src/organizations/organization-service.ts'
import { decodeAdRow } from '../src/persistence/catalog-row-decoders.ts'

async function testApi(ids = ['org-1', 'product-1', 'competitor-1', 'ad-1', 'brief-1']) {
  const db = newDb()
  db.public.registerFunction({ name: 'length', args: [DataType.text], returns: DataType.integer, implementation: (value: string) => value.length })
  db.public.registerFunction({ name: 'trim', args: [DataType.text], returns: DataType.text, implementation: (value: string) => value.trim() })
  db.public.registerFunction({ name: 'set_config', args: [DataType.text, DataType.text, DataType.bool], returns: DataType.text, implementation: (_key: string, value: string) => value })
  const { Pool } = db.adapters.createPg()
  const pool = new Pool()
  await pool.query(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'))
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

const headers = { 'x-user-id': 'admin-1' }
const productPayload = {
  name: 'Product', markets: ['US'], platforms: ['web'], targetAudiences: ['students'], uniqueSellingPoints: ['focus'],
}

async function seed(app: Awaited<ReturnType<typeof testApi>>['app']) {
  assert.equal((await app.inject({ method: 'POST', url: '/organizations', headers, payload: { name: 'Team' } })).statusCode, 201)
  assert.equal((await app.inject({ method: 'POST', url: '/organizations/org-1/products', headers, payload: productPayload })).statusCode, 201)
}

function assertFixed400(response: Awaited<ReturnType<Awaited<ReturnType<typeof testApi>>['app']['inject']>>) {
  assert.equal(response.statusCode, 400, response.body)
  assert.deepEqual(response.json(), { error: 'Invalid request' })
}

test('catalog and ad writes reject values that persisted decoders cannot read', async () => {
  const { app, pool } = await testApi()
  await seed(app)

  const invalidProductValues = [
    { ...productPayload, name: 'bad\nname' },
    { ...productPayload, markets: ['bad\u0085market'] },
    { ...productPayload, targetAudiences: ['x'.repeat(501)] },
    { ...productPayload, uniqueSellingPoints: Array.from({ length: 101 }, (_, index) => `usp-${index}`) },
  ]
  for (const payload of invalidProductValues) {
    assertFixed400(await app.inject({ method: 'POST', url: '/organizations/org-1/products', headers, payload }))
  }

  const unsafeCompetitorUrls = [
    'javascript:alert(1)',
    'https://user:secret@example.test/page',
    'https://example.test/page#fragment',
    ' https://example.test/page ',
  ]
  for (const metaPageUrl of unsafeCompetitorUrls) {
    assertFixed400(await app.inject({
      method: 'POST', url: '/organizations/org-1/products/product-1/competitors', headers,
      payload: { name: 'Competitor', metaPageUrl },
    }))
  }

  assert.equal((await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/competitors', headers,
    payload: { name: 'Competitor', metaPageUrl: 'https://example.test/page?ref=one' },
  })).statusCode, 201)

  const baseAd = {
    externalId: 'external-1', advertiserName: 'Advertiser', body: 'Body', callToAction: 'Install',
    startedAt: '2026-10-01T00:00:00.000Z', isActive: true,
    mediaUrls: ['https://cdn.example.test/ad.mp4'], sourceUrl: 'https://example.test/ad?id=1',
  }
  const invalidAds = [
    { ...baseAd, advertiserName: 'bad\nname' },
    { ...baseAd, body: 'bad\u0085body' },
    { ...baseAd, callToAction: 'bad\ncta' },
    { ...baseAd, mediaUrls: Array.from({ length: 51 }, (_, index) => `https://cdn.example.test/${index}.mp4`) },
    { ...baseAd, mediaUrls: ['https://user:secret@cdn.example.test/ad.mp4'] },
    { ...baseAd, mediaUrls: ['https://cdn.example.test/ad.mp4#fragment'] },
    { ...baseAd, sourceUrl: 'https://user:secret@example.test/ad' },
    { ...baseAd, sourceUrl: 'https://example.test/ad#fragment' },
  ]
  for (const record of invalidAds) {
    const response = await app.inject({
      method: 'POST', url: '/organizations/org-1/products/product-1/competitors/competitor-1/ads/manual-meta', headers,
      payload: { records: [record] },
    })
    assert.equal(response.statusCode, 400, response.body)
    assert.deepEqual(response.json(), { error: 'Invalid manual ad records' })
  }

  await app.close()
  await pool.end()
})

test('accepted product competitor and ad writes round-trip through persisted decoders', async () => {
  const { app, pool } = await testApi()
  await seed(app)
  const competitor = await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/competitors', headers,
    payload: { name: ' Competitor ', metaPageUrl: 'https://example.test/page?ref=one' },
  })
  assert.equal(competitor.statusCode, 201, competitor.body)
  const imported = await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/competitors/competitor-1/ads/manual-meta', headers,
    payload: { records: [{
      externalId: ' external-1 ', advertiserName: ' Advertiser ', body: ' Body ', callToAction: ' Install ',
      startedAt: '2026-10-01T00:00:00.000Z', isActive: true,
      mediaUrls: ['https://cdn.example.test/ad.mp4'], sourceUrl: 'https://example.test/ad?id=1',
    }] },
  })
  assert.equal(imported.statusCode, 200, imported.body)

  const productRead = await app.inject({ method: 'GET', url: '/organizations/org-1/products/product-1', headers })
  const competitorRead = await app.inject({ method: 'GET', url: '/organizations/org-1/products/product-1/competitors/competitor-1', headers })
  const adRead = await app.inject({ method: 'GET', url: '/organizations/org-1/competitors/competitor-1/ads', headers })
  assert.equal(productRead.statusCode, 200, productRead.body)
  assert.equal(competitorRead.statusCode, 200, competitorRead.body)
  assert.equal(adRead.statusCode, 200, adRead.body)
  assert.equal(adRead.json().items[0].externalId, 'external-1')
  assert.equal(adRead.json().items[0].advertiserName, 'Advertiser')
  assert.equal(adRead.json().items[0].body, 'Body')
  assert.equal(adRead.json().items[0].callToAction, 'Install')

  await app.close()
  await pool.end()
})

test('manual ad body uses one bounded max across HTTP database and persisted decoding', async () => {
  const { app, pool } = await testApi()
  await seed(app)
  assert.equal((await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/competitors', headers,
    payload: { name: 'Competitor' },
  })).statusCode, 201)
  const base = {
    advertiserName: 'Advertiser', startedAt: '2026-10-01T00:00:00.000Z', isActive: true,
    mediaUrls: [], sourceUrl: 'https://example.test/ad',
  }
  const accepted = await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/competitors/competitor-1/ads/manual-meta', headers,
    payload: { records: [{ ...base, externalId: 'at-max', body: 'B'.repeat(AD_BODY_MAX_LENGTH) }] },
  })
  assert.equal(accepted.statusCode, 200, accepted.body)
  const read = await app.inject({ method: 'GET', url: '/organizations/org-1/competitors/competitor-1/ads', headers })
  assert.equal(read.statusCode, 200, read.body)
  assert.equal(read.json().items[0].body.length, AD_BODY_MAX_LENGTH)

  const rejected = await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/competitors/competitor-1/ads/manual-meta', headers,
    payload: { records: [{ ...base, externalId: 'over-max', body: 'B'.repeat(AD_BODY_MAX_LENGTH + 1) }] },
  })
  assert.equal(rejected.statusCode, 400, rejected.body)

  const stored = (await pool.query('SELECT * FROM competitor_ads WHERE external_id = $1', ['at-max'])).rows[0]
  assert.equal(decodeAdRow(stored).body.length, AD_BODY_MAX_LENGTH)
  assert.throws(() => decodeAdRow({ ...stored, body: 'B'.repeat(AD_BODY_MAX_LENGTH + 1) }), /data-integrity/i)
  await assert.rejects(pool.query(
    `UPDATE competitor_ads SET body = $1 WHERE external_id = 'at-max'`,
    ['B'.repeat(AD_BODY_MAX_LENGTH + 1)],
  ))

  await app.close()
  await pool.end()
})

test('brief writes reject decoder-incompatible title hook and call-to-action before insert', async () => {
  const { app, pool } = await testApi(['org-1', 'product-1', 'brief-unused'])
  await seed(app)
  const dimensions = { audience: 'students', market: 'US', angle: 'focus', format: 'video' }
  const invalid = [
    { title: 'bad\nname', hook: 'Hook' },
    { title: 'Brief', hook: 'bad\u0085hook' },
    { title: 'Brief', hook: 'x'.repeat(20_001) },
    { title: 'Brief', hook: 'Hook', callToAction: 'bad\ncta' },
    { title: 'Brief', hook: 'Hook', callToAction: 'x'.repeat(101) },
  ]
  for (const fields of invalid) {
    const before = await pool.query('SELECT count(*)::int AS count FROM creative_briefs')
    const response = await app.inject({
      method: 'POST', url: '/organizations/org-1/products/product-1/briefs', headers,
      payload: { ...fields, dimensions },
    })
    assertFixed400(response)
    const after = await pool.query('SELECT count(*)::int AS count FROM creative_briefs')
    assert.equal(after.rows[0].count, before.rows[0].count)
  }
  await app.close()
  await pool.end()
})

test('accepted manual brief writes round-trip through the persisted decoder at exact limits', async () => {
  const { app, pool } = await testApi(['org-1', 'product-1', 'brief-1'])
  await seed(app)
  const payload = {
    title: 'T'.repeat(500), hook: 'H'.repeat(20_000), callToAction: 'C'.repeat(100),
    dimensions: { audience: 'students', market: 'US', angle: 'focus', format: 'video' },
  }
  const created = await app.inject({ method: 'POST', url: '/organizations/org-1/products/product-1/briefs', headers, payload })
  assert.equal(created.statusCode, 201, created.body)
  const read = await app.inject({ method: 'GET', url: '/organizations/org-1/briefs/brief-1', headers })
  assert.equal(read.statusCode, 200, read.body)
  assert.equal(read.json().title.length, 500)
  assert.equal(read.json().hook.length, 20_000)
  assert.equal(read.json().callToAction.length, 100)
  await app.close()
  await pool.end()
})

test('all non-HTTP write paths apply the same canonical resource validators', async () => {
  const intelligence = CreativeIntelligence.inMemory()
  assert.throws(() => intelligence.products.create({
    organizationId: 'org-1', name: 'bad\nname', markets: [], platforms: ['web'], targetAudiences: [], uniqueSellingPoints: [],
  }), /invalid/i)
  assert.throws(() => intelligence.products.create({
    organizationId: 'org-1', name: 'Product', markets: ['bad\u0085market'], platforms: ['web'], targetAudiences: [], uniqueSellingPoints: [],
  }), /invalid/i)

  const product = intelligence.products.create({
    organizationId: 'org-1', name: 'Product', markets: [], platforms: ['web'], targetAudiences: [], uniqueSellingPoints: [],
  })
  assert.throws(() => intelligence.competitors.create({
    organizationId: 'org-1', productId: product.id, name: 'Competitor', metaPageUrl: 'javascript:alert(1)',
  }), /HTTPS|invalid/i)

  let saved = false
  const organizations = new OrganizationService({
    async createWithAdmin() { saved = true },
    async findRole() { return undefined },
    async saveMemberAsAdmin() {},
    async removeMemberAsAdmin() {},
  }, () => 'org-id', () => new Date('2026-10-26T00:00:00.000Z'))
  await assert.rejects(() => organizations.create({ name: 'bad\nname', actorUserId: 'admin' }), /invalid/i)
  assert.equal(saved, false)
})
