import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

import { DataType, newDb } from 'pg-mem'
import { ValidationError } from '../src/domain/errors.ts'
import { MAX_ACTIVE_BRIEFS, PostgresIterationMapRepository } from '../src/persistence/postgres-iteration-map-repository.ts'
import type { SqlConnection, SqlPool } from '../src/persistence/postgres-organization-repository.ts'

async function database() {
  const db = newDb()
  db.public.registerFunction({ name: 'length', args: [DataType.text], returns: DataType.integer, implementation: (value: string) => value.length })
  db.public.registerFunction({ name: 'trim', args: [DataType.text], returns: DataType.text, implementation: (value: string) => value.trim() })
  db.public.registerFunction({ name: 'set_config', args: [DataType.text, DataType.text, DataType.bool], returns: DataType.text, implementation: (_key: string, value: string) => value })
  const { Pool } = db.adapters.createPg()
  const pool = new Pool()
  await pool.query(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'))
  await pool.query(`
    INSERT INTO organizations (id, name) VALUES ('org-1', 'One'), ('org-2', 'Two');
    INSERT INTO organization_members (organization_id, user_id, role) VALUES
      ('org-1', 'user-1', 'admin'), ('org-2', 'user-2', 'admin');
    INSERT INTO products (id, organization_id, name) VALUES
      ('product-1', 'org-1', 'One'), ('product-2', 'org-2', 'Two');
    INSERT INTO creative_briefs (
      id, organization_id, product_id, title, status, hook, dimensions, created_at
    ) VALUES
      ('brief-covered', 'org-1', 'product-1', 'Covered', 'draft', '',
       '{"audience":"students","market":"US","angle":"focus","format":"video"}', '2026-10-26T10:00:00Z'),
      ('brief-archived', 'org-1', 'product-1', 'Archived', 'archived', '',
       '{"audience":"professionals","market":"US","angle":"focus","format":"video"}', '2026-10-26T11:00:00Z'),
      ('brief-private', 'org-2', 'product-2', 'Private', 'draft', '',
       '{"audience":"professionals","market":"US","angle":"focus","format":"video"}', '2026-10-26T12:00:00Z');
  `)
  return pool
}

test('loads tenant briefs and uses domain analysis for covered and missing cells', async () => {
  const pool = await database()
  const maps = new PostgresIterationMapRepository(pool)

  const result = await maps.analyze('user-1', {
    organizationId: 'org-1',
    productId: 'product-1',
    axes: {
      audience: [' students ', 'professionals'],
      market: ['US'],
      angle: ['focus'],
      format: ['video'],
    },
  })

  assert.equal(result.totalCombinations, 2)
  assert.deepEqual(result.covered.map(({ briefIds }) => briefIds), [['brief-covered']])
  assert.deepEqual(result.missing.map(({ dimensions }) => dimensions.audience), ['professionals'])
  await pool.end()
})

test('denies a product outside the requested tenant', async () => {
  const pool = await database()
  const maps = new PostgresIterationMapRepository(pool)
  await assert.rejects(maps.analyze('user-1', {
    organizationId: 'org-1',
    productId: 'product-2',
    axes: { audience: ['a'], market: ['m'], angle: ['x'], format: ['f'] },
  }), /product does not belong/i)
  await pool.end()
})

test('filters archived briefs in SQL before domain analysis', async () => {
  const queries: string[] = []
  const connection = {
    async query(text: string) {
      queries.push(text)
      if (text.includes('FROM organization_members')) {
        return { rows: [{ organization_id: 'org-1' }], rowCount: 1 }
      }
      if (text.includes('FROM products')) {
        return { rows: [{ id: 'product-1', organization_id: 'org-1' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
    release() {},
  } as SqlConnection
  const pool: SqlPool = {
    async connect() { return connection },
    async query() { return { rows: [], rowCount: 0 } },
  }

  await new PostgresIterationMapRepository(pool).analyze('user-1', {
    organizationId: 'org-1', productId: 'product-1',
    axes: { audience: ['a'], market: ['m'], angle: ['x'], format: ['f'] },
  })

  const briefQuery = queries.find((query) => query.includes('FROM creative_briefs'))
  assert.match(briefQuery ?? '', /status\s*<>\s*'archived'/i)
  assert.match(briefQuery ?? '', /SELECT\s+id,\s*dimensions/i)
  assert.doesNotMatch(briefQuery ?? '', /\btitle\b|\bhook\b|call_to_action|source_ad_id/i)
  assert.match(briefQuery ?? '', /LIMIT\s+\$3/i)
})

test('iteration-map rejects corrupted persisted brief identifiers', async () => {
  const connection = {
    async query(text: string) {
      if (text.includes('FROM organization_members')) return { rows: [{ organization_id: 'org-1' }], rowCount: 1 }
      if (text.includes('FROM products')) return { rows: [{ id: 'product-1', organization_id: 'org-1' }], rowCount: 1 }
      if (text.includes('FROM creative_briefs')) return {
        rows: [{ id: ' brief-corrupt ', dimensions: { audience: 'a', market: 'm', angle: 'x', format: 'f' } }], rowCount: 1,
      }
      return { rows: [], rowCount: 0 }
    },
    release() {},
  } as SqlConnection
  const pool = { async connect() { return connection }, async query() { return { rows: [], rowCount: 0 } } } as SqlPool
  await assert.rejects(new PostgresIterationMapRepository(pool).analyze('user-1', {
    organizationId: 'org-1', productId: 'product-1', axes: validAxes,
  }), /Stored iteration-brief\.id failed data-integrity validation/)
})

test('rejects more than the documented active brief cap with a typed error', async () => {
  const rows = Array.from({ length: MAX_ACTIVE_BRIEFS + 1 }, (_, index) => ({
    id: `brief-${index}`, dimensions: { audience: 'a', market: 'm', angle: 'x', format: 'f' },
  }))
  const connection = {
    async query(text: string, values?: unknown[]) {
      if (text.includes('FROM organization_members')) return { rows: [{ organization_id: 'org-1' }], rowCount: 1 }
      if (text.includes('FROM products')) return { rows: [{ id: 'product-1', organization_id: 'org-1' }], rowCount: 1 }
      if (text.includes('FROM creative_briefs')) {
        assert.equal(values?.[2], MAX_ACTIVE_BRIEFS + 1)
        return { rows, rowCount: rows.length }
      }
      return { rows: [], rowCount: 0 }
    },
    release() {},
  } as SqlConnection
  const pool = { async connect() { return connection }, async query() { return { rows: [], rowCount: 0 } } } as SqlPool
  await assert.rejects(new PostgresIterationMapRepository(pool).analyze('user-1', {
    organizationId: 'org-1', productId: 'product-1', axes: validAxes,
  }), (error: unknown) => {
    assert.ok(error instanceof ValidationError)
    assert.match(error.message, /too many active briefs/i)
    return true
  })
})

const validAxes = { audience: ['a'], market: ['m'], angle: ['x'], format: ['f'] }

test('allows 10,000 combinations and rejects any larger map', async () => {
  const pool = await database()
  const maps = new PostgresIterationMapRepository(pool)
  const ten = Array.from({ length: 10 }, (_, index) => `value-${index}`)
  const base = { organizationId: 'org-1', productId: 'product-1' }

  const atCap = await maps.analyze('user-1', {
    ...base,
    axes: { audience: ten, market: ten, angle: ten, format: ten },
  })
  assert.equal(atCap.totalCombinations, 10_000)
  assert.equal(atCap.covered.length, 0)
  assert.equal(atCap.missing.length, 10_000)

  await assert.rejects(maps.analyze('user-1', {
    ...base,
    axes: { audience: [...ten, 'value-10'], market: ten, angle: ten, format: ten },
  }), /maximum is 10000/i)
  await pool.end()
})
