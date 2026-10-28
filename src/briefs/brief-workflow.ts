import { ValidationError } from '../domain/errors.ts'
import { BRIEF_STATUS_TRANSITIONS } from '../domain/brief-status-transitions.ts'
import type { BriefDimensions, BriefStatus } from '../domain/types.ts'
import { normalizeCanonicalText } from '../domain/validation.ts'
import { normalizeBriefDimensions } from './brief-dimensions.ts'

export interface BriefUpdateInput {
  expectedVersion: number
  title: string
  status: BriefStatus
  hook: string
  callToAction: string | null
  dimensions: BriefDimensions
}

export function normalizeBriefUpdate(value: unknown): BriefUpdateInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError('Brief update is invalid')
  const record = value as Record<string, unknown>
  const keys = ['expectedVersion', 'title', 'status', 'hook', 'callToAction', 'dimensions']
  if (Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !keys.includes(key))) throw new ValidationError('Brief update is invalid')
  if (!Number.isSafeInteger(record.expectedVersion) || (record.expectedVersion as number) < 1) throw new ValidationError('Brief version is invalid')
  if (typeof record.status !== 'string' || !Object.hasOwn(BRIEF_STATUS_TRANSITIONS, record.status)) throw new ValidationError('Brief status is invalid')
  const title = normalizeCanonicalText(record.title, 'Brief title', { maxLength: 500 })
  if (title.length === 0) throw new ValidationError('Brief title is required')
  const callToAction = record.callToAction === null
    ? null
    : normalizeCanonicalText(record.callToAction, 'Brief call to action', { maxLength: 100 })
  return {
    expectedVersion: record.expectedVersion as number,
    title,
    status: record.status as BriefStatus,
    hook: normalizeCanonicalText(record.hook, 'Brief hook', { maxLength: 20_000, allowEmpty: true }),
    callToAction,
    dimensions: normalizeBriefDimensions(record.dimensions as BriefDimensions),
  }
}

export function requireBriefStatusTransition(from: BriefStatus, to: BriefStatus): void {
  if (!BRIEF_STATUS_TRANSITIONS[from].includes(to)) throw new ValidationError(`Brief status transition from ${from} to ${to} is invalid`)
}
