import test from 'node:test'
import assert from 'node:assert/strict'

import { CreativeIntelligence } from '../src/creative-intelligence.ts'
import { ManualMetaAdsProvider } from '../src/ad-ingestion/manual-meta-ads-provider.ts'

test('turns a manually imported Meta ad into a product brief', async () => {
  const manualProvider = new ManualMetaAdsProvider([
    {
      externalId: 'meta-100',
      advertiserName: 'Study Buddy',
      body: 'Stop procrastinating. Finish your homework in focused sessions.',
      callToAction: 'INSTALL_NOW',
      startedAt: '2026-10-01T00:00:00.000Z',
      isActive: true,
      mediaUrls: ['https://cdn.example.com/ad-100.mp4'],
      sourceUrl: 'https://www.facebook.com/ads/library/?id=meta-100',
    },
  ])
  const app = CreativeIntelligence.inMemory({ providers: new Map([['manual-meta', manualProvider]]) })

  const product = app.products.create({
    organizationId: 'org-1',
    name: 'Focus Timer',
    markets: ['US'],
    platforms: ['ios'],
    targetAudiences: ['students'],
    uniqueSellingPoints: ['stay focused with short sessions'],
  })

  const competitor = app.competitors.create({
    organizationId: 'org-1',
    productId: product.id,
    name: 'Study Buddy',
    metaPageUrl: 'https://www.facebook.com/study-buddy',
  })

  const result = await app.ads.collect(
    'manual-meta',
    {
      organizationId: 'org-1',
      productId: product.id,
      competitorId: competitor.id,
    },
  )

  assert.equal(result.inserted, 1)
  assert.equal(result.duplicates, 0)

  const [ad] = app.ads.listForCompetitor('org-1', competitor.id, 100)
  assert.ok(ad)
  assert.equal(ad.platform, 'meta')
  assert.equal(ad.externalId, 'meta-100')

  const brief = app.briefs.createFromAd({
    organizationId: 'org-1',
    productId: product.id,
    adId: ad.id,
    title: 'Student focus concept',
    dimensions: {
      audience: 'students',
      market: 'US',
      angle: 'anti-procrastination',
      format: 'video',
    },
  })

  assert.equal(brief.status, 'draft')
  assert.equal(brief.sourceAdId, ad.id)
  assert.equal(brief.hook, ad.body)
})

test('deduplicates repeated imports from the same provider', async () => {
  const record = {
    externalId: 'meta-100',
    advertiserName: 'Study Buddy',
    body: 'Focus now',
    startedAt: '2026-10-01T00:00:00.000Z',
    isActive: true,
    mediaUrls: [],
    sourceUrl: 'https://www.facebook.com/ads/library/?id=meta-100',
  }
  const app = CreativeIntelligence.inMemory({
    providers: new Map([['manual-meta', new ManualMetaAdsProvider([record])]]),
  })
  const product = app.products.create({
    organizationId: 'org-1',
    name: 'Focus Timer',
    markets: ['US'],
    platforms: ['ios'],
    targetAudiences: ['students'],
    uniqueSellingPoints: ['focus'],
  })
  const competitor = app.competitors.create({
    organizationId: 'org-1',
    productId: product.id,
    name: 'Study Buddy',
  })

  await app.ads.collect('manual-meta', {
    organizationId: 'org-1',
    productId: product.id,
    competitorId: competitor.id,
  })
  const second = await app.ads.collect('manual-meta', {
    organizationId: 'org-1',
    productId: product.id,
    competitorId: competitor.id,
  })

  assert.deepEqual(second, { inserted: 0, duplicates: 1 })
  assert.equal(app.ads.listForCompetitor('org-1', competitor.id, 100).length, 1)
})

test('enforces organization boundaries when creating competitors and briefs', async () => {
  const app = CreativeIntelligence.inMemory()
  const product = app.products.create({
    organizationId: 'org-1',
    name: 'Focus Timer',
    markets: ['US'],
    platforms: ['ios'],
    targetAudiences: ['students'],
    uniqueSellingPoints: ['focus'],
  })

  assert.throws(
    () => app.competitors.create({ organizationId: 'org-2', productId: product.id, name: 'Wrong tenant' }),
    /Product does not belong to organization/,
  )
})
