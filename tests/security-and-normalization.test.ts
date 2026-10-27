import test from 'node:test'
import assert from 'node:assert/strict'

import { CreativeIntelligence } from '../src/creative-intelligence.ts'
import { ManualMetaAdsProvider } from '../src/ad-ingestion/manual-meta-ads-provider.ts'
import type { AdSourceProvider, CollectedAd } from '../src/ad-ingestion/ad-source-provider.ts'

const originalAd: CollectedAd = {
  platform: 'meta',
  externalId: 'meta-1',
  advertiserName: 'Competitor',
  body: 'Original copy',
  callToAction: null,
  startedAt: '2026-09-01T00:00:00.000Z',
  isActive: true,
  mediaUrls: ['https://cdn.example.com/first.mp4'],
  sourceUrl: 'https://www.facebook.com/ads/library/?id=meta-1',
}

class SequenceProvider implements AdSourceProvider {
  private index = 0
  constructor(private readonly batches: readonly (readonly CollectedAd[])[]) {}
  async collect(): Promise<CollectedAd[]> {
    const batch = this.batches[Math.min(this.index, this.batches.length - 1)] ?? []
    this.index += 1
    return batch.map((item) => structuredClone(item))
  }
}

async function seededAd(options: {
  manualBatches?: readonly (readonly CollectedAd[])[]
  extraProviders?: ReadonlyMap<string, AdSourceProvider>
} = {}) {
  let tick = 0
  const providers = new Map<string, AdSourceProvider>(options.extraProviders)
  providers.set('manual-meta', new SequenceProvider(options.manualBatches ?? [[originalAd]]))
  const app = CreativeIntelligence.inMemory({
    now: () => new Date(`2026-10-0${++tick}T00:00:00.000Z`),
    providers,
  })
  const product = app.products.create({
    organizationId: 'org-1',
    name: 'Product',
    markets: ['US'],
    platforms: ['web'],
    targetAudiences: ['students'],
    uniqueSellingPoints: ['focus'],
  })
  const competitor = app.competitors.create({ organizationId: 'org-1', productId: product.id, name: 'Competitor' })
  const context = { organizationId: 'org-1', productId: product.id, competitorId: competitor.id }
  await app.ads.collect('manual-meta', context)
  const ad = app.ads.listForCompetitor('org-1', competitor.id, 100)[0]
  assert.ok(ad)
  return { app, product, competitor, context, ad }
}

function provider(item: CollectedAd): AdSourceProvider {
  return { async collect() { return [item] } }
}

test('ad lookup is scoped to an organization', async () => {
  const { app, ad } = await seededAd()
  assert.equal(app.ads.findById('org-2', ad.id), undefined)
  assert.equal(app.ads.findById('org-1', ad.id)?.id, ad.id)
})

test('repeated imports refresh mutable fields and preserve firstSeenAt', async () => {
  const updated: CollectedAd = {
    ...originalAd,
    advertiserName: 'Competitor renamed',
    body: 'Updated copy',
    callToAction: 'LEARN_MORE',
    isActive: false,
    mediaUrls: ['https://cdn.example.com/updated.mp4'],
  }
  const { app, competitor, context, ad } = await seededAd({ manualBatches: [[originalAd], [updated]] })
  const second = await app.ads.collect('manual-meta', context)

  assert.deepEqual(second, { inserted: 0, duplicates: 1 })
  const refreshed = app.ads.listForCompetitor('org-1', competitor.id, 100)[0]
  assert.ok(refreshed)
  assert.equal(refreshed.id, ad.id)
  assert.equal(refreshed.firstSeenAt, ad.firstSeenAt)
  assert.notEqual(refreshed.lastSeenAt, ad.lastSeenAt)
  assert.equal(refreshed.body, 'Updated copy')
  assert.equal(refreshed.isActive, false)
  assert.deepEqual(refreshed.mediaUrls, ['https://cdn.example.com/updated.mp4'])
})

test('rejects a provider ID already attributed to another competitor', async () => {
  const conflicting: CollectedAd = {
    ...originalAd,
    advertiserName: 'Other competitor',
    body: 'Must not overwrite the first competitor',
    startedAt: '2026-09-02T00:00:00.000Z',
    mediaUrls: [],
  }
  const { app, product, competitor } = await seededAd({ manualBatches: [[originalAd], [conflicting]] })
  const other = app.competitors.create({ organizationId: 'org-1', productId: product.id, name: 'Other competitor' })

  await assert.rejects(() => app.ads.collect('manual-meta', {
    organizationId: 'org-1',
    productId: product.id,
    competitorId: other.id,
  }), /already belongs to another product or competitor/i)

  assert.equal(app.ads.listForCompetitor('org-1', other.id, 100).length, 0)
  assert.equal(app.ads.listForCompetitor('org-1', competitor.id, 100)[0]?.body, 'Original copy')
})

