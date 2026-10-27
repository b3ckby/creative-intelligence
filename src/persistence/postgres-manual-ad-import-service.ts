import type { AdCollectionContext } from '../ad-ingestion/ad-source-provider.ts'
import { ManualMetaAdsProvider, type ManualMetaAdRecord } from '../ad-ingestion/manual-meta-ads-provider.ts'
import { ValidationError } from '../domain/errors.ts'
import type { SqlPool } from './postgres-organization-repository.ts'
import { PostgresProviderAdImportService } from './postgres-provider-ad-import-service.ts'

export class PostgresManualAdImportService {
  private readonly providerImports: PostgresProviderAdImportService

  constructor(pool: SqlPool, createId: () => string, now: () => Date) {
    this.providerImports = new PostgresProviderAdImportService(pool, createId, now)
  }

  async import(
    verifiedUserId: string,
    context: AdCollectionContext,
    records: ManualMetaAdRecord[],
  ): Promise<{ inserted: number; duplicates: number }> {
    if (records.length === 0) throw new ValidationError('Manual ad batch must not be empty')
    if (records.length > 1_000) throw new ValidationError('Manual ad batch is too large')
    return await this.providerImports.import(verifiedUserId, 'manual-meta', context, new ManualMetaAdsProvider(records))
  }
}
