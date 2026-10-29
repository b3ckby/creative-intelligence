import { createHash } from 'node:crypto'

import type { CompetitorAd } from '../domain/types.ts'
import { AiProviderError, ApplicationError, ConflictError } from '../domain/errors.ts'

export const HOOK_CATEGORIES = ['pain_point', 'results', 'pattern_interrupt', 'pov_hook', 'listicle_hook', 'curiosity', 'data', 'social_proof'] as const
export const CREATIVE_ANGLES = ['emotional', 'rational', 'identity', 'urgency', 'authority'] as const
export const CREATIVE_FORMATS = ['ugc', 'asmr', 'podcast', 'pov', 'review', 'teaser', 'stream', 'tutorial', 'documentary', 'news_story', 'meme', 'action', 'drama', 'cartoon'] as const
export const OFFER_FRAMES = ['discount', 'demo', 'free_tool', 'bundle', 'guarantee', 'social_proof', 'none'] as const
export const FUNNEL_STAGES = ['awareness', 'consideration', 'conversion', 'retention'] as const
export const CREATIVE_ANALYSIS_VERSION = 'gemini-grounded-v2'
export const CREATIVE_PROMPT_VERSION = 'creative-tags-grounded-v2'

export type CreativeAnalysisMode = 'media' | 'copy_only'
export type CreativeAnalysisProvenance = 'manual' | 'automatic'
export type CreativeImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

export interface CreativeMediaDescriptor {
  slotKind: 'structured_source' | 'structured_poster' | 'legacy'
  position: number
  checksum: string
  mediaType: CreativeImageMime
  byteSize: number
  bytes: Buffer
}

export interface CreativeTags {
  hookCategory: typeof HOOK_CATEGORIES[number]
  angle: typeof CREATIVE_ANGLES[number]
  emotion: string
  persona: string
  format: typeof CREATIVE_FORMATS[number]
  offerFrame: typeof OFFER_FRAMES[number]
  cta: string
  onScreenText?: string
  visualSummary: string
  funnelStage: typeof FUNNEL_STAGES[number]
  confidence: number
}

export interface CreativeTaggerInput {
  advertiserName: string
  body: string
  callToAction: string | null
  mode?: CreativeAnalysisMode
  media?: readonly CreativeMediaDescriptor[]
}

export interface CreativeTagger {
  readonly provider: string
  readonly model: string
  analyze(input: Readonly<CreativeTaggerInput>): Promise<unknown>
}

export class GeminiRateLimitError extends Error {
  constructor() { super('Gemini rate limited the request'); this.name = 'GeminiRateLimitError' }
}

export interface CreativeAnalysisRecord {
  organizationId: string
  productId: string
  competitorAdId: string
  analysisVersion: string
  modelProvider: string
  modelName: string
  promptVersion: string
  inputFingerprint: string
  tags: CreativeTags
  analyzedAt: string
  provenance: CreativeAnalysisProvenance
  analysisMode: CreativeAnalysisMode
  mediaCount: number
}

export interface CreativeAnalysisClaim { claimToken: string }

export interface CreativeAnalysisRepository {
  findCompleted(actorUserId: string, ad: CompetitorAd, analysisVersion: string, inputFingerprint: string): Promise<CreativeAnalysisRecord | undefined>
  acquireClaim(actorUserId: string, ad: CompetitorAd, analysisVersion: string, inputFingerprint: string): Promise<CreativeAnalysisClaim | undefined>
  consumeUsage(actorUserId: string, ad: CompetitorAd, analysisVersion: string, inputFingerprint: string, claimToken: string): Promise<void>
  complete(actorUserId: string, record: CreativeAnalysisRecord, claimToken: string): Promise<void>
  fail(actorUserId: string, ad: CompetitorAd, analysisVersion: string, inputFingerprint: string, claimToken: string): Promise<void>
}

export class CreativeAnalysisService {
  private readonly analysisVersion: string

  constructor(
    private readonly repository: CreativeAnalysisRepository,
    private readonly tagger: CreativeTagger,
    private readonly now: () => Date,
  ) {
    this.analysisVersion = creativeAnalysisVersion(tagger.provider, tagger.model)
  }

  async analyze(actorUserId: string, ad: CompetitorAd, media: readonly CreativeMediaDescriptor[] = [], provenance: CreativeAnalysisProvenance = 'manual'): Promise<CreativeAnalysisRecord> {
    const prepared = prepareCreativeMedia(media, { maxCount: 4, maxAggregateBytes: 8 * 1024 * 1024 })
    const fingerprint = creativeInputFingerprint(ad, prepared)
    const current = await this.repository.findCompleted(actorUserId, ad, this.analysisVersion, fingerprint)
    if (current) return current
    const claim = await this.repository.acquireClaim(actorUserId, ad, this.analysisVersion, fingerprint)
    if (!claim) {
      const concurrent = await this.repository.findCompleted(actorUserId, ad, this.analysisVersion, fingerprint)
      if (concurrent) return concurrent
      throw new ConflictError('Creative analysis is already running')
    }
    try {
      const mode: CreativeAnalysisMode = prepared.length > 0 ? 'media' : 'copy_only'
      const input = Object.freeze({ advertiserName: ad.advertiserName, body: ad.body, callToAction: ad.callToAction, mode, media: prepared })
      let rawTags: unknown
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await this.repository.consumeUsage(actorUserId, ad, this.analysisVersion, fingerprint, claim.claimToken)
        try {
          rawTags = await this.tagger.analyze(input)
          break
        } catch (error) {
          if (error instanceof GeminiRateLimitError && attempt === 0) continue
          throw new CreativeTaggerFailure()
        }
      }
      let tags: CreativeTags
      try { tags = validateCreativeTags(rawTags) } catch { throw new CreativeTaggerFailure() }
      const record: CreativeAnalysisRecord = {
        organizationId: ad.organizationId,
        productId: ad.productId,
        competitorAdId: ad.id,
        analysisVersion: this.analysisVersion,
        modelProvider: boundedCanonical(this.tagger.provider, 40, 'model provider'),
        modelName: boundedCanonical(this.tagger.model, 100, 'model name'),
        promptVersion: CREATIVE_PROMPT_VERSION,
        inputFingerprint: fingerprint,
        tags,
        analyzedAt: this.now().toISOString(),
        provenance,
        analysisMode: mode,
        mediaCount: prepared.length,
      }
      await this.repository.complete(actorUserId, record, claim.claimToken)
      return record
    } catch (error) {
      await this.repository.fail(actorUserId, ad, this.analysisVersion, fingerprint, claim.claimToken).catch(() => undefined)
      if (error instanceof ApplicationError) throw error
      if (error instanceof CreativeTaggerFailure) throw new AiProviderError()
      throw error
    }
  }
}

