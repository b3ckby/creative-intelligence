import { ValidationError } from './errors.ts'

export const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/

export interface TextRules {
  maxLength: number
  allowEmpty?: boolean
}

export function normalizeCanonicalText(value: unknown, field: string, rules: TextRules): string {
  if (typeof value !== 'string') throw new ValidationError(`${field} is invalid`)
  const normalized = value.trim()
  return validateCanonicalText(normalized, field, rules)
}

export function validateCanonicalText(value: unknown, field: string, rules: TextRules): string {
  if (typeof value !== 'string' || value !== value.trim()) throw new ValidationError(`${field} is invalid`)
  if ((!rules.allowEmpty && value.length === 0) || value.length > rules.maxLength || CONTROL_CHARACTERS.test(value)) {
    throw new ValidationError(`${field} is invalid`)
  }
  return value
}

export function normalizeCanonicalTextArray(
  value: unknown,
  field: string,
  rules: TextRules & { maxItems: number },
): string[] {
  if (!Array.isArray(value) || value.length > rules.maxItems) throw new ValidationError(`${field} is invalid`)
  return [...new Set(value.map((item) => normalizeCanonicalText(item, field, rules)))]
}

export function validateCanonicalTextArray(
  value: unknown,
  field: string,
  rules: TextRules & { maxItems: number },
): string[] {
  if (!Array.isArray(value) || value.length > rules.maxItems) throw new ValidationError(`${field} is invalid`)
  const result = value.map((item) => validateCanonicalText(item, field, rules))
  if (new Set(result).size !== result.length) throw new ValidationError(`${field} is invalid`)
  return result
}

export function validateCanonicalHttpsUrl(value: unknown, field: string, maxLength = 2_048): string {
  const text = validateCanonicalText(value, field, { maxLength })
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    throw new ValidationError(`${field} is invalid`)
  }
  if (parsed.protocol !== 'https:') throw new ValidationError(`${field} must use HTTPS`)
  if (!parsed.hostname || parsed.username || parsed.password || parsed.hash) {
    throw new ValidationError(`${field} is invalid`)
  }
  return text
}

export function validateCanonicalHttpsUrlArray(
  value: unknown,
  field: string,
  maxItems = 50,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new ValidationError(`${field} is invalid`)
  const result = value.map((item) => validateCanonicalHttpsUrl(item, field))
  if (new Set(result).size !== result.length) throw new ValidationError(`${field} is invalid`)
  return result
}
