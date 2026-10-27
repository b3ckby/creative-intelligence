import assert from 'node:assert/strict'
import test from 'node:test'

import { decodeAdRow } from '../src/persistence/catalog-row-decoders.ts'

const storedAd = {
  id: 'ad-1', organization_id: 'org-1', product_id: 'product-1', competitor_id: 'competitor-1',
  provider_name: 'apify-meta-ads', platform: 'meta', external_id: 'external-1', advertiser_name: 'Orbit',
  body: 'Copy', call_to_action: null, started_at: new Date('2026-10-01T00:00:00Z'), is_active: true,
  media_urls: ['https://cdn.example.test/ad.mp4'], source_url: 'https://example.test/ad',
  first_seen_at: new Date('2026-10-26T00:00:00Z'), last_seen_at: new Date('2026-10-26T00:00:00Z'),
}

test('persisted ad decoder exposes expanded metadata and structured media', () => {
  const decoded = decodeAdRow({
    ...storedAd,
    page_id: 'page-1', headline: 'Headline', description: 'Description', display_format: 'VIDEO', ad_type: 'video',
    ended_at: new Date('2026-10-02T00:00:00Z'), publisher_platforms: ['facebook'],
    impressions_lower_bound: '100', impressions_upper_bound: '200', spend_lower_bound: '12.5', spend_upper_bound: '20',
    currency: 'USD',
    media: [{ kind: 'video', sourceUrl: 'https://cdn.example.test/ad.mp4', posterUrl: null, cardIndex: null, order: 0 }],
  })

  assert.equal(decoded.pageId, 'page-1')
  assert.equal(decoded.headline, 'Headline')
  assert.equal(decoded.description, 'Description')
  assert.equal(decoded.displayFormat, 'VIDEO')
  assert.equal(decoded.adType, 'video')
  assert.equal(decoded.endedAt, '2026-10-02T00:00:00.000Z')
  assert.deepEqual(decoded.publisherPlatforms, ['facebook'])
  assert.equal(decoded.impressionsLowerBound, 100)
  assert.equal(decoded.impressionsUpperBound, 200)
  assert.equal(decoded.spendLowerBound, 12.5)
  assert.equal(decoded.spendUpperBound, 20)
  assert.equal(decoded.currency, 'USD')
  assert.deepEqual(decoded.media, [{ kind: 'video', sourceUrl: 'https://cdn.example.test/ad.mp4', posterUrl: null, cardIndex: null, order: 0 }])
})

test('persisted ad decoder preserves missing metadata as null rather than zero', () => {
  const decoded = decodeAdRow({
    ...storedAd,
    page_id: null, headline: null, description: null, display_format: null, ad_type: null, ended_at: null,
    publisher_platforms: null, impressions_lower_bound: null, impressions_upper_bound: null,
    spend_lower_bound: null, spend_upper_bound: null, currency: null, media: null,
  })

  assert.equal(decoded.pageId, null)
  assert.equal(decoded.headline, null)
  assert.equal(decoded.description, null)
  assert.equal(decoded.displayFormat, null)
  assert.equal(decoded.adType, null)
  assert.equal(decoded.endedAt, null)
  assert.equal(decoded.publisherPlatforms, null)
  assert.equal(decoded.impressionsLowerBound, null)
  assert.equal(decoded.impressionsUpperBound, null)
  assert.equal(decoded.spendLowerBound, null)
  assert.equal(decoded.spendUpperBound, null)
  assert.equal(decoded.currency, null)
  assert.equal(decoded.media, null)
})
