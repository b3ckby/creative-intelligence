import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { DataType, newDb } from 'pg-mem'
import type { ManualMetaAdRecord } from '../src/ad-ingestion/manual-meta-ads-provider.ts'
import { PostgresManualAdImportService } from '../src/persistence/postgres-manual-ad-import-service.ts'

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
  assert.match(String(rejected.reason), /already belongs to another product or competitor/i)
  const stored = await pool.query(`SELECT competitor_id FROM competitor_ads WHERE external_id = 'meta-shared'`)
  assert.equal(stored.rowCount, 1)
  await pool.end()
})
