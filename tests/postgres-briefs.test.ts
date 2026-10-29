import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

import { DataType, newDb } from 'pg-mem'
import { ApplicationError, ConflictError, ValidationError } from '../src/domain/errors.ts'
import { briefFromRow, PostgresBriefRepository, type BriefRow } from '../src/persistence/postgres-brief-repository.ts'
import type { SqlConnection, SqlPool } from '../src/persistence/postgres-organization-repository.ts'
import { readPgMemMigration } from './helpers/pg-mem-migrations.ts'

async function database() {
  const db = newDb()
  db.public.registerFunction({ name: 'length', args: [DataType.text], returns: DataType.integer, implementation: (value: string) => value.length })
  db.public.registerFunction({ name: 'trim', args: [DataType.text], returns: DataType.text, implementation: (value: string) => value.trim() })
  db.public.registerFunction({ name: 'set_config', args: [DataType.text, DataType.text, DataType.bool], returns: DataType.text, implementation: (_key: string, value: string) => value })
  db.public.registerFunction({ name: 'jsonb_typeof', args: [DataType.jsonb], returns: DataType.text, implementation: (value: unknown) => Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value })
  const { Pool } = db.adapters.createPg()
  const pool = new Pool()
  await pool.query(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'))
  await pool.query(await readPgMemMigration(new URL('../migrations/008_brief_workflow.sql', import.meta.url)))
  await pool.query(await readPgMemMigration(new URL('../migrations/014_ai_briefs_production_handoff.sql', import.meta.url)))
  await pool.query(`
    INSERT INTO organizations (id, name) VALUES ('org-1', 'One'), ('org-2', 'Two');
    INSERT INTO organization_members (organization_id, user_id, role) VALUES
      ('org-1', 'user-1', 'admin'), ('org-2', 'user-2', 'admin');
    INSERT INTO products (id, organization_id, name) VALUES
      ('product-1', 'org-1', 'Product One'),
      ('product-2', 'org-2', 'Product Two');
    INSERT INTO competitors (id, organization_id, product_id, name) VALUES
      ('competitor-1', 'org-1', 'product-1', 'Competitor One'),
      ('competitor-2', 'org-2', 'product-2', 'Competitor Two');
    INSERT INTO competitor_ads (
      id, ingestion_token, organization_id, product_id, competitor_id, provider_name,
      platform, external_id, advertiser_name, body, call_to_action, started_at,
      is_active, source_url, first_seen_at, last_seen_at
    ) VALUES
      ('ad-1', 'token-1', 'org-1', 'product-1', 'competitor-1', 'manual-meta',
       'meta', 'external-1', 'Advertiser', 'Source hook', 'Shop now', '2026-10-01',
       true, 'https://example.test/ad-1', '2026-10-01', '2026-10-01'),
      ('ad-2', 'token-2', 'org-2', 'product-2', 'competitor-2', 'manual-meta',
       'meta', 'external-2', 'Other', 'Private hook', null, '2026-10-01',
       true, 'https://example.test/ad-2', '2026-10-01', '2026-10-01');
  `)
  return pool
}

const dimensions = { audience: ' students ', market: ' US ', angle: ' focus ', format: ' video ' }

const storedBriefRow = {
  id: 'brief-1', organization_id: 'org-1', product_id: 'product-1', title: 'Brief', status: 'draft',
  source_ad_id: null, hook: '', call_to_action: null, created_at: new Date('2026-10-26T12:00:00.000Z'),
  updated_at: new Date('2026-10-26T12:00:00.000Z'), version: 1,
  dimensions: { audience: 'students', market: 'US', angle: 'focus', format: 'video' },
} satisfies BriefRow

test('persisted brief scalar fields and enums fail closed without normalizing identifiers', () => {
  const malformed: BriefRow[] = [
    { ...storedBriefRow, id: ' brief-1 ' },
    { ...storedBriefRow, organization_id: '' },
    { ...storedBriefRow, product_id: 42 as never },
    { ...storedBriefRow, title: '' },
    { ...storedBriefRow, status: 'invented' as never },
    { ...storedBriefRow, source_ad_id: ' ad-1 ' },
    { ...storedBriefRow, hook: 42 as never },
    { ...storedBriefRow, call_to_action: '' },
    { ...storedBriefRow, created_at: 'not-a-timestamp' },
    { ...storedBriefRow, cursor_created_at: 'not-a-cursor-timestamp' },
  ]
  for (const row of malformed) {
    assert.throws(() => briefFromRow(row), /Stored brief\..* failed data-integrity validation/)
  }
})

test('persisted brief dimensions fail closed with a fixed internal data-integrity error', () => {
  const malformed: unknown[] = [
    null,
    [],
    { audience: 'students', market: 'US', angle: 'focus' },
    { audience: 42, market: 'US', angle: 'focus', format: 'video' },
    { audience: 'bad\u0000value', market: 'US', angle: 'focus', format: 'video' },
    { audience: 'students', market: 'US', angle: 'focus', format: 'video', extra: 'bad' },
  ]

  for (const value of malformed) {
    assert.throws(
      () => briefFromRow({ ...storedBriefRow, dimensions: value } as BriefRow),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'Stored brief dimensions failed data-integrity validation')
        assert.equal(error instanceof ApplicationError, false)
        return true
      },
    )
  }
})

