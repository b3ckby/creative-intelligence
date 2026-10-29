import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { DataType, newDb } from 'pg-mem'
import { buildApi } from '../src/http/build-api.ts'
import { AiProviderError } from '../src/domain/errors.ts'

async function appWithIntelligence(analysisError?: Error) {
  const db = newDb()
  db.public.registerFunction({ name: 'length', args: [DataType.text], returns: DataType.integer, implementation: (value: string) => value.length })
  db.public.registerFunction({ name: 'trim', args: [DataType.text], returns: DataType.text, implementation: (value: string) => value.trim() })
  db.public.registerFunction({ name: 'set_config', args: [DataType.text, DataType.text, DataType.bool], returns: DataType.text, implementation: (_key: string, value: string) => value })
  db.public.registerFunction({ name: 'clock_timestamp', returns: DataType.timestamptz, implementation: () => new Date('2026-10-27T12:00:00.000Z') })
  const { Pool } = db.adapters.createPg()
  const pool = new Pool()
  await pool.query(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'))
  await pool.query(await readFile(new URL('../migrations/003_provider_sync_limits.sql', import.meta.url), 'utf8'))
  const app = buildApi({
    pool,
    createId: (() => { const ids = ['org-1', 'product-1']; return () => ids.shift() ?? 'unexpected-id' })(),
    now: () => new Date('2026-10-27T12:00:00.000Z'),
    cursorSigningKey: 'test-cursor-signing-key-at-least-32-bytes',
    authenticate: async () => 'member-1',
    scaleAnalytics: {
      async get(_actorUserId: string, _organizationId: string, _productId: string) {
        return { label: 'Public Ad Library momentum proxy', generatedAt: '2026-10-27T12:00:00.000Z', items: [{
          competitorId: 'competitor-1', competitorName: 'Example', activeAdCount: 3, newAdsLast7d: 2,
          newAdsPrev7d: 1, launchVelocityDelta: 1, avgDaysActive: 24.5, longRunnerCount: 2,
          formatMix: { image: 1, video: 1, carousel: 0, text: 1 }, scaleScore: 88, newlyTracked: false,
        }] }
      },
    },
    competitorAnalytics: {
      async history(_actorUserId: string, _organizationId: string, _productId: string, competitorId: string, windowDays: 7 | 30 | 90) {
        return {
          label: 'Public Ad Library momentum proxy' as const, competitor: { id: competitorId, name: 'Example' }, windowDays,
          trend7d: { activeAdCountChange: 2, activeAdCountChangePercent: 20, scaleScoreChange: 4, direction: 'up' as const },
          items: [{ snapshotDate: '2026-10-27', capturedAt: '2026-10-27T12:00:00.000Z', activeAdCount: 12, newAdsLast7d: 5,
            launchVelocityDelta: 3, avgDaysActive: 18.5, longRunnerCount: 4, formatMix: { image: 5, video: 6, carousel: 1, text: 0 },
            scaleScore: 88, newlyTracked: false }],
        }
      },
      async compare(_actorUserId: string, _organizationId: string, _productId: string, competitorIds: string[]) {
        return {
          label: 'Public Ad Library momentum proxy' as const,
          items: competitorIds.map((id) => ({ competitor: { id, name: id === 'competitor-1' ? 'Example' : 'Peer' }, latest: null, trend7d: null })),
        }
      },
    },
    creativeAnalysis: {
      async analyze(_actorUserId: string, organizationId: string, productId: string, competitorAdId: string) {
        if (analysisError) throw analysisError
        return {
          organizationId, productId, competitorAdId, analysisVersion: 'gemini-copy-v1', modelProvider: 'gemini',
          modelName: 'gemini-test', promptVersion: 'creative-tags-v1', inputFingerprint: 'a'.repeat(64),
          tags: { hookCategory: 'pain_point', angle: 'rational', emotion: 'relief', persona: 'busy marketers', format: 'tutorial', offerFrame: 'demo', cta: 'Learn more', visualSummary: 'Copy-led productivity message', funnelStage: 'consideration', confidence: 0.82 },
          analyzedAt: '2026-10-27T12:00:00.000Z', provenance: 'manual', analysisMode: 'copy_only', mediaCount: 0,
        }
      },
    },
    creativeStrategy: {
      async get(_actorUserId: string, organizationId: string, productId: string, competitorId: string) {
        return {
          organizationId, productId, competitorId, totalAds: 8, analyzedAds: 5,
          dimensions: {
            hooks: [{ value: 'pain_point', count: 3, percentage: 60 }],
            angles: [{ value: 'rational', count: 2, percentage: 40 }],
            formats: [], emotions: [], personas: [], offers: [], funnelStages: [],
          },
        }
      },
    },
    aiBriefs: {
      async generate(_actorUserId: string, organizationId: string, productId: string, adId: string, title: string) {
        return {
          id: 'brief-ai-1', organizationId, productId, title, status: 'draft' as const, sourceAdId: adId,
          hook: 'Hook', callToAction: 'Start now', dimensions: { audience: 'Founder', market: 'US', angle: 'rational', format: 'ugc' },
          details: aiBriefDetails(), version: 1, createdAt: '2026-10-27T12:00:00.000Z', updatedAt: '2026-10-27T12:00:00.000Z',
        }
      },
      async handoff() { return { briefId: 'brief-ai-1', version: 1, filename: 'brief-ai-1-v1.md', markdown: '# AI brief\n' } },
    },
  } as Parameters<typeof buildApi>[0])
  await app.inject({ method: 'POST', url: '/organizations', payload: { name: 'Team' } })
  await app.inject({ method: 'POST', url: '/organizations/org-1/products', payload: { name: 'Product', markets: [], platforms: ['web'], targetAudiences: [], uniqueSellingPoints: [] } })
  return { app, pool }
}

test('competitor analytics history route accepts only bounded windows and returns durable proxy snapshots', async () => {
  const { app, pool } = await appWithIntelligence()
  const response = await app.inject({ method: 'GET', url: '/organizations/org-1/products/product-1/competitors/competitor-1/analytics/history?window=30' })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().windowDays, 30)
  assert.equal(response.json().items[0].snapshotDate, '2026-10-27')
  const invalid = await app.inject({ method: 'GET', url: '/organizations/org-1/products/product-1/competitors/competitor-1/analytics/history?window=31' })
  assert.equal(invalid.statusCode, 400)
  await app.close(); await pool.end()
})

