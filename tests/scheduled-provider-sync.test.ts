import assert from 'node:assert/strict'
import test from 'node:test'

import type { AdCollectionContext, CollectedAd } from '../src/ad-ingestion/ad-source-provider.ts'
import { ApifyMetaAdsProvider } from '../src/ad-ingestion/apify-meta-ads-provider.ts'
import { deterministicBackoffMs, ScheduledProviderSyncWorker } from '../src/scheduling/scheduled-provider-sync-worker.ts'
import { ExternalProviderError } from '../src/domain/errors.ts'
import { PostgresScheduledAdSyncService } from '../src/persistence/postgres-scheduled-ad-sync-service.ts'

const context: AdCollectionContext = { organizationId: 'org-1', productId: 'product-1', competitorId: 'competitor-1' }

test('Apify exposes an explicitly complete bounded actor snapshot while collect stays compatible', async () => {
  const provider = new ApifyMetaAdsProvider({ apiToken: 'secret-test-token', facebookPageUrl: 'https://facebook.com/orbit' }, {
    fetch: async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  assert.deepEqual(await provider.collect(context), [])
  assert.deepEqual(await provider.collectSnapshot(context), {
    items: [], completeness: 'complete', scopeKey: 'apify-meta-ads:v1:country=ALL;active=all',
  })
})

test('worker exposes poll failures and recovers readiness after a successful poll', async () => {
  let polls = 0
  const errors: Array<{ category: string }> = []
  const worker = new ScheduledProviderSyncWorker({
    intervalMs: 100,
    concurrency: 1,
    batchSize: 1,
    poll: async () => { if (++polls === 1) throw new Error('tenant secret'); return [] },
    run: async () => undefined,
    onPollError: (error) => errors.push(error),
    sleep: async () => await new Promise<void>((resolve) => setImmediate(resolve)),
  })
  const started = worker.start()
  while (polls < 2) await new Promise((resolve) => setImmediate(resolve))
  await worker.stop()
  await started
  assert.deepEqual(errors, [{ category: 'poll_failed' }])
  assert.equal(worker.state().currentFailure, null)
  assert.ok(worker.state().firstSuccessfulPollAt)
  assert.ok(worker.state().lastSuccessfulPollAt)
})

test('retry backoff is deterministic, exponential, and bounded', () => {
  assert.equal(deterministicBackoffMs(1, 1_000, 5_000), 1_000)
  assert.equal(deterministicBackoffMs(2, 1_000, 5_000), 2_000)
  assert.equal(deterministicBackoffMs(4, 1_000, 5_000), 5_000)
  assert.throws(() => deterministicBackoffMs(0, 1_000, 5_000))
})

test('worker bounds concurrency and stops without starting another poll', async () => {
  let active = 0
  let maximum = 0
  let polls = 0
  const releases: Array<() => void> = []
  const worker = new ScheduledProviderSyncWorker({
    intervalMs: 1_000,
    concurrency: 2,
    batchSize: 3,
    poll: async () => {
      polls += 1
      return [1, 2, 3]
    },
    run: async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise<void>((resolve) => { releases.push(resolve) })
      active -= 1
    },
    sleep: async () => await new Promise<void>((resolve) => setImmediate(resolve)),
  })
  const started = worker.start()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(maximum, 2)
  const stopped = worker.stop()
  while (releases.length > 0 || active > 0) {
    releases.shift()?.()
    await new Promise((resolve) => setImmediate(resolve))
  }
  await stopped
  await started
  assert.equal(polls, 1)
})

test('worker surfaces sanitized per-item failures without making polling unhealthy', async () => {
  let polls = 0
  const failures: Array<{ category: string; at: string }> = []
  const worker = new ScheduledProviderSyncWorker({
    intervalMs: 100, concurrency: 1, batchSize: 1,
    poll: async () => (++polls === 1 ? [1] : []),
    run: async () => { throw new Error('tenant secret') },
    onRunError: (failure) => failures.push(failure),
    sleep: async () => await new Promise<void>((resolve) => setImmediate(resolve)),
  })
  const started = worker.start()
  while (polls < 2) await new Promise((resolve) => setImmediate(resolve))
  await worker.stop()
  await started
  assert.equal(failures.length, 1)
  assert.equal(failures[0]?.category, 'run_failed')
  assert.match(failures[0]?.at ?? '', /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(worker.state().currentFailure, null)
  assert.deepEqual(worker.state().lastRunFailure, failures[0])
})

test('scheduled service durably finalizes a provider failure then exposes a sanitized run failure', async () => {
  const queries: Array<{ sql: string; values: unknown[] | undefined }> = []
  const pool = { query: async (sql: string, values?: unknown[]) => {
    queries.push({ sql, values })
    return { rows: [{ app_finish_ad_sync_run_failure: true }], rowCount: 1 }
  } }
  const service = new PostgresScheduledAdSyncService(
    pool as never, {} as never, 'worker-1',
    { leaseSeconds: 30, maxAttempts: 3, backoffBaseMs: 1_000, backoffMaxMs: 60_000 },
    async () => { throw new ExternalProviderError() },
  )
  await assert.rejects(() => service.run({
    id: 'run-1', organization_id: 'org-1', product_id: 'product-1', competitor_id: 'competitor-1',
    provider_name: 'apify-meta-ads', actor_user_id: 'admin-1', attempt: 1, max_attempts: 3, fence_token: 'fence-1',
  }), { message: 'Scheduled sync run failed' })
  assert.equal(queries.length, 1)
  assert.match(queries[0]!.sql, /app_finish_ad_sync_run_failure/)
  assert.deepEqual(queries[0]!.values, ['run-1', 'worker-1', 'fence-1', 'provider', 1])
})

void (null as CollectedAd | null)
