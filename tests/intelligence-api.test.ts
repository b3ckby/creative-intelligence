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
    creativeAnalysis: {
      async analyze(_actorUserId: string, organizationId: string, productId: string, competitorAdId: string) {
        if (analysisError) throw analysisError
        return {
          organizationId, productId, competitorAdId, analysisVersion: 'gemini-copy-v1', modelProvider: 'gemini',
          modelName: 'gemini-test', promptVersion: 'creative-tags-v1', inputFingerprint: 'a'.repeat(64),
          tags: { hookCategory: 'pain_point', angle: 'rational', emotion: 'relief', persona: 'busy marketers', format: 'tutorial', offerFrame: 'demo', cta: 'Learn more', visualSummary: 'Copy-led productivity message', funnelStage: 'consideration', confidence: 0.82 },
          analyzedAt: '2026-10-27T12:00:00.000Z',
        }
      },
    },
  } as Parameters<typeof buildApi>[0])
  await app.inject({ method: 'POST', url: '/organizations', payload: { name: 'Team' } })
  await app.inject({ method: 'POST', url: '/organizations/org-1/products', payload: { name: 'Product', markets: [], platforms: ['web'], targetAudiences: [], uniqueSellingPoints: [] } })
  return { app, pool }
}

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
