import test from 'node:test'
import assert from 'node:assert/strict'

import { CreativeIntelligence } from '../src/creative-intelligence.ts'
import type { AdCollectionContext, AdSourceProvider, CollectedAd } from '../src/ad-ingestion/ad-source-provider.ts'
import { AD_BODY_MAX_LENGTH } from '../src/domain/types.ts'

const validAd: CollectedAd = {
  platform: 'meta',
  externalId: 'meta-1',
  advertiserName: 'Competitor',
  body: 'Creative copy',
  callToAction: null,
  startedAt: '2026-09-01T00:00:00.000Z',
  isActive: true,
  mediaUrls: [],
  sourceUrl: 'https://www.facebook.com/ads/library/?id=meta-1',
}

function setup(providers: ReadonlyMap<string, AdSourceProvider>) {
  const app = CreativeIntelligence.inMemory({ providers })
  const product = app.products.create({
    organizationId: 'org-1',
    name: 'Product',
    markets: ['US'],
    platforms: ['web'],
    targetAudiences: ['students'],
    uniqueSellingPoints: ['focus'],
  })
  const competitor = app.competitors.create({ organizationId: 'org-1', productId: product.id, name: 'Competitor' })
  return {
    app,
    competitor,
    context: { organizationId: 'org-1', productId: product.id, competitorId: competitor.id },
  }
}

test('provider receives an immutable context snapshot and cannot cross tenant boundaries', async () => {
  const mutator: AdSourceProvider = {
    async collect(context: Readonly<AdCollectionContext>) {
      assert.throws(() => { (context as { organizationId: string }).organizationId = 'org-2' }, TypeError)
      return [validAd]
    },
  }
  const { app, competitor, context } = setup(new Map([['trusted-provider', mutator]]))

  await app.ads.collect('trusted-provider', context)

  const imported = app.ads.listForCompetitor('org-1', competitor.id, 100)[0]
  assert.ok(imported)
  assert.equal(imported.organizationId, 'org-1')
  assert.equal(imported.providerName, 'trusted-provider')
})

test('provider namespace comes from the trusted registry key', async () => {
  const firstWithClaimedName = { name: 'impersonated-provider', async collect() { return [validAd] } }
  const secondWithClaimedName = { name: 'trusted-provider', async collect() { return [validAd] } }
  const first: AdSourceProvider = firstWithClaimedName
  const second: AdSourceProvider = secondWithClaimedName
  const providers = new Map<string, AdSourceProvider>([
    ['trusted-provider', first],
    ['second-provider', second],
  ])
  const { app, competitor, context } = setup(providers)

  await app.ads.collect('trusted-provider', context)
  await app.ads.collect('second-provider', context)

  const ads = app.ads.listForCompetitor('org-1', competitor.id, 100)
  assert.deepEqual(ads.map((ad) => ad.providerName).sort(), ['second-provider', 'trusted-provider'])
})

test('provider records preserve validated expanded metadata through the domain contract', async () => {
  const expanded: CollectedAd = {
    ...validAd,
    pageId: 'page-1',
    headline: 'Headline',
    description: 'Description',
    displayFormat: 'VIDEO',
    adType: 'video',
    endedAt: '2026-09-02T00:00:00.000Z',
    publisherPlatforms: ['facebook', 'instagram'],
    impressionsLowerBound: 100,
    impressionsUpperBound: 200,
    spendLowerBound: 10.5,
    spendUpperBound: 20.5,
    currency: 'USD',
    media: [{ kind: 'video', sourceUrl: 'https://cdn.example.test/ad.mp4', posterUrl: null, cardIndex: null, order: 0 }],
    mediaUrls: ['https://cdn.example.test/ad.mp4'],
  }
  const { app, competitor, context } = setup(new Map([['expanded-provider', { async collect() { return [expanded] } }]]))

  await app.ads.collect('expanded-provider', context)

  const stored = app.ads.listForCompetitor('org-1', competitor.id, 100)[0]
  assert.ok(stored)
  assert.equal(stored.pageId, 'page-1')
  assert.equal(stored.headline, 'Headline')
  assert.equal(stored.description, 'Description')
  assert.equal(stored.displayFormat, 'VIDEO')
  assert.equal(stored.adType, 'video')
  assert.equal(stored.endedAt, '2026-09-02T00:00:00.000Z')
  assert.deepEqual(stored.publisherPlatforms, ['facebook', 'instagram'])
  assert.equal(stored.impressionsLowerBound, 100)
  assert.equal(stored.impressionsUpperBound, 200)
  assert.equal(stored.spendLowerBound, 10.5)
  assert.equal(stored.spendUpperBound, 20.5)
  assert.equal(stored.currency, 'USD')
  assert.deepEqual(stored.media, expanded.media)
})

