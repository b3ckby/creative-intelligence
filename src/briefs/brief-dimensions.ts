import { ValidationError } from '../domain/errors.ts'
import type { BriefDimensions } from '../domain/types.ts'
import { normalizeCanonicalText } from '../domain/validation.ts'

const DIMENSION_FIELDS = ['audience', 'market', 'angle', 'format'] as const

export function normalizeBriefDimensions(dimensions: BriefDimensions): BriefDimensions {
  if (typeof dimensions !== 'object' || dimensions === null || Array.isArray(dimensions)) {
    throw new ValidationError('Brief dimensions are invalid')
  }
  const keys = Object.keys(dimensions)
  if (keys.length !== DIMENSION_FIELDS.length || keys.some((key) => !DIMENSION_FIELDS.includes(key as typeof DIMENSION_FIELDS[number]))) {
    throw new ValidationError('Brief dimensions are invalid')
  }
  return {
    audience: normalizeDimensionValue(dimensions.audience, 'audience'),
    market: normalizeDimensionValue(dimensions.market, 'market'),
    angle: normalizeDimensionValue(dimensions.angle, 'angle'),
    format: normalizeDimensionValue(dimensions.format, 'format'),
  }
}

export function normalizeDimensionValue(value: unknown, field: string): string {
  if (typeof value === 'string' && value.trim().length === 0) throw new ValidationError(`Brief dimension ${field} is required`)
  if (typeof value === 'string' && value.trim().length > 100) throw new ValidationError(`Brief dimension ${field} is too long`)
  return normalizeCanonicalText(value, `Brief dimension ${field}`, { maxLength: 100 })
}
