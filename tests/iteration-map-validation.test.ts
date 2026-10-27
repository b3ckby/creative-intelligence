import assert from 'node:assert/strict'
import test from 'node:test'

import { CreativeIntelligence } from '../src/creative-intelligence.ts'
import { ValidationError } from '../src/domain/errors.ts'
import type { Product } from '../src/domain/types.ts'
import { analyzeNormalizedIterationMap, IterationMapService, type AnalyzeIterationMapInput, type IterationAxes } from '../src/iteration-map/iteration-map-service.ts'
import { PostgresIterationMapRepository } from '../src/persistence/postgres-iteration-map-repository.ts'
import type { SqlConnection, SqlPool } from '../src/persistence/postgres-organization-repository.ts'

function appWithProduct() {
  const app = CreativeIntelligence.inMemory()
  const product = app.products.create({
    organizationId: 'org-1', name: 'Product', markets: [], platforms: ['web'],
    targetAudiences: [], uniqueSellingPoints: [],
  })
  return { app, product }
}

const validAxes: IterationAxes = { audience: ['a'], market: ['m'], angle: ['x'], format: ['f'] }

function assertPublicValidation(error: unknown): boolean {
  assert.ok(error instanceof ValidationError)
  assert.equal(error.statusCode, 400)
  assert.equal(error.publicMessage, 'Invalid request')
  return true
}

test('iteration map rejects a malformed top-level payload before lookups or PostgreSQL access', async () => {
  let lookupCount = 0
  const service = new IterationMapService(
    { findById() { lookupCount += 1; return undefined } },
    { listActiveForIterationMapOverflowProbe() { lookupCount += 1; return [] } },
  )
  assert.throws(() => service.analyze(null as unknown as AnalyzeIterationMapInput), assertPublicValidation)
  assert.equal(lookupCount, 0)

  let connectionCount = 0
  const connection: SqlConnection = { async query() { return { rows: [], rowCount: 0 } }, release() {} }
  const pool: SqlPool = {
    async connect() { connectionCount += 1; return connection },
    async query() { return { rows: [], rowCount: 0 } },
  }
  const repository = new PostgresIterationMapRepository(pool)
  await assert.rejects(repository.analyze('user-1', null as unknown as AnalyzeIterationMapInput), assertPublicValidation)
  assert.equal(connectionCount, 0)
})

test('in-memory iteration map enforces the active brief cap', () => {
  const product: Product = {
    id: 'product-1', organizationId: 'org-1', name: 'Product', markets: [], platforms: ['web'],
    targetAudiences: [], uniqueSellingPoints: [], archivedAt: null, createdAt: '2026-10-26T00:00:00.000Z',
  }
  const brief = {
    id: 'brief', organizationId: 'org-1', productId: 'product-1', title: 'Brief', status: 'draft' as const,
    sourceAdId: null, hook: '', callToAction: null,
    dimensions: { audience: 'a', market: 'm', angle: 'x', format: 'f' },
    createdAt: '2026-10-26T00:00:00.000Z',
  }
  const service = new IterationMapService(
    { findById() { return product } },
    { listActiveForIterationMapOverflowProbe() {
      return Array.from({ length: 10_001 }, (_, index) => ({ ...brief, id: `brief-${index}` }))
    } },
  )

  assert.throws(() => service.analyze({
    organizationId: 'org-1', productId: 'product-1', axes: validAxes,
  }), assertPublicValidation)
})

test('iteration axes reject null, non-arrays, and non-string values as public 400 errors', () => {
  const { app, product } = appWithProduct()
  const malformed: unknown[] = [
    null,
    { ...validAxes, audience: null },
    { ...validAxes, audience: 'a' },
    { ...validAxes, audience: [null] },
    { ...validAxes, audience: [42] },
  ]
  for (const axes of malformed) {
    assert.throws(() => app.iterationMap.analyze({
      organizationId: 'org-1', productId: product.id, axes: axes as IterationAxes,
    }), assertPublicValidation)
  }
})

test('iteration axis validation happens before a PostgreSQL connection or query', async () => {
  let connectionCount = 0
  let queryCount = 0
  const connection: SqlConnection = {
    async query() { queryCount += 1; return { rows: [], rowCount: 0 } },
    release() {},
  }
  const pool: SqlPool = {
    async connect() { connectionCount += 1; return connection },
    async query() { queryCount += 1; return { rows: [], rowCount: 0 } },
  }
  const repository = new PostgresIterationMapRepository(pool)
  const ten = Array.from({ length: 10 }, (_, index) => `value-${index}`)
  const invalidAxes: unknown[] = [
    { ...validAxes, audience: [null] },
    { ...validAxes, audience: Array.from({ length: 51 }, (_, index) => `value-${index}`) },
    { audience: [...ten, 'value-10'], market: ten, angle: ten, format: ten },
  ]

  for (const axes of invalidAxes) {
    const input = {
      organizationId: 'org-1', productId: 'product-1', axes: axes as IterationAxes,
    } satisfies AnalyzeIterationMapInput
    await assert.rejects(repository.analyze('user-1', input), assertPublicValidation)
  }
  assert.equal(connectionCount, 0)
  assert.equal(queryCount, 0)
})

test('sparse iteration axes are rejected instead of skipping holes', () => {
  const { app, product } = appWithProduct()
  assert.throws(() => app.iterationMap.analyze({
    organizationId: 'org-1', productId: product.id,
    axes: { ...validAxes, audience: Array(1) as string[] },
  }), assertPublicValidation)
})

test('in-memory iteration map validates identifiers, axes, and cap before lookups', () => {
  let productLookups = 0
  let briefLookups = 0
  const service = new IterationMapService(
    { findById() { productLookups += 1; return undefined } },
    { listActiveForIterationMapOverflowProbe() { briefLookups += 1; return [] } },
  )
  const ten = Array.from({ length: 10 }, (_, index) => `value-${index}`)
  const invalid: unknown[] = [
    { organizationId: ' org-1 ', productId: 'product-1', axes: validAxes },
    { organizationId: 'org-1', productId: '', axes: validAxes },
    { organizationId: 'org-1', productId: 'product-1', axes: { ...validAxes, audience: Array(1) } },
    { organizationId: 'org-1', productId: 'product-1', axes: { audience: [...ten, 'value-10'], market: ten, angle: ten, format: ten } },
  ]
  for (const input of invalid) assert.throws(() => service.analyze(input as AnalyzeIterationMapInput), assertPublicValidation)
  assert.equal(productLookups, 0)
  assert.equal(briefLookups, 0)
})

test('normalized iteration analysis reports ownership mismatch as a public validation error', () => {
  assert.throws(() => analyzeNormalizedIterationMap(
    { organizationId: 'org-1', productId: 'product-1', axes: validAxes },
    { organizationId: 'org-2', id: 'product-1' },
    [],
  ), assertPublicValidation)
})
