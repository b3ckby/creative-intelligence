import assert from 'node:assert/strict'
import test from 'node:test'

import { BriefService } from '../src/briefs/brief-service.ts'
import { CreativeIntelligence } from '../src/creative-intelligence.ts'
import { ApplicationError, ValidationError } from '../src/domain/errors.ts'
import type { BriefDimensions } from '../src/domain/types.ts'

function appWithProduct() {
  const app = CreativeIntelligence.inMemory()
  const product = app.products.create({
    organizationId: 'org-1',
    name: 'Product',
    markets: ['US'],
    platforms: ['web'],
    targetAudiences: ['students'],
    uniqueSellingPoints: ['focus'],
  })
  return { app, product }
}

const dimensions: BriefDimensions = { audience: 'students', market: 'US', angle: 'focus', format: 'video' }

test('brief builders reject blank and overlong titles as public 400 validation errors', () => {
  const { app, product } = appWithProduct()
  for (const title of ['   ', 'x'.repeat(501), null]) {
    assert.throws(
      () => app.briefs.createManual({
        organizationId: 'org-1', productId: product.id, title: title as string, hook: '', dimensions,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError)
        assert.ok(error instanceof ApplicationError)
        assert.equal(error.statusCode, 400)
        assert.equal(error.publicMessage, 'Invalid request')
        assert.match(error.message, /brief title is (required|too long)/i)
        return true
      },
    )
  }
})

test('brief builders reject malformed runtime dimensions as public 400 validation errors', () => {
  const { app, product } = appWithProduct()
  const malformed: unknown[] = [
    null,
    [],
    { audience: 'students', market: 'US', angle: 'focus' },
    { ...dimensions, audience: 42 },
    { ...dimensions, audience: 'bad\u0000value' },
    { ...dimensions, unexpected: 'value' },
  ]

  for (const value of malformed) {
    assert.throws(
      () => app.briefs.createManual({
        organizationId: 'org-1', productId: product.id, title: 'Brief', hook: '',
        dimensions: value as BriefDimensions,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError)
        assert.equal(error.statusCode, 400)
        assert.equal(error.publicMessage, 'Invalid request')
        return true
      },
    )
  }
})

test('brief service validates complete payloads before ownership lookups', () => {
  let productLookups = 0
  let adLookups = 0
  const service = new BriefService(
    { save() {}, listForProduct() { return [] }, listActiveForIterationMapOverflowProbe() { return [] } },
    { findById() { productLookups += 1; return undefined } },
    { findById() { adLookups += 1; return undefined } },
    () => new Date(),
    () => 'brief-1',
  )
  const invalidManual: unknown[] = [
    null, [],
    { organizationId: 1, productId: 'product-1', title: 'Brief', hook: 'Hook', dimensions },
    { organizationId: 'org-1', productId: ' product-1 ', title: 'Brief', hook: 'Hook', dimensions },
    { organizationId: 'org-1', productId: 'product-1', title: 'Brief', hook: 7, dimensions },
    { organizationId: 'org-1', productId: 'product-1', title: 'Brief', hook: 'Hook', callToAction: 7, dimensions },
  ]
  const invalidFromAd: unknown[] = [
    null,
    { organizationId: 'org-1', productId: 'product-1', adId: 7, title: 'Brief', dimensions },
    { organizationId: 'org-1', productId: 'product-1', adId: 'ad-1', title: 7, dimensions },
  ]
  for (const input of invalidManual) assert.throws(() => service.createManual(input as never), assertPublicValidation)
  for (const input of invalidFromAd) assert.throws(() => service.createFromAd(input as never), assertPublicValidation)
  assert.equal(productLookups, 0)
  assert.equal(adLookups, 0)
})

test('brief service validates list identifiers and ownership before repository reads', () => {
  let lists = 0
  const service = new BriefService(
    { save() {}, listForProduct() { lists += 1; return [] }, listActiveForIterationMapOverflowProbe() { return [] } },
    { findById() { return undefined } },
    { findById() { return undefined } },
    () => new Date(),
    () => 'brief-1',
  )
  assert.throws(() => service.listForProduct(' org-1 ', 'product-1', 100), assertPublicValidation)
  assert.throws(() => service.listForProduct('org-1', 'product-1', 100), assertPublicValidation)
  assert.equal(lists, 0)
})

function assertPublicValidation(error: unknown): boolean {
  assert.ok(error instanceof ValidationError)
  assert.equal(error.statusCode, 400)
  assert.equal(error.publicMessage, 'Invalid request')
  return true
}
