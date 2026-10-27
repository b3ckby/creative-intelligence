import { ValidationError } from './errors.ts'

export const MAX_PAGE_LIMIT = 100
export const DEFAULT_PAGE_LIMIT = 50

export function validatePageLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_PAGE_LIMIT) {
    throw new ValidationError(`Page limit must be an integer from 1 to ${MAX_PAGE_LIMIT}`)
  }
  return value as number
}
