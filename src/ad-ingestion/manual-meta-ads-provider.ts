import type { AdCollectionContext, AdSourceProvider, CollectedAd } from './ad-source-provider.ts'
import { AD_BODY_MAX_LENGTH } from '../domain/types.ts'
import { ValidationError } from '../domain/errors.ts'
import { normalizeIdentifier } from '../domain/identifiers.ts'
import {
  normalizeCanonicalText,
  validateCanonicalHttpsUrl,
  validateCanonicalHttpsUrlArray,
} from '../domain/validation.ts'

export interface ManualMetaAdRecord {
  externalId: string
  advertiserName: string
  body: string
  callToAction?: string
  startedAt: string
  isActive: boolean
  mediaUrls: string[]
  sourceUrl: string
}

export class ManualMetaAdsProvider implements AdSourceProvider {
  constructor(private readonly records: ManualMetaAdRecord[]) {}

  async collect(_context: AdCollectionContext): Promise<CollectedAd[]> {
    return this.records.map((record) => {
      const externalId = normalizeIdentifier(record.externalId, 'External ad ID')
      const advertiserName = normalizeCanonicalText(record.advertiserName, 'Advertiser name', { maxLength: 500 })
      const body = normalizeCanonicalText(record.body, 'Ad body', { maxLength: AD_BODY_MAX_LENGTH, allowEmpty: true })
      const sourceUrl = validateCanonicalHttpsUrl(record.sourceUrl, 'Ad source URL')
      const mediaUrls = validateCanonicalHttpsUrlArray(record.mediaUrls, 'Media URL')
      if (!body && mediaUrls.length === 0) throw new ValidationError('Ad body or media is required')

      const startedAt = new Date(record.startedAt)
      if (Number.isNaN(startedAt.valueOf())) throw new ValidationError('Ad start date is invalid')

      return {
        platform: 'meta',
        externalId,
        advertiserName,
        body,
        callToAction: record.callToAction === undefined
          ? null
          : normalizeCanonicalText(record.callToAction, 'Ad call to action', { maxLength: 100 }),
        startedAt: startedAt.toISOString(),
        isActive: record.isActive,
        mediaUrls,
        sourceUrl,
      }
    })
  }
}