test('repository rejects malformed stored JSONB as an internal data-integrity failure', async () => {
  const pool = await database()
  await pool.query(`
    INSERT INTO creative_briefs (
      id, organization_id, product_id, title, status, hook, dimensions, created_at
    ) VALUES (
      'corrupt-brief', 'org-1', 'product-1', 'Corrupt', 'draft', '',
      '{"audience":"students","market":"US","angle":"focus"}'::jsonb,
      '2026-10-26T12:00:00Z'
    )
  `)
  const repository = new PostgresBriefRepository(pool, () => new Date(), () => 'unused')

  await assert.rejects(
    repository.pageForProduct('user-1', 'org-1', 'product-1', { limit: 100, includeArchived: true }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, 'Stored brief dimensions failed data-integrity validation')
      assert.equal(error instanceof ApplicationError, false)
      return true
    },
  )
  await pool.end()
})

test('maps brief insert constraint races to fixed typed application errors', async () => {
  const productRow = {
    id: 'product-1', organization_id: 'org-1', name: 'Product', markets: [], platforms: [],
    target_audiences: [], unique_selling_points: [], archived_at: null,
    created_at: new Date('2026-10-26T12:00:00.000Z'),
  }
  for (const [code, ErrorType, publicMessage] of [
    ['23503', ValidationError, 'Invalid request'],
    ['23514', ValidationError, 'Invalid request'],
    ['23505', ConflictError, 'Resource conflict'],
  ] as const) {
    const connection = {
      async query(text: string) {
        if (text.includes('FROM products')) return { rows: [productRow], rowCount: 1 }
        if (text.includes('INSERT INTO creative_briefs')) throw { code, detail: 'database details must not escape' }
        return { rows: [], rowCount: 0 }
      },
      release() {},
    } as SqlConnection
    const pool = {
      async connect() { return connection },
      async query() { return { rows: [], rowCount: 0 } },
    } as SqlPool
    const repository = new PostgresBriefRepository(pool, () => new Date(), () => 'brief-1')

    await assert.rejects(
      repository.createManual('user-1', {
        organizationId: 'org-1', productId: 'product-1', title: 'Brief', hook: '', dimensions,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ErrorType)
        assert.ok(error instanceof ApplicationError)
        assert.equal(error.statusCode, code === '23505' ? 409 : 400)
        assert.equal(error.publicMessage, publicMessage)
        assert.doesNotMatch(error.message, /database details/i)
        return true
      },
    )
  }
})

