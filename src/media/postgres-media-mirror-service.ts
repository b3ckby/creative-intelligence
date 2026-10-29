import type { MediaStore } from './content-addressed-store.ts'
import { MediaFetchError, type MediaKind, type SafeMediaFetcher } from './safe-media-fetcher.ts'
import type { SqlPool } from '../persistence/postgres-organization-repository.ts'
import { deterministicBackoffMs } from '../scheduling/scheduled-provider-sync-worker.ts'

export interface ClaimedMediaMirrorJob extends Record<string, unknown> {
  id: string
  organization_id: string
  ad_id: string
  slot_kind: 'structured_source' | 'structured_poster' | 'legacy'
  position: number
  media_kind: MediaKind
  desired_source_url: string
  attempt: number
  max_attempts: number
  lease_owner: string
  fence_token: string
}

interface Settings {
  leaseSeconds: number
  batchSize: number
  backfillBatchSize: number
  backoffBaseMs: number
  backoffMaxMs: number
}

interface Dependencies {
  fetcher: Pick<SafeMediaFetcher, 'fetch'>
  store: MediaStore
}

export class PostgresMediaMirrorService {
  constructor(
    private readonly pool: SqlPool,
    private readonly workerId: string,
    private readonly settings: Settings,
    private readonly dependencies: Dependencies,
  ) {}

  async claim(): Promise<ClaimedMediaMirrorJob[]> {
    const result = await this.pool.query<ClaimedMediaMirrorJob>(
      'SELECT * FROM app_claim_media_mirror_jobs($1,$2,$3)',
      [this.workerId, this.settings.leaseSeconds, this.settings.batchSize],
    )
    return result.rows
  }

  async backfill(): Promise<{ nextCursor: string | null; enqueued: number }> {
    const result = await this.pool.query<{ next_cursor: string | null; enqueued: number }>(
      'SELECT * FROM app_enqueue_media_backfill($1,$2)',
      [null, this.settings.backfillBatchSize],
    )
    const row = result.rows[0]
    if (!row || (row.next_cursor !== null && typeof row.next_cursor !== 'string') || !Number.isSafeInteger(row.enqueued) || row.enqueued < 0) {
      throw new Error('Media backfill failed')
    }
    return { nextCursor: row.next_cursor, enqueued: row.enqueued }
  }

  async run(job: ClaimedMediaMirrorJob): Promise<void> {
    try {
      const fetched = await this.dependencies.fetcher.fetch(job.desired_source_url, job.media_kind)
      let stored
      try { stored = await this.dependencies.store.put(fetched.bytes, fetched.mediaType) } catch { throw new StorageError() }
      if (stored.checksum !== fetched.checksum || stored.byteSize !== fetched.bytes.length || stored.mediaType !== fetched.mediaType) throw new StorageError()
      const result = await this.pool.query<{ ok: boolean }>(
        'SELECT app_finish_media_mirror_success($1,$2,$3,$4,$5,$6) AS ok',
        [job.id, this.workerId, job.fence_token, stored.checksum, stored.byteSize, stored.mediaType],
      )
      if (result.rows[0]?.ok !== true) throw new Error('lost lease')
    } catch (error) {
      const failure = categorize(error)
      const delay = deterministicBackoffMs(job.attempt, this.settings.backoffBaseMs, this.settings.backoffMaxMs)
      await this.pool.query(
        'SELECT app_finish_media_mirror_failure($1,$2,$3,$4,$5,$6) AS ok',
        [job.id, this.workerId, job.fence_token, failure.category, Math.ceil(delay / 1_000), failure.terminal],
      ).catch(() => undefined)
      throw new Error('Media mirror job failed')
    }
  }
}

class StorageError extends Error {}

function categorize(error: unknown): { category: 'network' | 'redirect' | 'address' | 'http' | 'size' | 'mime' | 'storage' | 'internal'; terminal: boolean } {
  if (error instanceof MediaFetchError) return { category: error.category, terminal: error.terminal }
  if (error instanceof StorageError) return { category: 'storage', terminal: false }
  return { category: 'internal', terminal: false }
}
