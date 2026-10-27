import { normalizeCanonicalText, validateCanonicalText } from './validation.ts'

export function normalizeIdentifier(value: unknown, field: string, maxLength = 256): string {
  return normalizeCanonicalText(value, field, { maxLength })
}

export function validateIdentifier(value: unknown, field: string, maxLength = 256): string {
  return validateCanonicalText(value, field, { maxLength })
}
