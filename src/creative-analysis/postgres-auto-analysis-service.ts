import {
  CREATIVE_PROMPT_VERSION,
  GeminiRateLimitError,
  creativeAnalysisVersion,
  creativeInputFingerprint,
  prepareCreativeMedia,
  validateCreativeTags,
  type CreativeMediaDescriptor,
  type CreativeTagger,
} from './creative-analysis-service.ts'
import type { MediaStore } from '../media/content-addressed-store.ts'
import type { SqlPool } from '../persistence/postgres-organization-repository.ts'
import { deterministicBackoffMs } from '../scheduling/scheduled-provider-sync-worker.ts'

interface ClaimedMediaMetadata {
  slotKind: 'structured_source' | 'structured_poster' | 'legacy'
  position: number
  checksum: string
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  byteSize: number
}

export interface ClaimedCreativeAnalysisJob extends Record<string, unknown> {
  job_id: string
  organization_id: string
  product_id: string
  competitor_ad_id: string
  advertiser_name: string
  body: string
  call_to_action: string | null
  attempt: number
  max_attempts: number
  fence_token: string
  media: ClaimedMediaMetadata[]
}

interface AutoAnalysisSettings {
  leaseSeconds: number
  batchSize: number
  dailyLimit: number
  maxMediaCount: number
  maxMediaBytes: number
  backoffBaseMs: number
  backoffMaxMs: number
}

export class PostgresAutoAnalysisService {
  private readonly analysisVersion: string

  constructor(
    private readonly pool: SqlPool,
    private readonly store: MediaStore,
    private readonly tagger: CreativeTagger,
    private readonly workerId: string,
    private readonly settings: AutoAnalysisSettings,
  ) {
    if (!workerId || workerId.length > 256) throw new Error('Invalid analysis worker ID')
    this.analysisVersion = creativeAnalysisVersion(tagger.provider, tagger.model)
  }

  async claim(): Promise<ClaimedCreativeAnalysisJob[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM app_claim_creative_analysis_jobs($1,$2,$3)',
      [this.workerId, this.settings.leaseSeconds, this.settings.batchSize],
    )
    return result.rows.map(decodeClaim)
  }

  async run(job: ClaimedCreativeAnalysisJob): Promise<void> {
    let fingerprint = creativeInputFingerprint({ advertiserName: job.advertiser_name, body: job.body, callToAction: job.call_to_action })
    let claim: string | undefined
    try {
      const media = await this.loadMedia(job.media)
      fingerprint = creativeInputFingerprint({ advertiserName: job.advertiser_name, body: job.body, callToAction: job.call_to_action }, media)
      const mode = media.length > 0 ? 'media' : 'copy_only'
      const begin = await this.pool.query<{ outcome: string; analysis_claim: string | null }>(
        'SELECT * FROM app_begin_auto_analysis($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [job.job_id, this.workerId, job.fence_token, this.analysisVersion, fingerprint, this.tagger.provider, this.tagger.model,
          CREATIVE_PROMPT_VERSION, mode, media.length, this.settings.dailyLimit],
      )
      const state = begin.rows[0]
      if (state?.outcome === 'cached') return
      if (state?.outcome !== 'run' || typeof state.analysis_claim !== 'string' || !/^[a-f0-9]{64}$/u.test(state.analysis_claim)) {
        throw new QueueStateError()
      }
      claim = state.analysis_claim
      const tags = validateCreativeTags(await this.tagger.analyze({
        advertiserName: job.advertiser_name,
        body: job.body,
        callToAction: job.call_to_action,
        mode,
        media,
      }))
      const finished = await this.pool.query<{ ok: boolean }>(
        'SELECT app_finish_auto_analysis_success($1,$2,$3,$4,$5,$6,$7::jsonb) AS ok',
        [job.job_id, this.workerId, job.fence_token, this.analysisVersion, fingerprint, claim, JSON.stringify(tags)],
      )
      if (finished.rows[0]?.ok !== true) throw new QueueStateError()
    } catch (error) {
      if (claim) {
        const failure = failureCategory(error)
        const delay = Math.ceil(deterministicBackoffMs(job.attempt, this.settings.backoffBaseMs, this.settings.backoffMaxMs) / 1_000)
        await this.pool.query(
          'SELECT app_finish_auto_analysis_failure($1,$2,$3,$4,$5,$6,$7,$8,$9) AS ok',
          [job.job_id, this.workerId, job.fence_token, this.analysisVersion, fingerprint, claim, failure.category, delay, failure.terminal],
        ).catch(() => undefined)
      }
      throw new Error('Automatic creative analysis job failed')
    }
  }

  private async loadMedia(metadata: readonly ClaimedMediaMetadata[]): Promise<CreativeMediaDescriptor[]> {
    if (metadata.length > this.settings.maxMediaCount) throw new InvalidMediaError()
    const loaded: CreativeMediaDescriptor[] = []
    for (const item of metadata) {
      let object
      try { object = await this.store.read(item.checksum) } catch { throw new StorageReadError() }
      if (object.byteSize !== item.byteSize || object.mediaType !== item.mediaType) throw new InvalidMediaError()
      loaded.push({ ...item, bytes: object.bytes })
    }
    try {
      return prepareCreativeMedia(loaded, { maxCount: this.settings.maxMediaCount, maxAggregateBytes: this.settings.maxMediaBytes })
    } catch { throw new InvalidMediaError() }
  }
}

