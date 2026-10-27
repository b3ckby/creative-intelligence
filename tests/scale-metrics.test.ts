import test from 'node:test'
import assert from 'node:assert/strict'

import type { CompetitorAd } from '../src/domain/types.ts'
import {
  LONG_RUNNER_DAYS,
  NEWLY_TRACKED_DAYS,
  NEWLY_TRACKED_MAX_ADS,
  PUBLIC_LIBRARY_MOMENTUM_PROXY_LABEL,
  computeScaleMetrics,
  scoreScaleMetricRows,
  type ScaleMetricsAd,
} from '../src/analytics/scale-metrics.ts'

const NOW = Date.parse('2026-10-27T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const isoDaysAgo = (days: number) => new Date(NOW - days * DAY).toISOString()

function ad(overrides: Partial<ScaleMetricsAd> & Pick<ScaleMetricsAd, 'id' | 'competitorId'>): ScaleMetricsAd {
  return {
    organizationId: 'org-1',
    productId: 'product-1',
    providerName: 'test',
    platform: 'meta',
    externalId: overrides.id,
    advertiserName: overrides.competitorId,
    body: 'Copy',
    callToAction: null,
    startedAt: isoDaysAgo(30),
    isActive: false,
    mediaUrls: [],
    sourceUrl: 'https://example.com/ad',
    firstSeenAt: isoDaysAgo(30),
    lastSeenAt: isoDaysAgo(20),
    ...overrides,
  }
}

const competitors = [
  { id: 'alpha', name: 'Alpha' },
  { id: 'beta', name: 'Beta' },
]

test('exports an explicit public-library proxy label and analytics input remains assignable from domain ads', () => {
  const domainAd = ad({ id: 'domain', competitorId: 'alpha' }) satisfies CompetitorAd
  const analyticsAd: ScaleMetricsAd = domainAd

  assert.match(PUBLIC_LIBRARY_MOMENTUM_PROXY_LABEL, /public.*library.*momentum.*proxy/i)
  assert.equal(analyticsAd.id, 'domain')
})

test('computes fixed-clock activity, launch windows, active-only long runners, and average days active', () => {
  const rows = computeScaleMetrics([
    ad({ id: 'active-long', competitorId: 'alpha', isActive: true, startedAt: isoDaysAgo(30), firstSeenAt: isoDaysAgo(30), lastSeenAt: isoDaysAgo(0) }),
    ad({ id: 'inactive', competitorId: 'alpha', startedAt: isoDaysAgo(10), firstSeenAt: isoDaysAgo(20), lastSeenAt: isoDaysAgo(6) }),
    ad({ id: 'last-window-edge', competitorId: 'alpha', startedAt: isoDaysAgo(7), firstSeenAt: isoDaysAgo(20), lastSeenAt: isoDaysAgo(0) }),
    ad({ id: 'previous-window', competitorId: 'alpha', startedAt: isoDaysAgo(8), firstSeenAt: isoDaysAgo(20), lastSeenAt: isoDaysAgo(0) }),
    ad({ id: 'previous-edge', competitorId: 'alpha', startedAt: isoDaysAgo(14), firstSeenAt: isoDaysAgo(20), lastSeenAt: isoDaysAgo(0) }),
  ], competitors, NOW)
  const alpha = rows.find((row) => row.competitorId === 'alpha')!

  assert.equal(LONG_RUNNER_DAYS, 21)
  assert.equal(alpha.activeAdCount, 1)
  assert.equal(alpha.newAdsLast7d, 1)
  assert.equal(alpha.newAdsPrev7d, 3)
  assert.equal(alpha.launchVelocityDelta, -2)
  assert.equal(alpha.longRunnerCount, 1)
  assert.equal(alpha.avgDaysActive, 12.6)
})

test('uses explicit ad types including carousel before legacy media fallback classification', () => {
  const [row] = computeScaleMetrics([
    ad({ id: 'carousel', competitorId: 'alpha', adType: 'carousel', mediaUrls: ['https://cdn.example.com/creative.mp4'] }),
    ad({ id: 'explicit-image', competitorId: 'alpha', adType: 'image', mediaUrls: ['https://cdn.example.com/creative.mp4'] }),
    ad({ id: 'explicit-video', competitorId: 'alpha', adType: 'video', mediaUrls: [] }),
    ad({ id: 'explicit-text', competitorId: 'alpha', adType: 'text', mediaUrls: ['https://cdn.example.com/creative.jpg'] }),
    ad({ id: 'legacy-host-video', competitorId: 'alpha', adType: null, mediaUrls: ['https://video-cdg4-1.xx.fbcdn.net/asset'] }),
    ad({ id: 'legacy-extension-video', competitorId: 'alpha', mediaUrls: ['https://cdn.example.com/creative.MP4?token=1'] }),
    ad({ id: 'legacy-image', competitorId: 'alpha', mediaUrls: ['https://cdn.example.com/creative.jpg'] }),
    ad({ id: 'legacy-text', competitorId: 'alpha', mediaUrls: [] }),
  ], [{ id: 'alpha', name: 'Alpha' }], NOW)

  assert.deepEqual(row?.formatMix, { image: 2, video: 3, carousel: 1, text: 2 })
})

test('suppresses velocity for newly tracked competitors with at most five ads', () => {
  const recentAds = Array.from({ length: NEWLY_TRACKED_MAX_ADS }, (_, index) => ad({
    id: `recent-${index}`,
    competitorId: 'alpha',
    startedAt: isoDaysAgo(1),
    firstSeenAt: isoDaysAgo(NEWLY_TRACKED_DAYS),
    lastSeenAt: isoDaysAgo(0),
  }))
  const establishedAds = Array.from({ length: NEWLY_TRACKED_MAX_ADS + 1 }, (_, index) => ad({
    id: `established-${index}`,
    competitorId: 'beta',
    startedAt: isoDaysAgo(1),
    firstSeenAt: isoDaysAgo(1),
    lastSeenAt: isoDaysAgo(0),
  }))
  const rows = computeScaleMetrics([...recentAds, ...establishedAds], competitors, NOW)
  const alpha = rows.find((row) => row.competitorId === 'alpha')!
  const beta = rows.find((row) => row.competitorId === 'beta')!

  assert.equal(alpha.newlyTracked, true)
  assert.equal(alpha.launchVelocityDelta, 0)
  assert.equal(beta.newlyTracked, false)
  assert.equal(beta.launchVelocityDelta, 6)
})

test('accepts optional impression bounds and renormalizes score weights when all are absent', () => {
  const withoutImpressions = computeScaleMetrics([
    ad({ id: 'active', competitorId: 'alpha', isActive: true, startedAt: isoDaysAgo(20) }),
  ], competitors, NOW)
  assert.equal(withoutImpressions.find((row) => row.competitorId === 'alpha')?.scaleScore, 24)
  assert.equal(withoutImpressions.find((row) => row.competitorId === 'alpha')?.impressionWeight, undefined)

  const withImpressions = computeScaleMetrics([
    ad({ id: 'active-impressions', competitorId: 'alpha', isActive: true, startedAt: isoDaysAgo(20), impressionsLowerBound: 100, impressionsUpperBound: 300 }),
  ], competitors, NOW)
  const alpha = withImpressions.find((row) => row.competitorId === 'alpha')!
  assert.equal(alpha.impressionWeight, 200)
  assert.equal(alpha.scaleScore, 35)
})

test('scores flat ties and a single competitor sensibly', () => {
  const tied = computeScaleMetrics([
    ad({ id: 'z-ad', competitorId: 'z', isActive: true, startedAt: isoDaysAgo(22), firstSeenAt: isoDaysAgo(30) }),
    ad({ id: 'a-ad', competitorId: 'a', isActive: true, startedAt: isoDaysAgo(22), firstSeenAt: isoDaysAgo(30) }),
  ], [{ id: 'z', name: 'Same' }, { id: 'a', name: 'Same' }], NOW)

  assert.deepEqual(tied.map((row) => [row.competitorId, row.scaleScore]), [['a', 32], ['z', 32]])

  const single = computeScaleMetrics([
    ad({ id: 'only-ad', competitorId: 'only', isActive: true, startedAt: isoDaysAgo(22), firstSeenAt: isoDaysAgo(30) }),
  ], [{ id: 'only', name: 'Only' }], NOW)
  assert.equal(single[0]?.scaleScore, 32)
})

test('orders by score descending, then competitor name and id deterministically', () => {
  const rows = computeScaleMetrics([
    ad({ id: 'winner', competitorId: 'winner', isActive: true }),
  ], [
    { id: 'z', name: 'Same' },
    { id: 'winner', name: 'Winner' },
    { id: 'b', name: 'Able' },
    { id: 'a', name: 'Able' },
  ], NOW)

  assert.deepEqual(rows.map((row) => row.competitorId), ['winner', 'a', 'b', 'z'])
})

test('scores pre-aggregated database rows with the same deterministic proxy formula', () => {
  const rows = scoreScaleMetricRows([
    { competitorId: 'alpha', competitorName: 'Alpha', activeAdCount: 4, newAdsLast7d: 3, newAdsPrev7d: 1, launchVelocityDelta: 2, avgDaysActive: 25, longRunnerCount: 3, formatMix: { image: 2, video: 2, carousel: 0, text: 0 }, impressionWeight: 500, newlyTracked: false },
    { competitorId: 'beta', competitorName: 'Beta', activeAdCount: 1, newAdsLast7d: 0, newAdsPrev7d: 0, launchVelocityDelta: 0, avgDaysActive: 4, longRunnerCount: 0, formatMix: { image: 1, video: 0, carousel: 0, text: 0 }, newlyTracked: false },
  ])
  assert.equal(rows[0]?.competitorId, 'alpha')
  assert.equal(rows[0]?.scaleScore, 100)
  assert.equal(rows[1]?.scaleScore, 0)
})
