import assert from 'node:assert/strict'
import test from 'node:test'

import { buildAiBriefDraft, renderProductionHandoff } from '../src/briefs/ai-brief.ts'
import type { CompetitorAd, Product } from '../src/domain/types.ts'

const product: Product = {
  id: 'product-1', organizationId: 'org-1', name: 'Northstar', markets: ['US'], platforms: ['web'],
  targetAudiences: ['Founders'], uniqueSellingPoints: ['Never miss a customer call'], archivedAt: null, createdAt: '2026-10-01T00:00:00.000Z',
}
const ad: CompetitorAd = {
  id: 'ad-1', organizationId: 'org-1', productId: 'product-1', competitorId: 'competitor-1', providerName: 'manual-meta', platform: 'meta',
  externalId: 'external-1', advertiserName: 'Orbit', body: 'Missed calls cost revenue. Answer every lead.', callToAction: 'Start now', startedAt: '2026-10-01T00:00:00.000Z',
  isActive: true, mediaUrls: ['https://example.test/ad.jpg'], sourceUrl: 'https://example.test/ad', firstSeenAt: '2026-10-01T00:00:00.000Z', lastSeenAt: '2026-10-20T00:00:00.000Z',
}
const tags = {
  hookCategory: 'pain_point', angle: 'rational', emotion: 'urgency', persona: 'Founder', format: 'ugc', offerFrame: 'demo', cta: 'Start now',
  onScreenText: 'Never miss a lead', visualSummary: 'Founder answers a customer call in a bright office.', funnelStage: 'conversion', confidence: 0.9,
} as const

test('AI brief draft turns product, ad and model tags into a bounded production-ready structure', () => {
  const draft = buildAiBriefDraft(product, ad, tags)
  assert.deepEqual(draft.dimensions, { audience: 'Founder', market: 'US', angle: 'rational', format: 'ugc' })
  assert.equal(draft.details.strategy.objective, 'conversion')
  assert.equal(draft.details.strategy.keyMessage, 'Founder answers a customer call in a bright office.')
  assert.deepEqual(draft.details.strategy.proofPoints, ['Never miss a customer call'])
  assert.equal(draft.details.narrative.hooks[0]?.onScreenText, 'Never miss a lead')
  assert.equal(draft.details.production.shotList.length, 3)
  assert.deepEqual(draft.details.production.aspectRatios, ['9:16', '1:1'])
  assert.deepEqual(draft.details.production.sourceAnalysis, { analysisVersion: 'gemini-grounded-v2', confidence: 0.9 })
})

test('production handoff renders deterministic markdown with provenance and shot ownership', () => {
  const draft = buildAiBriefDraft(product, ad, tags)
  const markdown = renderProductionHandoff({
    id: 'brief-1', organizationId: 'org-1', productId: 'product-1', title: 'Missed-call concept', status: 'approved', sourceAdId: ad.id,
    hook: draft.hook, callToAction: draft.callToAction, dimensions: draft.dimensions, details: draft.details, version: 3,
    createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T01:00:00.000Z',
  })
  assert.match(markdown, /^# Missed-call concept/mu)
  assert.match(markdown, /## Strategic core[\s\S]*Founder answers a customer call/mu)
  assert.match(markdown, /## Shot list[\s\S]*\| 1 \|/mu)
  assert.match(markdown, /Source ad: `ad-1`/u)
  assert.match(markdown, /Analysis: `gemini-grounded-v2` \(confidence 90%\)/u)
})
