import test from 'node:test'
import assert from 'node:assert/strict'

import { CreativeIntelligence } from '../src/creative-intelligence.ts'

test('Iteration Map reports covered and missing creative combinations', () => {
  const app = CreativeIntelligence.inMemory()
  const product = app.products.create({
    organizationId: 'org-1',
    name: 'Focus Timer',
    markets: ['US'],
    platforms: ['ios'],
    targetAudiences: ['students', 'professionals'],
    uniqueSellingPoints: ['focus'],
  })

  app.briefs.createManual({
    organizationId: 'org-1',
    productId: product.id,
    title: 'Student anti-procrastination video',
    hook: 'Stop procrastinating',
    dimensions: {
      audience: 'students',
      market: 'US',
      angle: 'anti-procrastination',
      format: 'video',
    },
  })

  const map = app.iterationMap.analyze({
    organizationId: 'org-1',
    productId: product.id,
    axes: {
      audience: ['students', 'professionals'],
      market: ['US'],
      angle: ['anti-procrastination', 'achievement'],
      format: ['video'],
    },
  })

  assert.equal(map.totalCombinations, 4)
  assert.equal(map.covered.length, 1)
  assert.equal(map.missing.length, 3)
  assert.deepEqual(map.covered[0]?.dimensions, {
    audience: 'students',
    market: 'US',
    angle: 'anti-procrastination',
    format: 'video',
  })
  assert.deepEqual(map.covered[0]?.briefs, [{
    id: map.covered[0]?.briefs[0]?.id,
    title: 'Student anti-procrastination video',
    status: 'draft',
  }])
  assert.equal(map.covered[0]?.briefCount, 1)
  assert.equal(map.covered[0]?.hasMoreBriefs, false)
  assert.ok(map.missing.some((item) => item.dimensions.audience === 'professionals' && item.dimensions.angle === 'achievement'))
})

test('Iteration Map never includes briefs from another organization', () => {
  const app = CreativeIntelligence.inMemory()
  const first = app.products.create({
    organizationId: 'org-1',
    name: 'First',
    markets: ['US'],
    platforms: ['web'],
    targetAudiences: ['students'],
    uniqueSellingPoints: ['focus'],
  })
  const second = app.products.create({
    organizationId: 'org-2',
    name: 'Second',
    markets: ['US'],
    platforms: ['web'],
    targetAudiences: ['students'],
    uniqueSellingPoints: ['focus'],
  })
  app.briefs.createManual({
    organizationId: 'org-2',
    productId: second.id,
    title: 'Other tenant brief',
    hook: 'Private',
    dimensions: { audience: 'students', market: 'US', angle: 'achievement', format: 'video' },
  })

  const map = app.iterationMap.analyze({
    organizationId: 'org-1',
    productId: first.id,
    axes: {
      audience: ['students'],
      market: ['US'],
      angle: ['achievement'],
      format: ['video'],
    },
  })

  assert.equal(map.covered.length, 0)
  assert.equal(map.missing.length, 1)
})

test('Iteration Map rejects an excessive Cartesian product', () => {
  const app = CreativeIntelligence.inMemory()
  const product = app.products.create({
    organizationId: 'org-1',
    name: 'Product',
    markets: ['US'],
    platforms: ['web'],
    targetAudiences: ['audience'],
    uniqueSellingPoints: ['focus'],
  })
  const values = Array.from({ length: 20 }, (_, index) => `value-${index}`)

  assert.throws(() => app.iterationMap.analyze({
    organizationId: 'org-1',
    productId: product.id,
    axes: {
      audience: values,
      market: values,
      angle: values,
      format: values,
    },
  }), /too many combinations/i)
})

test('in-memory brief lists and iteration-map brief IDs use createdAt then ID ordering', () => {
  const ids = ['product-1', 'brief-b', 'brief-a']
  const app = CreativeIntelligence.inMemory({
    now: () => new Date('2026-10-26T12:00:00.000Z'),
    createId: () => ids.shift() ?? 'unexpected',
  })
  const product = app.products.create({
    organizationId: 'org-1', name: 'Product', markets: [], platforms: ['web'], targetAudiences: [], uniqueSellingPoints: [],
  })
  const input = {
    organizationId: 'org-1', productId: product.id, title: 'Brief', hook: '',
    dimensions: { audience: 'a', market: 'm', angle: 'x', format: 'f' },
  }
  app.briefs.createManual(input)
  app.briefs.createManual(input)
  assert.deepEqual(app.briefs.listForProduct('org-1', product.id, 100).map(({ id }) => id), ['brief-a', 'brief-b'])
  const map = app.iterationMap.analyze({
    organizationId: 'org-1', productId: product.id,
    axes: { audience: ['a'], market: ['m'], angle: ['x'], format: ['f'] },
  })
  assert.deepEqual(map.covered[0]?.briefs.map(({ id }) => id), ['brief-a', 'brief-b'])
})

test('Iteration Map bounds per-cell brief evidence while preserving the observed total', () => {
  const ids = ['product-1', ...Array.from({ length: 27 }, (_, index) => `brief-${String(index).padStart(2, '0')}`)]
  const app = CreativeIntelligence.inMemory({
    now: () => new Date('2026-10-26T12:00:00.000Z'),
    createId: () => ids.shift() ?? 'unexpected',
  })
  const product = app.products.create({ organizationId: 'org-1', name: 'Product', markets: [], platforms: ['web'], targetAudiences: [], uniqueSellingPoints: [] })
  const input = { organizationId: 'org-1', productId: product.id, title: 'Brief', hook: '', dimensions: { audience: 'a', market: 'm', angle: 'x', format: 'f' } }
  for (let index = 0; index < 27; index += 1) app.briefs.createManual({ ...input, title: `Brief ${index}` })

  const map = app.iterationMap.analyze({ organizationId: 'org-1', productId: product.id, axes: { audience: ['a'], market: ['m'], angle: ['x'], format: ['f'] } })

  assert.equal(map.covered[0]?.briefCount, 27)
  assert.equal(map.covered[0]?.briefs.length, 25)
  assert.equal(map.covered[0]?.hasMoreBriefs, true)
})
