import assert from 'node:assert/strict'
import test from 'node:test'

import { PostgresAutoAnalysisService, type ClaimedCreativeAnalysisJob } from '../src/creative-analysis/postgres-auto-analysis-service.ts'
import type { MediaStore } from '../src/media/content-addressed-store.ts'

const checksum = 'a'.repeat(64)
const job: ClaimedCreativeAnalysisJob = {
  job_id: '11111111-1111-4111-8111-111111111111', organization_id: 'org-1', product_id: 'product-1', competitor_ad_id: 'ad-1',
  advertiser_name: 'Example', body: 'Save time', call_to_action: 'LEARN_MORE', attempt: 1, max_attempts: 5,
  fence_token: 'f'.repeat(64), media: [{ slotKind: 'structured_source', position: 0, checksum, mediaType: 'image/png', byteSize: 3 }],
}

class FakePool {
  readonly calls: Array<{ text: string; values?: unknown[] }> = []
  beginOutcome: 'run' | 'cached' = 'run'
  async query<Row extends Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number }> {
    this.calls.push({ text, ...(values ? { values } : {}) })
    if (text.includes('app_claim_creative_analysis_jobs')) return { rows: [job] as unknown as Row[], rowCount: 1 }
    if (text.includes('app_begin_auto_analysis')) return { rows: [{ outcome: this.beginOutcome, analysis_claim: this.beginOutcome === 'run' ? 'c'.repeat(64) : null }] as unknown as Row[], rowCount: 1 }
    if (text.includes('app_finish_auto_analysis_success')) return { rows: [{ ok: true }] as unknown as Row[], rowCount: 1 }
    if (text.includes('app_finish_auto_analysis_failure')) return { rows: [{ ok: true }] as unknown as Row[], rowCount: 1 }
    throw new Error('unexpected query')
  }
}

const store: MediaStore = {
  async put() { throw new Error('not used') },
  async read(value) { assert.equal(value, checksum); return { bytes: Buffer.from([1, 2, 3]), byteSize: 3, mediaType: 'image/png' } },
}

test('automatic analysis reads only claimed checksums from CAS and finalizes with fence tokens', async () => {
  const pool = new FakePool()
  let input: unknown
  const service = new PostgresAutoAnalysisService(pool as never, store, {
    provider: 'gemini', model: 'gemini-test', async analyze(value) { input = value; return { hookCategory: 'pain_point', angle: 'rational', emotion: 'relief', persona: 'busy marketers', format: 'tutorial', offerFrame: 'demo', cta: 'Learn more', onScreenText: 'Save time', visualSummary: 'Blue card', funnelStage: 'consideration', confidence: 0.8 } },
  }, 'worker-1', { leaseSeconds: 60, batchSize: 2, dailyLimit: 100, maxMediaCount: 2, maxMediaBytes: 10, backoffBaseMs: 1000, backoffMaxMs: 10000 })
  const [claimed] = await service.claim()
  await service.run(claimed!)
  assert.deepEqual((input as { media: unknown[] }).media.length, 1)
  const finish = pool.calls.find((call) => call.text.includes('app_finish_auto_analysis_success'))
  assert.equal(finish?.values?.[2], job.fence_token)
  assert.equal(JSON.stringify(pool.calls).includes('http'), false)
})

test('automatic analysis returns cached manual or automatic result without another model call', async () => {
  const pool = new FakePool(); pool.beginOutcome = 'cached'
  let calls = 0
  const service = new PostgresAutoAnalysisService(pool as never, store, { provider: 'gemini', model: 'gemini-test', async analyze() { calls += 1; throw new Error('must not run') } }, 'worker-1',
    { leaseSeconds: 60, batchSize: 1, dailyLimit: 100, maxMediaCount: 2, maxMediaBytes: 10, backoffBaseMs: 1000, backoffMaxMs: 10000 })
  await service.run(job)
  assert.equal(calls, 0)
  assert.equal(pool.calls.some((call) => call.text.includes('app_finish_auto_analysis_success')), false)
})