test('creates and deterministically lists a normalized manual brief', async () => {
  const pool = await database()
  const repository = new PostgresBriefRepository(
    pool,
    () => new Date('2026-10-26T12:00:00.000Z'),
    () => 'brief-1',
  )

  const created = await repository.createManual('user-1', {
    organizationId: 'org-1',
    productId: 'product-1',
    title: '  First brief  ',
    hook: '  Hook  ',
    callToAction: '  Install  ',
    dimensions,
  })

  assert.deepEqual(created, {
    id: 'brief-1',
    organizationId: 'org-1',
    productId: 'product-1',
    title: 'First brief',
    status: 'draft',
    sourceAdId: null,
    hook: 'Hook',
    callToAction: 'Install',
    dimensions: { audience: 'students', market: 'US', angle: 'focus', format: 'video' },
    version: 1,
    createdAt: '2026-10-26T12:00:00.000Z',
    updatedAt: '2026-10-26T12:00:00.000Z',
  })
  assert.deepEqual(await repository.pageForProduct('user-1', 'org-1', 'product-1', { limit: 100, includeArchived: true }), [created])
  await pool.end()
})

test('brief updates are optimistic, transition-safe, and append immutable versions', async () => {
  const pool = await database()
  let instant = new Date('2026-10-26T12:00:00.000Z')
  const repository = new PostgresBriefRepository(pool, () => instant, () => 'brief-versioned')
  const created = await repository.createManual('user-1', {
    organizationId: 'org-1', productId: 'product-1', title: 'Original', hook: 'Hook', dimensions,
  })
  assert.equal(created.version, 1)
  assert.equal(created.updatedAt, created.createdAt)

  instant = new Date('2026-10-26T13:00:00.000Z')
  const updated = await repository.update('user-1', 'org-1', created.id, {
    expectedVersion: 1, title: ' Revised ', status: 'triage', hook: ' New hook ', callToAction: null,
    dimensions: { audience: 'Founders', market: 'US', angle: 'Proof', format: 'Video' },
  })
  assert.equal(updated.version, 2)
  assert.equal(updated.title, 'Revised')
  assert.equal(updated.updatedAt, '2026-10-26T13:00:00.000Z')

  await assert.rejects(repository.update('user-1', 'org-1', created.id, {
    expectedVersion: 1, title: 'Stale', status: 'triage', hook: '', callToAction: null, dimensions: updated.dimensions,
  }), ConflictError)
  await assert.rejects(repository.update('user-1', 'org-1', created.id, {
    expectedVersion: 2, title: 'Skip', status: 'completed', hook: '', callToAction: null, dimensions: updated.dimensions,
  }), ValidationError)

  const versions = await repository.listVersions('user-1', 'org-1', created.id, 100)
  assert.deepEqual(versions.map(({ version, title, changedBy }) => ({ version, title, changedBy })), [
    { version: 2, title: 'Revised', changedBy: 'user-1' },
    { version: 1, title: 'Original', changedBy: 'user-1' },
  ])
  assert.equal(versions[0]?.createdAt, created.createdAt)
  assert.equal(versions[0]?.changedAt, '2026-10-26T13:00:00.000Z')
  await pool.end()
})

test('creates a brief from an owned ad and maps source fields', async () => {
  const pool = await database()
  const repository = new PostgresBriefRepository(
    pool,
    () => new Date('2026-10-26T13:00:00.000Z'),
    () => 'brief-from-ad',
  )

  const brief = await repository.createFromAd('user-1', {
    organizationId: 'org-1',
    productId: 'product-1',
    adId: 'ad-1',
    title: '  Adapt winner  ',
    dimensions,
  })

  assert.equal(brief.sourceAdId, 'ad-1')
  assert.equal(brief.hook, 'Source hook')
  assert.equal(brief.callToAction, 'Shop now')
  assert.deepEqual(await repository.findById('user-1', 'org-1', brief.id), brief)
  assert.equal(await repository.findById('user-1', 'org-2', brief.id), undefined)
  await pool.end()
})

test('rejects foreign products and ads without writing a brief', async () => {
  const pool = await database()
  const repository = new PostgresBriefRepository(pool, () => new Date(), () => 'must-not-save')

  await assert.rejects(repository.createManual('user-1', {
    organizationId: 'org-1', productId: 'product-2', title: 'Foreign', hook: '', dimensions,
  }), /product does not belong/i)
  await assert.rejects(repository.createFromAd('user-1', {
    organizationId: 'org-1', productId: 'product-1', adId: 'ad-2', title: 'Foreign', dimensions,
  }), /ad does not belong/i)
  assert.equal((await pool.query('SELECT id FROM creative_briefs')).rowCount, 0)
  await pool.end()
})

