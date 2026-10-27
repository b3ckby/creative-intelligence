import assert from 'node:assert/strict'
import test from 'node:test'

import { AdLibraryService } from '../src/ads/ad-library-service.ts'
import { BriefService } from '../src/briefs/brief-service.ts'
import * as inMemoryModule from '../src/creative-intelligence.ts'
import type { Product } from '../src/domain/types.ts'
import { IterationMapService, MAX_ACTIVE_BRIEFS } from '../src/iteration-map/iteration-map-service.ts'

const invalidLimits: unknown[] = [
  undefined,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  1.5,
  0,
  -1,
  101,
  Number.MAX_SAFE_INTEGER,
]

const product: Product = {
  id: 'product-1',
  organizationId: 'org-1',
  name: 'Product',
  markets: [],
  platforms: ['web'],
  targetAudiences: [],
  uniqueSellingPoints: [],
  archivedAt: null,
  createdAt: '2026-10-27T00:00:00.000Z',
}

test('ad and brief services require and validate ordinary page limits before dependency work', () => {
  let adLists = 0
  let briefLists = 0
  let productLookups = 0
  const ads = new AdLibraryService(
    {
      saveBatch() {},
      findByProviderKey() { return undefined },
      listForCompetitor() { adLists += 1; return [] },
      findById() { return undefined },
    },
    { findById() { return undefined } },
    { findById() { return undefined } },
    () => new Date(),
    () => 'ad-1',
    new Map(),
  )
  const briefs = new BriefService(
    { save() {}, listForProduct() { briefLists += 1; return [] }, listActiveForIterationMapOverflowProbe() { return [] } },
    { findById() { productLookups += 1; return product } },
    { findById() { return undefined } },
    () => new Date(),
    () => 'brief-1',
  )
  const listAds = ads.listForCompetitor.bind(ads) as (organizationId: string, competitorId: string, limit: unknown) => unknown
  const listBriefs = briefs.listForProduct.bind(briefs) as (organizationId: string, productId: string, limit: unknown) => unknown

  for (const limit of invalidLimits) {
    assert.throws(() => listAds('org-1', 'competitor-1', limit), /limit/i)
    assert.throws(() => listBriefs('org-1', 'product-1', limit), /limit/i)
  }
  assert.equal(adLists, 0)
  assert.equal(briefLists, 0)
  assert.equal(productLookups, 0)
})

test('in-memory repositories independently reject invalid limits', () => {
  const AdRepository = (inMemoryModule as Record<string, unknown>).InMemoryAdRepository as new () => {
    listForCompetitor(organizationId: string, competitorId: string, limit: unknown): unknown
  }
  const BriefRepository = (inMemoryModule as Record<string, unknown>).InMemoryBriefRepository as new () => {
    listForProduct(organizationId: string, productId: string, limit: unknown): unknown
  }
  const ads = new AdRepository()
  const briefs = new BriefRepository()

  for (const limit of invalidLimits) {
    assert.throws(() => ads.listForCompetitor('org-1', 'competitor-1', limit), /limit/i)
    assert.throws(() => briefs.listForProduct('org-1', 'product-1', limit), /limit/i)
  }
})

test('Iteration Map uses its explicit bounded overflow-probe interface', () => {
  let probes = 0
  const service = new IterationMapService(
    { findById() { return product } },
    {
      listActiveForIterationMapOverflowProbe(organizationId: string, productId: string) {
        probes += 1
        assert.equal(organizationId, 'org-1')
        assert.equal(productId, 'product-1')
        return Array.from({ length: MAX_ACTIVE_BRIEFS + 1 }, (_, index) => ({
          id: `brief-${index}`,
          organizationId,
          productId,
          title: 'Brief',
          status: 'draft' as const,
          sourceAdId: null,
          hook: '',
          callToAction: null,
          dimensions: { audience: 'a', market: 'm', angle: 'x', format: 'f' },
          createdAt: '2026-10-27T00:00:00.000Z',
        }))
      },
    } as never,
  )

  assert.throws(() => service.analyze({
    organizationId: 'org-1',
    productId: 'product-1',
    axes: { audience: ['a'], market: ['m'], angle: ['x'], format: ['f'] },
  }), /too many active briefs/i)
  assert.equal(probes, 1)
})