class InvalidMediaError extends Error {}
class StorageReadError extends Error {}
class QueueStateError extends Error {}

function failureCategory(error: unknown): { category: 'provider' | 'rate_limit' | 'invalid_media' | 'storage' | 'internal'; terminal: boolean } {
  if (error instanceof GeminiRateLimitError) return { category: 'rate_limit', terminal: false }
  if (error instanceof InvalidMediaError) return { category: 'invalid_media', terminal: true }
  if (error instanceof StorageReadError) return { category: 'storage', terminal: false }
  if (error instanceof QueueStateError) return { category: 'internal', terminal: false }
  return { category: 'provider', terminal: false }
}

function decodeClaim(row: Record<string, unknown>): ClaimedCreativeAnalysisJob {
  const text = (value: unknown, maximum = 256): string => {
    if (typeof value !== 'string' || value.length < 1 || value.length > maximum || value !== value.trim()) throw new Error('Invalid claimed analysis job')
    return value
  }
  if (!Number.isSafeInteger(row.attempt) || (row.attempt as number) < 1 || !Number.isSafeInteger(row.max_attempts)
    || !Array.isArray(row.media) || !/^[a-f0-9]{64}$/u.test(String(row.fence_token))) throw new Error('Invalid claimed analysis job')
  const media = row.media.map((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid claimed analysis job')
    const item = value as Record<string, unknown>
    if (!['structured_source', 'structured_poster', 'legacy'].includes(String(item.slotKind))
      || !Number.isSafeInteger(item.position) || !/^[a-f0-9]{64}$/u.test(String(item.checksum))
      || !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(String(item.mediaType))
      || !Number.isSafeInteger(item.byteSize) || (item.byteSize as number) < 1) throw new Error('Invalid claimed analysis job')
    return item as unknown as ClaimedMediaMetadata
  })
  return {
    job_id: text(row.job_id), organization_id: text(row.organization_id), product_id: text(row.product_id), competitor_ad_id: text(row.competitor_ad_id),
    advertiser_name: text(row.advertiser_name, 500), body: typeof row.body === 'string' ? row.body : (() => { throw new Error('Invalid claimed analysis job') })(),
    call_to_action: row.call_to_action === null ? null : text(row.call_to_action, 500), attempt: row.attempt as number,
    max_attempts: row.max_attempts as number, fence_token: row.fence_token as string, media,
  }
}