test('competitor analytics comparison route requires 2 to 10 explicit competitor IDs', async () => {
  const { app, pool } = await appWithIntelligence()
  const response = await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/analytics/comparison',
    payload: { competitorIds: ['competitor-2', 'competitor-1'] },
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json().items.map((item: { competitor: { id: string } }) => item.competitor.id), ['competitor-2', 'competitor-1'])
  const invalid = await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/analytics/comparison', payload: { competitorIds: ['competitor-1'] },
  })
  assert.equal(invalid.statusCode, 400)
  await app.close(); await pool.end()
})

test('scaling analytics route returns an explicitly labeled public-library proxy', async () => {
  const { app, pool } = await appWithIntelligence()
  const response = await app.inject({ method: 'GET', url: '/organizations/org-1/products/product-1/analytics/scaling' })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().label, 'Public Ad Library momentum proxy')
  assert.equal(response.json().items[0].scaleScore, 88)
  await app.close(); await pool.end()
})

test('creative analysis route returns versioned strict analysis', async () => {
  const { app, pool } = await appWithIntelligence()
  const response = await app.inject({ method: 'POST', url: '/organizations/org-1/products/product-1/ads/ad-1/creative-analysis' })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().analysisVersion, 'gemini-copy-v1')
  assert.equal(response.json().tags.funnelStage, 'consideration')
  await app.close(); await pool.end()
})

test('creative strategy route returns aggregate tag frequencies and coverage', async () => {
  const { app, pool } = await appWithIntelligence()
  const response = await app.inject({ method: 'GET', url: '/organizations/org-1/products/product-1/competitors/competitor-1/creative-strategy' })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().analyzedAds, 5)
  assert.equal(response.json().dimensions.hooks[0].percentage, 60)
  await app.close(); await pool.end()
})

test('AI brief routes create a structured brief and render its production handoff', async () => {
  const { app, pool } = await appWithIntelligence()
  const created = await app.inject({
    method: 'POST', url: '/organizations/org-1/products/product-1/briefs/from-ad/ai',
    payload: { adId: 'ad-1', title: 'AI concept' },
  })
  assert.equal(created.statusCode, 201)
  assert.equal(created.json().details.strategy.objective, 'conversion')
  const handoff = await app.inject({ method: 'GET', url: '/organizations/org-1/briefs/brief-ai-1/handoff' })
  assert.equal(handoff.statusCode, 200)
  assert.equal(handoff.json().filename, 'brief-ai-1-v1.md')
  await app.close(); await pool.end()
})

function aiBriefDetails() {
  return {
    strategy: { targetAudience: 'Founder', objective: 'conversion', keyMessage: 'Answer every lead', tension: 'Missed calls', proofPoints: ['Always on'] },
    artDirection: { format: 'ugc', visualStyle: 'Native', setting: 'Office', talent: 'Founder', audio: 'Voiceover', color: 'Brand', mandatoryElements: ['Logo'] },
    narrative: { storyArc: 'Problem to solution', hooks: [{ visual: 'Phone rings', spoken: 'Never miss a lead', onScreenText: 'Always answer' }], bodyScript: 'Answer every lead.', ctas: ['Start now'] },
    production: { aspectRatios: ['9:16'], durationSeconds: 30, deliverables: ['Primary cut'], shotList: [{ sequence: 1, description: 'Phone rings', audio: 'Ring', onScreenText: 'Always answer' }], handoffNotes: 'Safe areas', sourceAnalysis: { analysisVersion: 'gemini-grounded-v2', confidence: 0.9 } },
  }
}

test('creative analysis route sanitizes upstream failures as documented 502', async () => {
  const { app, pool } = await appWithIntelligence(new AiProviderError())
  const response = await app.inject({ method: 'POST', url: '/organizations/org-1/products/product-1/ads/ad-1/creative-analysis' })
  assert.equal(response.statusCode, 502)
  assert.deepEqual(response.json(), { error: 'AI provider is unavailable' })
  await app.close(); await pool.end()
})

test('creative analysis route sanitizes persistence failures as internal 500 errors', async () => {
  const { app, pool } = await appWithIntelligence(new Error('private database complete failure'))
  const response = await app.inject({ method: 'POST', url: '/organizations/org-1/products/product-1/ads/ad-1/creative-analysis' })
  assert.equal(response.statusCode, 500)
  assert.deepEqual(response.json(), { error: 'Internal server error' })
  assert.doesNotMatch(response.body, /private|database|complete/u)
  await app.close(); await pool.end()
})
