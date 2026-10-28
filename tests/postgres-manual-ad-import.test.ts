import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { DataType, newDb } from 'pg-mem'

import { readPgMemMigration, readPgMemPoint3AdEvolution } from './helpers/pg-mem-migrations.ts'
import type { ManualMetaAdRecord } from '../src/ad-ingestion/manual-meta-ads-provider.ts'
import type { AdSourceProvider, CollectedAd } from '../src/ad-ingestion/ad-source-provider.ts'
import { ConflictError, ExternalProviderError } from '../src/domain/errors.ts'
import { PostgresManualAdImportService } from '../src/persistence/postgres-manual-ad-import-service.ts'
import { PostgresProviderAdImportService } from '../src/persistence/postgres-provider-ad-import-service.ts'

const record: ManualMetaAdRecord = {
  externalId: 'meta-shared',
  advertiserName: 'Competitor',
  body: 'Copy',
  startedAt: '2026-10-01T00:00:00.000Z',
  isActive: true,
  mediaUrls: [],
  sourceUrl: 'https://example.com/ad',
}

async function database() {
  const db = newDb()
  db.public.registerFunction({ name: 'length', args: [DataType.text], returns: DataType.integer, implementation: (value: string) => value.length })
  db.public.registerFunction({ name: 'trim', args: [DataType.text], returns: DataType.text, implementation: (value: string) => value.trim() })
  db.public.registerFunction({ name: 'set_config', args: [DataType.text, DataType.text, DataType.bool], returns: DataType.text, implementation: (_key: string, value: string) => value })
  const { Pool } = db.adapters.createPg()
  const pool = new Pool()
  await pool.query(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'))
  await pool.query(await readPgMemMigration(new URL('../migrations/006_ad_intelligence.sql', import.meta.url)))
  await pool.query(await readPgMemPoint3AdEvolution())
  await pool.query(`
    INSERT INTO organizations (id, name) VALUES ('org-1', 'One');
    INSERT INTO products (id, organization_id, name) VALUES ('product-1', 'org-1', 'Product');
    INSERT INTO competitors (id, organization_id, product_id, name) VALUES
      ('competitor-1', 'org-1', 'product-1', 'One'),
      ('competitor-2', 'org-1', 'product-1', 'Two');
  `)
  return pool
}

test('re-import remains a duplicate when generated ID equals the stored row ID', async () => {
  const pool = await database()
  const imports = new PostgresManualAdImportService(
    pool,
    () => 'ad-same',
    () => new Date('2026-10-26T00:00:00.000Z'),
  )
  const context = { organizationId: 'org-1', productId: 'product-1', competitorId: 'competitor-1' }

  assert.deepEqual(await imports.import('user-1', context, [record]), { inserted: 1, duplicates: 0 })
  assert.deepEqual(await imports.import('user-1', context, [record]), { inserted: 0, duplicates: 1 })

  await pool.end()
})

test('concurrent manual imports for the same context are idempotent', async () => {
  const pool = await database()
  const ids = ['ad-1', 'ad-2']
  const imports = new PostgresManualAdImportService(
    pool,
    () => ids.shift() ?? 'unexpected',
    () => new Date('2026-10-26T00:00:00.000Z'),
  )
  const context = { organizationId: 'org-1', productId: 'product-1', competitorId: 'competitor-1' }

  const results = await Promise.all([imports.import('user-1', context, [record]), imports.import('user-1', context, [record])])
  assert.deepEqual(results.sort((a, b) => a.inserted - b.inserted), [
    { inserted: 0, duplicates: 1 },
    { inserted: 1, duplicates: 0 },
  ])
  const stored = await pool.query(`SELECT id FROM competitor_ads WHERE external_id = 'meta-shared'`)
  assert.equal(stored.rowCount, 1)
  await pool.end()
})

test('concurrent manual imports reject reuse by another competitor', async () => {
  const pool = await database()
  const ids = ['ad-1', 'ad-2']
  const imports = new PostgresManualAdImportService(
    pool,
    () => ids.shift() ?? 'unexpected',
    () => new Date('2026-10-26T00:00:00.000Z'),
  )
  const first = { organizationId: 'org-1', productId: 'product-1', competitorId: 'competitor-1' }
  const second = { organizationId: 'org-1', productId: 'product-1', competitorId: 'competitor-2' }

  const outcomes = await Promise.allSettled([
    imports.import('user-1', first, [record]),
    imports.import('user-1', second, [record]),
  ])
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
  const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
  assert.ok(rejected)
  assert.ok(rejected.reason instanceof ConflictError)
  assert.match(String(rejected.reason), /already belongs to another product or competitor/i)
  const stored = await pool.query(`SELECT competitor_id FROM competitor_ads WHERE external_id = 'meta-shared'`)
  assert.equal(stored.rowCount, 1)
  await pool.end()
})

test('generic provider imports atomically under its trusted registry namespace', async () => {
  const pool = await database()
  const imports = new PostgresProviderAdImportService(pool, () => 'ad-apify', () => new Date('2026-10-26T00:00:00.000Z'))
  const item: CollectedAd = {
    platform: 'meta', externalId: 'apify-1', advertiserName: 'Orbit', body: 'Copy', callToAction: null,
    startedAt: '2026-10-01T00:00:00.000Z', isActive: true, mediaUrls: [], sourceUrl: 'https://example.com/ad',
  }
  const provider: AdSourceProvider = { collect: async () => [item] }

  assert.deepEqual(await imports.import('user-1', 'apify-meta-ads', { organizationId: 'org-1', productId: 'product-1', competitorId: 'competitor-1' }, provider), { inserted: 1, duplicates: 0 })
  const apifyStored = await pool.query(`SELECT provider_name FROM competitor_ads WHERE external_id = 'apify-1'`)
  assert.equal(apifyStored.rows[0]?.provider_name, 'apify-meta-ads')
  await pool.end()
})

test('generic provider persists expanded nullable metadata and structured media', async () => {
  const pool = await database()
  const imports = new PostgresProviderAdImportService(pool, () => 'ad-expanded', () => new Date('2026-10-26T00:00:00.000Z'))
  const item: CollectedAd = {
    platform: 'meta', externalId: 'expanded-1', pageId: 'page-1', advertiserName: 'Orbit', body: 'Copy',
    headline: 'Headline', description: 'Description', callToAction: null, displayFormat: 'VIDEO', adType: 'video',
    startedAt: '2026-10-01T00:00:00.000Z', endedAt: '2026-10-02T00:00:00.000Z', isActive: false,
    publisherPlatforms: ['facebook'], impressionsLowerBound: 100, impressionsUpperBound: 200,
    spendLowerBound: 12.5, spendUpperBound: 20, currency: 'USD',
    media: [{ kind: 'video', sourceUrl: 'https://cdn.example.test/ad.mp4', posterUrl: null, cardIndex: null, order: 0 }],
    mediaUrls: ['https://cdn.example.test/ad.mp4'], sourceUrl: 'https://example.com/ad',
  }

  await imports.import('user-1', 'apify-meta-ads', { organizationId: 'org-1', productId: 'product-1', competitorId: 'competitor-1' }, { collect: async () => [item] })

  const stored = (await pool.query(`SELECT * FROM competitor_ads WHERE external_id = 'expanded-1'`)).rows[0]
  assert.equal(stored.page_id, 'page-1')
  assert.equal(stored.headline, 'Headline')
  assert.equal(stored.description, 'Description')
  assert.equal(stored.display_format, 'VIDEO')
  assert.equal(stored.ad_type, 'video')
  assert.equal(stored.ended_at.toISOString(), '2026-10-02T00:00:00.000Z')
  assert.deepEqual(stored.publisher_platforms, ['facebook'])
  assert.equal(Number(stored.impressions_lower_bound), 100)
  assert.equal(Number(stored.impressions_upper_bound), 200)
  assert.equal(Number(stored.spend_lower_bound), 12.5)
  assert.equal(Number(stored.spend_upper_bound), 20)
  assert.equal(stored.currency, 'USD')
  assert.deepEqual(stored.media, item.media)
  await pool.end()
})

test('generic provider validates the complete batch before any write', async () => {
  const pool = await database()
  const imports = new PostgresProviderAdImportService(pool, () => 'unused', () => new Date('2026-10-26T00:00:00.000Z'))
  const valid: CollectedAd = {
    platform: 'meta', externalId: 'valid', advertiserName: 'Orbit', body: 'Copy', callToAction: null,
    startedAt: '2026-10-01T00:00:00.000Z', isActive: true, mediaUrls: [], sourceUrl: 'https://example.com/ad',
  }
  const provider = { collect: async () => [valid, { ...valid, externalId: '' }] } as AdSourceProvider

  await assert.rejects(imports.import('user-1', 'apify-meta-ads', { organizationId: 'org-1', productId: 'product-1', competitorId: 'competitor-1' }, provider), /Provider returned invalid data/)
  const invalidStored = await pool.query(`SELECT id FROM competitor_ads`)
  assert.equal(invalidStored.rowCount, 0)
  await pool.end()
})

test('complete snapshots retire missing ads atomically and later upserts reactivate them', async () => {
  const pool = await database()
  let nextId = 0
  let now = new Date('2026-10-26T00:00:00.000Z')
  const imports = new PostgresProviderAdImportService(pool, () => `snapshot-${++nextId}`, () => now)
  const context = { organizationId: 'org-1', productId: 'product-1', competitorId: 'competitor-1' }
  const first: CollectedAd = { platform: 'meta', externalId: 'one', advertiserName: 'Orbit', body: 'One', callToAction: null, startedAt: '2026-10-01T00:00:00.000Z', isActive: true, mediaUrls: [], sourceUrl: 'https://example.com/one' }
  const second = { ...first, externalId: 'two', body: 'Two', sourceUrl: 'https://example.com/two' }
  const complete = (items: CollectedAd[]): AdSourceProvider => ({ collect: async () => items, collectSnapshot: async () => ({ items, completeness: 'complete', scopeKey: 'apify-meta-ads:v1:country=ALL;active=all' }) })

  await imports.importWithDetails('user-1', 'apify-meta-ads', context, complete([first, second]))
  now = new Date('2026-10-27T00:00:00.000Z')
  assert.deepEqual(await imports.importWithDetails('user-1', 'apify-meta-ads', context, complete([first])), { inserted: 0, duplicates: 1, retired: 1, complete: true })
  let missing = (await pool.query(`SELECT is_active, ended_at FROM competitor_ads WHERE external_id='two'`)).rows[0]
  assert.equal(missing.is_active, false)
  assert.equal(missing.ended_at.toISOString(), '2026-10-27T00:00:00.000Z')

  now = new Date('2026-10-28T00:00:00.000Z')
  await imports.importWithDetails('user-1', 'apify-meta-ads', context, complete([first, second]))
  missing = (await pool.query(`SELECT is_active, ended_at FROM competitor_ads WHERE external_id='two'`)).rows[0]
  assert.equal(missing.is_active, true)
  assert.equal(missing.ended_at, null)
  await pool.end()
})

test('complete snapshots retire only ads attested by the exact canonical scope', async () => {
  const pool = await database()
  let id = 0
  const imports = new PostgresProviderAdImportService(pool, () => `scope-${++id}`, () => new Date('2026-10-27T00:00:00.000Z'))
  const context = { organizationId: 'org-1', productId: 'product-1', competitorId: 'competitor-1' }
  const item = (externalId: string): CollectedAd => ({ platform: 'meta', externalId, advertiserName: 'Orbit', body: externalId, callToAction: null, startedAt: '2026-10-01T00:00:00.000Z', isActive: true, mediaUrls: [], sourceUrl: `https://example.com/${externalId}` })
  const complete = (scopeKey: string, items: CollectedAd[]): AdSourceProvider => ({ collect: async () => items, collectSnapshot: async () => ({ items, completeness: 'complete', scopeKey }) })
  const allScope = 'apify-meta-ads:v1:country=ALL;active=all'
  const usScope = 'apify-meta-ads:v1:country=US;active=active'
  await imports.importWithDetails('user-1', 'apify-meta-ads', context, complete(allScope, [item('all-ad')]))
  await imports.importWithDetails('user-1', 'apify-meta-ads', context, complete(usScope, [item('us-ad')]))
  await imports.importWithDetails('user-1', 'apify-meta-ads', context, complete(usScope, []))
  const rows = await pool.query(`SELECT external_id,is_active,snapshot_scope_key FROM competitor_ads ORDER BY external_id`)
  assert.deepEqual(rows.rows.map((row: any) => [row.external_id, row.is_active, row.snapshot_scope_key]), [
    ['all-ad', true, allScope], ['us-ad', false, usScope],
  ])
  await pool.end()
})

test('partial snapshots never retire missing ads', async () => {
  const pool = await database()
  let id = 0
  const imports = new PostgresProviderAdImportService(pool, () => `partial-${++id}`, () => new Date('2026-10-26T00:00:00.000Z'))
  const context = { organizationId: 'org-1', productId: 'product-1', competitorId: 'competitor-1' }
  const item: CollectedAd = { platform: 'meta', externalId: 'kept', advertiserName: 'Orbit', body: 'One', callToAction: null, startedAt: '2026-10-01T00:00:00.000Z', isActive: true, mediaUrls: [], sourceUrl: 'https://example.com/one' }
  await imports.importWithDetails('user-1', 'apify-meta-ads', context, { collect: async () => [item] })
  await imports.importWithDetails('user-1', 'apify-meta-ads', context, { collect: async () => [] })
  assert.equal((await pool.query(`SELECT is_active FROM competitor_ads WHERE external_id='kept'`)).rows[0].is_active, true)
  await pool.end()
})

test('generic provider converts upstream failures to one fixed public error', async () => {
  const pool = await database()
  const imports = new PostgresProviderAdImportService(pool, () => 'unused', () => new Date())
  const provider: AdSourceProvider = { collect: async () => { throw new Error('secret upstream URL and credential') } }
  await assert.rejects(
    imports.import('user-1', 'apify-meta-ads', { organizationId: 'org-1', productId: 'product-1', competitorId: 'competitor-1' }, provider),
    (error: unknown) => error instanceof ExternalProviderError && error.publicMessage === 'Ad provider is unavailable' && !error.message.includes('secret'),
  )
  await pool.end()
})