test('provider identifiers reject control characters without persisting records', async () => {
  const invalid: CollectedAd = { ...validAd, externalId: 'meta\u0000other' }
  const { app, competitor, context } = setup(new Map([['control-provider', { async collect() { return [invalid] } }]]))

  await assert.rejects(() => app.ads.collect('control-provider', context), /externalId is invalid/i)
  assert.equal(app.ads.listForCompetitor('org-1', competitor.id, 100).length, 0)
})

test('an invalid later item leaves the whole provider batch unchanged', async () => {
  const invalid = { ...validAd, externalId: '' }
  const batch: AdSourceProvider = {
    async collect() { return [validAd, invalid] },
  }
  const { app, competitor, context } = setup(new Map([['batch-provider', batch]]))

  await assert.rejects(() => app.ads.collect('batch-provider', context), /externalId (?:is required|is invalid)/i)
  assert.equal(app.ads.listForCompetitor('org-1', competitor.id, 100).length, 0)
})

test('provider records use canonical text and HTTPS URL validators atomically', async () => {
  const hostile: CollectedAd[] = [
    { ...validAd, externalId: 'bad-name', advertiserName: 'bad\nname' },
    { ...validAd, externalId: 'bad-body', body: 'bad\u0085body' },
    { ...validAd, externalId: 'bad-cta', callToAction: 'bad\ncta' },
    { ...validAd, externalId: 'userinfo-source', sourceUrl: 'https://user:secret@example.test/ad' },
    { ...validAd, externalId: 'fragment-source', sourceUrl: 'https://example.test/ad#fragment' },
    { ...validAd, externalId: 'userinfo-media', mediaUrls: ['https://user:secret@cdn.example.test/ad.mp4'] },
    { ...validAd, externalId: 'fragment-media', mediaUrls: ['https://cdn.example.test/ad.mp4#fragment'] },
    { ...validAd, externalId: 'duplicate-media', mediaUrls: ['https://cdn.example.test/ad.mp4', 'https://cdn.example.test/ad.mp4'] },
  ]

  for (const invalid of hostile) {
    const batch: AdSourceProvider = { async collect() { return [validAd, invalid] } }
    const { app, competitor, context } = setup(new Map([['hostile-provider', batch]]))
    await assert.rejects(() => app.ads.collect('hostile-provider', context), /invalid/i)
    assert.equal(app.ads.listForCompetitor('org-1', competitor.id, 100).length, 0)
  }
})

test('provider ad body accepts the canonical maximum and rejects max plus one atomically', async () => {
  const atMax = { ...validAd, body: 'B'.repeat(AD_BODY_MAX_LENGTH) }
  const overMax = { ...validAd, externalId: 'meta-2', body: 'B'.repeat(AD_BODY_MAX_LENGTH + 1) }
  const { app, competitor, context } = setup(new Map([['body-provider', { async collect() { return [atMax] } }]]))
  await app.ads.collect('body-provider', context)
  assert.equal(app.ads.listForCompetitor('org-1', competitor.id, 100)[0]?.body.length, AD_BODY_MAX_LENGTH)

  const failing = setup(new Map([['body-provider', { async collect() { return [validAd, overMax] } }]]))
  await assert.rejects(() => failing.app.ads.collect('body-provider', failing.context), /body is invalid/i)
  assert.equal(failing.app.ads.listForCompetitor('org-1', failing.competitor.id, 100).length, 0)
})
