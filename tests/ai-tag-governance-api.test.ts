import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { DataType, newDb } from 'pg-mem'

import { buildApi } from '../src/http/build-api.ts'
import type { CreativeTagReviewItem } from '../src/creative-analysis/creative-tag-review.ts'

const originalTags = { hookCategory: 'pain_point', angle: 'rational', emotion: 'relief', persona: 'Founder', format: 'ugc', offerFrame: 'demo', cta: 'Learn more', visualSummary: 'Founder demo', funnelStage: 'consideration', confidence: 0.9 } as const
const analysis = { organizationId: 'org-1', productId: 'product-1', competitorAdId: 'ad-1', analysisVersion: 'v1', modelProvider: 'gemini', modelName: 'gemini-test', promptVersion: 'prompt-v1', inputFingerprint: 'a'.repeat(64), tags: originalTags, analyzedAt: '2026-10-29T09:00:00.000Z', provenance: 'automatic' as const, analysisMode: 'media' as const, mediaCount: 1 }
const pending: CreativeTagReviewItem = { advertiserName: 'Orbit', analysis, status: 'pending', review: null, originalTags, effectiveTags: originalTags, stale: false }

async function fixture() {
  const db = newDb()
  db.public.registerFunction({ name: 'length', args: [DataType.text], returns: DataType.integer, implementation: (value: string) => value.length })
  db.public.registerFunction({ name: 'trim', args: [DataType.text], returns: DataType.text, implementation: (value: string) => value.trim() })
  db.public.registerFunction({ name: 'set_config', args: [DataType.text, DataType.text, DataType.bool], returns: DataType.text, implementation: (_key: string, value: string) => value })
  const { Pool } = db.adapters.createPg(); const pool = new Pool()
  await pool.query(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'))
  await pool.query(await readFile(new URL('../migrations/003_provider_sync_limits.sql', import.meta.url), 'utf8'))
  const calls: unknown[][] = []
  const reviews = {
    async list(...args: unknown[]) { calls.push(['list', ...args]); return [pending] },
    async detail(...args: unknown[]) { calls.push(['detail', ...args]); return pending },
    async history(...args: unknown[]) { calls.push(['history', ...args]); return [] },
    async submit(...args: unknown[]) { calls.push(['submit', ...args]); return { organizationId: 'org-1', productId: 'product-1', competitorAdId: 'ad-1', analysisVersion: 'v1', inputFingerprint: 'a'.repeat(64), reviewVersion: 1, decision: 'approved' as const, corrections: null, reason: 'Verified against source.', reviewerUserId: 'member-1', reviewedAt: '2026-10-29T10:00:00.000Z' } },
  }
  const app = buildApi({ pool, createId: (() => { const ids = ['org-1']; return () => ids.shift() ?? 'id' })(), now: () => new Date('2026-10-29T10:00:00.000Z'), authenticate: async () => 'member-1', cursorSigningKey: 'test-cursor-signing-key-at-least-32-bytes', creativeTagReviews: reviews } as Parameters<typeof buildApi>[0])
  await app.inject({ method: 'POST', url: '/organizations', payload: { name: 'Team' } })
  return { app, pool, calls }
}

test('creative tag governance API lists, details, and histories exact analysis identities', async () => {
  const { app, pool, calls } = await fixture()
  const list = await app.inject({ method: 'GET', url: '/organizations/org-1/creative-tag-reviews?productId=product-1&status=pending&limit=25' })
  assert.equal(list.statusCode, 200); assert.equal(list.json().items[0].status, 'pending'); assert.deepEqual(list.json().items[0].originalTags, list.json().items[0].effectiveTags)
  const identity = `analysisVersion=v1&inputFingerprint=${'a'.repeat(64)}`
  assert.equal((await app.inject({ method: 'GET', url: `/organizations/org-1/ads/ad-1/creative-tag-review?${identity}` })).statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: `/organizations/org-1/ads/ad-1/creative-tag-review/history?${identity}&limit=50` })).statusCode, 200)
  assert.equal(calls.filter(([name]) => name === 'list').length, 1)
  await app.close(); await pool.end()
})

test('creative tag governance API appends strict decisions without accepting provenance from the browser', async () => {
  const { app, pool, calls } = await fixture()
  const response = await app.inject({ method: 'POST', url: '/organizations/org-1/ads/ad-1/creative-tag-review', payload: {
    analysisVersion: 'v1', inputFingerprint: 'a'.repeat(64), expectedReviewVersion: 0, decision: 'approved', corrections: null, reason: 'Verified against source.',
  } })
  assert.equal(response.statusCode, 201); assert.equal(response.json().reviewerUserId, 'member-1')
  assert.equal(calls.filter(([name]) => name === 'submit').length, 1)
  const forged = await app.inject({ method: 'POST', url: '/organizations/org-1/ads/ad-1/creative-tag-review', payload: {
    analysisVersion: 'v1', inputFingerprint: 'a'.repeat(64), expectedReviewVersion: 0, decision: 'approved', corrections: null, reason: 'Verified.', reviewerUserId: 'attacker',
  } })
  assert.equal(forged.statusCode, 400)
  await app.close(); await pool.end()
})
