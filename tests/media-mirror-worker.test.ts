import assert from 'node:assert/strict'
import test from 'node:test'

import type { SqlPool } from '../src/persistence/postgres-organization-repository.ts'
import { MediaFetchError } from '../src/media/safe-media-fetcher.ts'
import { PostgresMediaMirrorService, type ClaimedMediaMirrorJob } from '../src/media/postgres-media-mirror-service.ts'

const job: ClaimedMediaMirrorJob = {
  id: '00000000-0000-0000-0000-000000000001', organization_id: 'org', ad_id: 'ad', slot_kind: 'structured_source',
  position: 0, media_kind: 'image', desired_source_url: 'https://secret.example.test/a.jpg?token=secret',
  attempt: 1, max_attempts: 5, lease_owner: 'worker', fence_token: 'fence',
}

test('media mirror service stores fetched content before atomically linking a fenced job', async () => {
  const queries: Array<{ text: string; values?: readonly unknown[] }> = []
  const pool = { query: async (text: string, values?: readonly unknown[]) => {
    queries.push({ text, ...(values ? { values } : {}) })
    return { rows: text.includes('app_finish_media_mirror_success') ? [{ ok: true }] : [], rowCount: 1 }
  } } as SqlPool
  const events: string[] = []
  const service = new PostgresMediaMirrorService(pool, 'worker', {
    leaseSeconds: 30, batchSize: 10, backfillBatchSize: 100, backoffBaseMs: 1000, backoffMaxMs: 60_000,
  }, {
    fetcher: { fetch: async (url, kind) => { events.push(`fetch:${kind}:${url}`); return { bytes: Buffer.from('bytes'), checksum: 'a'.repeat(64), mediaType: 'image/jpeg' as const } } },
    store: { put: async () => { events.push('store'); return { checksum: 'a'.repeat(64), mediaType: 'image/jpeg' as const, byteSize: 5, reference: `/media/sha256/${'a'.repeat(64)}` } }, read: async () => { throw new Error('unused') } },
  })

  await service.run(job)
  assert.deepEqual(events, [`fetch:image:${job.desired_source_url}`, 'store'])
  assert.match(queries.at(-1)?.text ?? '', /app_finish_media_mirror_success/)
  assert.deepEqual(queries.at(-1)?.values, [job.id, 'worker', 'fence', 'a'.repeat(64), 5, 'image/jpeg'])
})

test('media mirror service records sanitized retry or terminal categories without exposing source errors', async () => {
  const calls: unknown[][] = []
  const pool = { query: async (_text: string, values?: readonly unknown[]) => { calls.push([...(values ?? [])]); return { rows: [{ ok: true }], rowCount: 1 } } } as SqlPool
  for (const [error, expectedCategory, terminal] of [
    [new MediaFetchError('network', false), 'network', false],
    [new MediaFetchError('mime', true), 'mime', true],
    [new Error('https://secret.example.test/?token=do-not-log'), 'internal', false],
  ] as const) {
    const service = new PostgresMediaMirrorService(pool, 'worker', {
      leaseSeconds: 30, batchSize: 10, backfillBatchSize: 100, backoffBaseMs: 1000, backoffMaxMs: 60_000,
    }, {
      fetcher: { fetch: async () => { throw error } },
      store: { put: async () => { throw new Error('unused') }, read: async () => { throw new Error('unused') } },
    })
    await assert.rejects(() => service.run(job), { message: 'Media mirror job failed' })
    const values = calls.at(-1)!
    assert.equal(values[3], expectedCategory)
    assert.equal(values[5], terminal)
    assert.equal(JSON.stringify(values).includes('secret.example.test'), false)
  }
})

test('media mirror service claims bounded work and advances one resumable backfill page', async () => {
  const queries: Array<{ text: string; values?: readonly unknown[] }> = []
  const pool = { query: async (text: string, values?: readonly unknown[]) => {
    queries.push({ text, ...(values ? { values } : {}) })
    if (text.includes('app_claim_media')) return { rows: [job], rowCount: 1 }
    return { rows: [{ next_cursor: 'ad-100', enqueued: 100 }], rowCount: 1 }
  } } as SqlPool
  const service = new PostgresMediaMirrorService(pool, 'worker', {
    leaseSeconds: 30, batchSize: 10, backfillBatchSize: 100, backoffBaseMs: 1000, backoffMaxMs: 60_000,
  }, { fetcher: { fetch: async () => { throw new Error('unused') } }, store: { put: async () => { throw new Error('unused') }, read: async () => { throw new Error('unused') } } })
  assert.deepEqual(await service.claim(), [job])
  assert.deepEqual(await service.backfill(), { nextCursor: 'ad-100', enqueued: 100 })
  assert.match(queries[0]!.text, /app_claim_media_mirror_jobs/)
  assert.match(queries[1]!.text, /app_enqueue_media_backfill/)
  assert.deepEqual(queries[1]!.values, [null, 100])
})
