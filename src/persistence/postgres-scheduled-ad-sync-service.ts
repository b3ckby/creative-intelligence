import { AuthorizationError, ExternalProviderError, NotFoundError, ValidationError } from '../domain/errors.ts'
import type { AdSourceProvider } from '../ad-ingestion/ad-source-provider.ts'
import { deterministicBackoffMs } from '../scheduling/scheduled-provider-sync-worker.ts'
import type { SqlPool } from './postgres-organization-repository.ts'
import { PostgresProviderAdImportService } from './postgres-provider-ad-import-service.ts'

export interface ClaimedAdSyncRun extends Record<string, unknown> {
  id: string
  organization_id: string
  product_id: string
  competitor_id: string
  provider_name: string
  actor_user_id: string
  attempt: number
  max_attempts: number
  fence_token: string
}

export type SyncErrorCategory = 'provider' | 'network' | 'validation' | 'authorization' | 'internal'

export class PostgresScheduledAdSyncService {
  constructor(
    private readonly pool: SqlPool,
    private readonly imports: PostgresProviderAdImportService,
    private readonly workerId: string,
    private readonly settings: { leaseSeconds: number; maxAttempts: number; backoffBaseMs: number; backoffMaxMs: number },
    private readonly providerFor: (run: ClaimedAdSyncRun) => Promise<AdSourceProvider>,
  ) {}

  async claim(batchSize: number): Promise<ClaimedAdSyncRun[]> {
    const result = await this.pool.query<ClaimedAdSyncRun>(
      'SELECT * FROM app_claim_due_ad_sync_runs($1,$2,$3,$4)',
      [this.workerId, this.settings.leaseSeconds, this.settings.maxAttempts, batchSize],
    )
    return result.rows
  }

  async run(run: ClaimedAdSyncRun): Promise<void> {
    try {
      const provider = await this.providerFor(run)
      await this.imports.importWithDetails(run.actor_user_id, run.provider_name, {
        organizationId: run.organization_id,
        productId: run.product_id,
        competitorId: run.competitor_id,
      }, provider, { runId: run.id, owner: this.workerId, token: run.fence_token })
    } catch (error) {
      const delay = deterministicBackoffMs(run.attempt, this.settings.backoffBaseMs, this.settings.backoffMaxMs)
      await this.pool.query(
        'SELECT app_finish_ad_sync_run_failure($1,$2,$3,$4,$5)',
        [run.id, this.workerId, run.fence_token, categorize(error), Math.ceil(delay / 1_000)],
      )
      throw new Error('Scheduled sync run failed')
    }
  }
}

function categorize(error: unknown): SyncErrorCategory {
  if (error instanceof ExternalProviderError) return 'provider'
  if (error instanceof ValidationError) return 'validation'
  if (error instanceof AuthorizationError || error instanceof NotFoundError) return 'authorization'
  if (error instanceof TypeError) return 'network'
  return 'internal'
}
