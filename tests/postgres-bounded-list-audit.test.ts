import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

import { PostgresBriefRepository } from '../src/persistence/postgres-brief-repository.ts'
import { PostgresCatalogRepository } from '../src/persistence/postgres-catalog-repository.ts'
import type { SqlConnection, SqlPool } from '../src/persistence/postgres-organization-repository.ts'

test('deprecated unbounded PostgreSQL list APIs are absent', () => {
  for (const [prototype, methods] of [
    [PostgresCatalogRepository.prototype, ['listProducts', 'listCompetitors', 'listAds']],
    [PostgresBriefRepository.prototype, ['listForProduct']],
  ] as const) {
    for (const method of methods) assert.equal(method in prototype, false, `${method} must not be externally reachable`)
  }
})

test('every ordered PostgreSQL collection query has an explicit LIMIT', async () => {
  const files = [
    '../src/persistence/postgres-catalog-repository.ts',
    '../src/persistence/postgres-brief-repository.ts',
    '../src/persistence/postgres-iteration-map-repository.ts',
  ]
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8')
    const queries = source.match(/`SELECT[\s\S]*?ORDER BY[\s\S]*?`/g) ?? []
    for (const sql of queries) assert.match(sql, /\bLIMIT\b/i, `unbounded ordered query in ${file}: ${sql}`)
  }
})

test('every PostgreSQL page rejects adversarial limits before connecting or querying', async () => {
  const invalidLimits = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, 0, -1, 101, Number.MAX_SAFE_INTEGER]
  let connections = 0
  let queries = 0
  const connection: SqlConnection = {
    async query() { queries += 1; return { rows: [], rowCount: 0 } },
    release() {},
  }
  const pool: SqlPool = {
    async connect() { connections += 1; return connection },
    async query() { queries += 1; return { rows: [], rowCount: 0 } },
  }
  const catalog = new PostgresCatalogRepository(pool)
  const briefs = new PostgresBriefRepository(pool, () => new Date(), () => 'brief-1')

  for (const limit of invalidLimits) {
    await assert.rejects(catalog.pageProducts('user-1', 'org-1', { limit, includeArchived: false }), /limit/i)
    await assert.rejects(catalog.pageCompetitors('user-1', 'org-1', 'product-1', { limit, includeArchived: false }), /limit/i)
    await assert.rejects(catalog.pageAds('user-1', 'org-1', { limit }), /limit/i)
    await assert.rejects(briefs.pageForProduct('user-1', 'org-1', 'product-1', { limit, includeArchived: false }), /limit/i)
  }

  assert.equal(connections, 0)
  assert.equal(queries, 0)
})