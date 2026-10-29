import { CREATIVE_ANGLES, CREATIVE_FORMATS, FUNNEL_STAGES, HOOK_CATEGORIES, OFFER_FRAMES, type CreativeAnalysisRecord, type CreativeTags } from './creative-analysis-service.ts'
import { ValidationError } from '../domain/errors.ts'

export const CREATIVE_TAG_REVIEW_STATUSES = ['pending', 'approved', 'rejected', 'corrected'] as const
export type CreativeTagReviewStatus = typeof CREATIVE_TAG_REVIEW_STATUSES[number]
export type CreativeTagReviewDecision = Exclude<CreativeTagReviewStatus, 'pending'>
export type CreativeTagCorrections = Partial<Pick<CreativeTags, 'hookCategory' | 'angle' | 'format' | 'offerFrame' | 'funnelStage'>>

export interface CreativeTagReview {
  organizationId: string
  productId: string
  competitorAdId: string
  analysisVersion: string
  inputFingerprint: string
  reviewVersion: number
  decision: CreativeTagReviewDecision
  corrections: CreativeTagCorrections | null
  reason: string
  reviewerUserId: string
  reviewedAt: string
}

export interface CreativeTagReviewItem {
  advertiserName: string
  analysis: CreativeAnalysisRecord
  status: CreativeTagReviewStatus
  review: CreativeTagReview | null
  originalTags: CreativeTags
  effectiveTags: CreativeTags | null
  stale: boolean
}

export interface CreativeTagReviewSubmission {
  expectedReviewVersion: number
  decision: CreativeTagReviewDecision
  corrections: CreativeTagCorrections | null
  reason: string
}

export function validateCreativeTagReviewSubmission(value: unknown): CreativeTagReviewSubmission {
  if (!isRecord(value)) throw new ValidationError('Creative tag review is invalid')
  const allowed = ['expectedReviewVersion', 'decision', 'corrections', 'reason']
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new ValidationError('Creative tag review contains unknown fields')
  if (!Number.isSafeInteger(value.expectedReviewVersion) || (value.expectedReviewVersion as number) < 0) throw new ValidationError('Expected review version is invalid')
  if (value.decision !== 'approved' && value.decision !== 'rejected' && value.decision !== 'corrected') throw new ValidationError('Creative tag review decision is invalid')
  if (typeof value.reason !== 'string' || value.reason.length < 1 || [...value.reason].length > 1_000 || value.reason !== value.reason.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(value.reason)) throw new ValidationError('Creative tag review reason is invalid')
  const corrections = validateCorrections(value.corrections)
  if (value.decision === 'corrected' ? corrections === null : corrections !== null) throw new ValidationError('Creative tag review corrections are invalid')
  return { expectedReviewVersion: value.expectedReviewVersion as number, decision: value.decision, corrections, reason: value.reason }
}

export function effectiveCreativeTags(original: CreativeTags, review: CreativeTagReview | null): CreativeTags | null {
  if (!review || review.decision === 'approved') return { ...original }
  if (review.decision === 'rejected') return null
  return { ...original, ...review.corrections }
}

function validateCorrections(value: unknown): CreativeTagCorrections | null {
  if (value === null || value === undefined) return null
  if (!isRecord(value)) throw new ValidationError('Creative tag review corrections are invalid')
  const keys = Object.keys(value)
  const allowed = ['hookCategory', 'angle', 'format', 'offerFrame', 'funnelStage']
  if (keys.length < 1 || keys.length > 5 || keys.some((key) => !allowed.includes(key))) throw new ValidationError('Creative tag review corrections are invalid')
  const result: CreativeTagCorrections = {}
  if (value.hookCategory !== undefined) result.hookCategory = enumValue(value.hookCategory, HOOK_CATEGORIES)
  if (value.angle !== undefined) result.angle = enumValue(value.angle, CREATIVE_ANGLES)
  if (value.format !== undefined) result.format = enumValue(value.format, CREATIVE_FORMATS)
  if (value.offerFrame !== undefined) result.offerFrame = enumValue(value.offerFrame, OFFER_FRAMES)
  if (value.funnelStage !== undefined) result.funnelStage = enumValue(value.funnelStage, FUNNEL_STAGES)
  return result
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new ValidationError('Creative tag review corrections are invalid')
  return value as T[number]
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