class CreativeTaggerFailure extends Error {}

export function creativeAnalysisVersion(provider: string, model: string): string {
  const identity = JSON.stringify([
    boundedCanonical(provider, 40, 'model provider'),
    boundedCanonical(model, 100, 'model name'),
    CREATIVE_PROMPT_VERSION,
  ])
  return `${CREATIVE_ANALYSIS_VERSION}-${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`
}

export function creativeInputFingerprint(
  ad: Pick<CompetitorAd, 'advertiserName' | 'body' | 'callToAction'>,
  media: readonly Pick<CreativeMediaDescriptor, 'slotKind' | 'position' | 'checksum'>[] = [],
): string {
  const ordered = [...media].sort(compareMedia).map(({ slotKind, position, checksum }) => [slotKind, position, checksum])
  const canonical = JSON.stringify([ad.advertiserName, ad.body, ad.callToAction, ordered])
  return createHash('sha256').update(canonical).digest('hex')
}

export function prepareCreativeMedia(
  media: readonly CreativeMediaDescriptor[],
  limits: Readonly<{ maxCount: number; maxAggregateBytes: number }>,
): CreativeMediaDescriptor[] {
  if (!Number.isSafeInteger(limits.maxCount) || limits.maxCount < 0 || limits.maxCount > 16
    || !Number.isSafeInteger(limits.maxAggregateBytes) || limits.maxAggregateBytes < 0 || limits.maxAggregateBytes > 32 * 1024 * 1024
    || media.length > limits.maxCount) throw new Error('Creative media exceeds bounds')
  let aggregate = 0
  const result = media.map((item) => {
    if (!['structured_source', 'structured_poster', 'legacy'].includes(item.slotKind)
      || !Number.isSafeInteger(item.position) || item.position < 0 || item.position > 49
      || !/^[a-f0-9]{64}$/u.test(item.checksum)
      || !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(item.mediaType)
      || !Buffer.isBuffer(item.bytes) || !Number.isSafeInteger(item.byteSize) || item.byteSize < 1 || item.byteSize !== item.bytes.length) {
      throw new Error(item.mediaType?.startsWith('video/') ? 'Creative media MIME is not supported' : 'Creative media is invalid')
    }
    aggregate += item.byteSize
    if (aggregate > limits.maxAggregateBytes) throw new Error('Creative media exceeds bounds')
    return { ...item, bytes: Buffer.from(item.bytes) }
  })
  return result.sort(compareMedia)
}

function compareMedia(a: Pick<CreativeMediaDescriptor, 'slotKind' | 'position' | 'checksum'>, b: Pick<CreativeMediaDescriptor, 'slotKind' | 'position' | 'checksum'>): number {
  const order = { structured_source: 0, structured_poster: 1, legacy: 2 }
  return order[a.slotKind] - order[b.slotKind] || a.position - b.position || a.checksum.localeCompare(b.checksum)
}

export function validateCreativeTags(value: unknown): CreativeTags {
  if (!isRecord(value)) throw new Error('Creative tags are invalid')
  const allowed = ['hookCategory', 'angle', 'emotion', 'persona', 'format', 'offerFrame', 'cta', 'onScreenText', 'visualSummary', 'funnelStage', 'confidence']
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('Creative tags are invalid')
  const confidence = value.confidence
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('Creative tags are invalid')
  const tags: CreativeTags = {
    hookCategory: enumValue(value.hookCategory, HOOK_CATEGORIES),
    angle: enumValue(value.angle, CREATIVE_ANGLES),
    emotion: boundedCanonical(value.emotion, 40, 'emotion').toLowerCase(),
    persona: boundedCanonical(value.persona, 120, 'persona'),
    format: enumValue(value.format, CREATIVE_FORMATS),
    offerFrame: enumValue(value.offerFrame, OFFER_FRAMES),
    cta: boundedCanonical(value.cta, 120, 'cta'),
    visualSummary: boundedCanonical(value.visualSummary, 600, 'visual summary'),
    funnelStage: enumValue(value.funnelStage, FUNNEL_STAGES),
    confidence,
  }
  if (value.onScreenText !== undefined) tags.onScreenText = boundedCanonical(value.onScreenText, 600, 'on-screen text')
  return tags
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new Error('Creative tags are invalid')
  return value as T[number]
}

function boundedCanonical(value: unknown, maximum: number, _field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || [...value].length > maximum || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error('Creative tags are invalid')
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