test('provider output cannot override trusted ownership or record identity', async () => {
  const malicious = {
    ...originalAd,
    externalId: 'meta-malicious',
    advertiserName: 'Attacker',
    body: 'Injected',
    sourceUrl: 'https://www.facebook.com/ads/library/?id=meta-malicious',
    id: 'attacker-selected-id',
    organizationId: 'org-2',
    productId: 'foreign-product',
    competitorId: 'foreign-competitor',
  } as unknown as CollectedAd
  const { app, context, competitor } = await seededAd({
    extraProviders: new Map([['malicious-provider', provider(malicious)]]),
  })

  await app.ads.collect('malicious-provider', context)

  const imported = app.ads.listForCompetitor('org-1', competitor.id, 100).find((ad) => ad.externalId === 'meta-malicious')
  assert.ok(imported)
  assert.notEqual(imported.id, 'attacker-selected-id')
  assert.equal(imported.organizationId, 'org-1')
  assert.equal(imported.productId, context.productId)
  assert.equal(imported.competitorId, context.competitorId)
  assert.equal(app.ads.findById('org-2', 'attacker-selected-id'), undefined)
})

test('provider namespace is part of ad identity', async () => {
  const item: CollectedAd = {
    ...originalAd,
    externalId: 'shared-id',
    body: 'Provider-specific copy',
    startedAt: '2026-09-02T00:00:00.000Z',
    mediaUrls: [],
    sourceUrl: 'https://www.facebook.com/ads/library/?id=shared-id',
  }
  const { app, context, competitor } = await seededAd({
    extraProviders: new Map([
      ['provider-a', provider(item)],
      ['provider-b', provider(item)],
    ]),
  })

  assert.deepEqual(await app.ads.collect('provider-a', context), { inserted: 1, duplicates: 0 })
  assert.deepEqual(await app.ads.collect('provider-b', context), { inserted: 1, duplicates: 0 })

  const matching = app.ads.listForCompetitor('org-1', competitor.id, 100).filter((ad) => ad.externalId === 'shared-id')
  assert.equal(matching.length, 2)
  assert.deepEqual(matching.map((ad) => ad.providerName).sort(), ['provider-a', 'provider-b'])
})

test('manual Meta provider rejects malformed and unsafe records', async () => {
  const invalidUrl = new ManualMetaAdsProvider([{
    externalId: 'meta-1',
    advertiserName: 'Competitor',
    body: 'Copy',
    startedAt: '2026-09-01T00:00:00.000Z',
    isActive: true,
    mediaUrls: [],
    sourceUrl: 'https://example.com:not-a-port',
  }])
  await assert.rejects(() => invalidUrl.collect({ organizationId: 'org', productId: 'p', competitorId: 'c' }), /source URL is invalid/i)

  const unsafeMedia = new ManualMetaAdsProvider([{
    externalId: 'meta-1',
    advertiserName: 'Competitor',
    body: '',
    startedAt: '2026-09-01T00:00:00.000Z',
    isActive: true,
    mediaUrls: ['file:///etc/passwd'],
    sourceUrl: 'https://www.facebook.com/ads/library/?id=meta-1',
  }])
  await assert.rejects(() => unsafeMedia.collect({ organizationId: 'org', productId: 'p', competitorId: 'c' }), /media URL must use HTTPS|body or media/i)
})

test('generated aggregate IDs are validated and collisions fail closed', () => {
  const duplicateIds = CreativeIntelligence.inMemory({ createId: () => 'duplicate-id' })
  duplicateIds.products.create({
    organizationId: 'org-1', name: 'First', markets: [], platforms: ['web'], targetAudiences: [], uniqueSellingPoints: [],
  })
  assert.throws(() => duplicateIds.products.create({
    organizationId: 'org-2', name: 'Second', markets: [], platforms: ['web'], targetAudiences: [], uniqueSellingPoints: [],
  }), /ID collision/i)

  const emptyIds = CreativeIntelligence.inMemory({ createId: () => '' })
  assert.throws(() => emptyIds.products.create({
    organizationId: 'org-1', name: 'Product', markets: [], platforms: ['web'], targetAudiences: [], uniqueSellingPoints: [],
  }), /generated ID is invalid/i)
})

test('product creation normalizes organization identifiers', () => {
  const app = CreativeIntelligence.inMemory()
  const product = app.products.create({
    organizationId: ' org-1 ',
    name: 'Product',
    markets: [],
    platforms: ['web'],
    targetAudiences: [],
    uniqueSellingPoints: [],
  })
  assert.equal(product.organizationId, 'org-1')
})

test('brief dimensions are normalized and validated at creation', () => {
  const app = CreativeIntelligence.inMemory()
  const product = app.products.create({
    organizationId: 'org-1',
    name: 'Product',
    markets: ['US'],
    platforms: ['web'],
    targetAudiences: ['students'],
    uniqueSellingPoints: ['focus'],
  })
  const brief = app.briefs.createManual({
    organizationId: 'org-1',
    productId: product.id,
    title: 'Brief',
    hook: 'Hook',
    dimensions: { audience: ' students ', market: ' US ', angle: ' focus ', format: ' video ' },
  })
  assert.deepEqual(brief.dimensions, { audience: 'students', market: 'US', angle: 'focus', format: 'video' })

  assert.throws(() => app.briefs.createManual({
    organizationId: 'org-1',
    productId: product.id,
    title: 'Invalid',
    hook: 'Hook',
    dimensions: { audience: '', market: 'US', angle: 'focus', format: 'video' },
  }), /audience is required/i)
})