test('fails closed on generated ID collision and rolls back', async () => {
  const pool = await database()
  const repository = new PostgresBriefRepository(
    pool,
    () => new Date('2026-10-26T12:00:00.000Z'),
    () => 'brief-collision',
  )
  const input = {
    organizationId: 'org-1', productId: 'product-1', title: 'Original', hook: 'First', dimensions,
  }
  await repository.createManual('user-1', input)

  await assert.rejects(repository.createManual('user-1', { ...input, title: 'Replacement' }), /collision/i)
  const rows = await pool.query('SELECT title FROM creative_briefs WHERE id = $1', ['brief-collision'])
  assert.deepEqual(rows.rows, [{ title: 'Original' }])
  await pool.end()
})

test('validates a generated ID before persisting', async () => {
  const pool = await database()
  const repository = new PostgresBriefRepository(pool, () => new Date(), () => ' invalid-id ')

  await assert.rejects(repository.createManual('user-1', {
    organizationId: 'org-1', productId: 'product-1', title: 'Never saved', hook: '', dimensions,
  }), /generated id is invalid/i)
  assert.equal((await pool.query('SELECT id FROM creative_briefs')).rowCount, 0)
  await pool.end()
})

test('lists only the requested tenant and orders equal timestamps by ID', async () => {
  const pool = await database()
  const ids = ['brief-b', 'brief-a', 'brief-private']
  const repository = new PostgresBriefRepository(
    pool,
    () => new Date('2026-10-26T12:00:00.000Z'),
    () => ids.shift() ?? 'unexpected',
  )
  const base = { title: 'Brief', hook: '', dimensions }
  await repository.createManual('user-1', { ...base, organizationId: 'org-1', productId: 'product-1' })
  await repository.createManual('user-1', { ...base, organizationId: 'org-1', productId: 'product-1' })
  await repository.createManual('user-2', { ...base, organizationId: 'org-2', productId: 'product-2' })

  const listed = await repository.pageForProduct('user-1', 'org-1', 'product-1', { limit: 100, includeArchived: true })
  assert.deepEqual(listed.map(({ id }) => id), ['brief-a', 'brief-b'])
  await pool.end()
})

test('invalid brief payloads fail before opening a database connection', async () => {
  let connections = 0
  let queries = 0
  const connection = {
    async query() { queries += 1; return { rows: [], rowCount: 0 } },
    release() {},
  } as SqlConnection
  const pool = {
    async connect() { connections += 1; return connection },
    async query() { queries += 1; return { rows: [], rowCount: 0 } },
  } as SqlPool
  const repository = new PostgresBriefRepository(pool, () => new Date(), () => 'brief-1')
  const invalidManual: unknown[] = [
    null, [],
    { organizationId: 'org-1', productId: 'product-1', title: 'Brief', hook: 42, dimensions },
    { organizationId: 'org-1', productId: 'product-1', title: 'Brief', hook: '', callToAction: 42, dimensions },
    { organizationId: 'org-1', productId: 'product-1', title: 'Brief', hook: '', dimensions: null },
  ]
  const invalidFromAd: unknown[] = [
    null,
    { organizationId: 'org-1', productId: 'product-1', adId: null, title: 'Brief', dimensions },
    { organizationId: 'org-1', productId: 'product-1', adId: 'ad-1', title: 42, dimensions },
  ]
  for (const input of invalidManual) await assert.rejects(repository.createManual('user-1', input as never), assertPublicValidation)
  for (const input of invalidFromAd) await assert.rejects(repository.createFromAd('user-1', input as never), assertPublicValidation)
  assert.equal(connections, 0)
  assert.equal(queries, 0)
})

function assertPublicValidation(error: unknown): boolean {
  assert.ok(error instanceof ValidationError)
  assert.equal(error.statusCode, 400)
  assert.equal(error.publicMessage, 'Invalid request')
  return true
}
