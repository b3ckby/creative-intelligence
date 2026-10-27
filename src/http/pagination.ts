import { createHmac, timingSafeEqual } from 'node:crypto'

import { DataIntegrityError, ValidationError } from '../domain/errors.ts'

const CURSOR_VERSION = 1
const MAX_CURSOR_LENGTH = 2_048
const EXACT_CURSOR_TIMESTAMP = Symbol('exactCursorTimestamp')

export type CursorSigningKey = string | Buffer

export interface CursorPosition {
  createdAt: string
  id: string
}

export interface PageRequest {
  limit: number
  cursor?: CursorPosition
  includeArchived: boolean
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export function validateCursorSigningKey(key: CursorSigningKey): void {
  const bytes = typeof key === 'string' ? Buffer.from(key, 'utf8') : key
  if (bytes.length < 32) throw new Error('Cursor signing key must contain at least 32 bytes')
}

export function encodeCursor(position: CursorPosition, context: string, key: CursorSigningKey): string {
  validateCursorSigningKey(key)
  const payload = canonicalPayload(context, position.createdAt, position.id)
  const encodedPayload = Buffer.from(payload, 'utf8').toString('base64url')
  return `${encodedPayload}.${signature(encodedPayload, key).toString('base64url')}`
}

export function decodeCursor(value: string, expectedContext: string, key: CursorSigningKey): CursorPosition {
  try {
    validateCursorSigningKey(key)
    if (!value || value.length > MAX_CURSOR_LENGTH) throw new Error('bad cursor')
    const parts = value.split('.')
    if (parts.length !== 2) throw new Error('bad cursor')
    const [encodedPayload, encodedSignature] = parts
    if (!encodedPayload || !encodedSignature || !isBase64Url(encodedPayload) || !isBase64Url(encodedSignature)) throw new Error('bad cursor')
    const suppliedSignature = Buffer.from(encodedSignature, 'base64url')
    if (suppliedSignature.toString('base64url') !== encodedSignature) throw new Error('bad cursor')
    const expectedSignature = signature(encodedPayload, key)
    if (suppliedSignature.length !== expectedSignature.length || !timingSafeEqual(suppliedSignature, expectedSignature)) throw new Error('bad cursor')
    const payloadText = Buffer.from(encodedPayload, 'base64url').toString('utf8')
    if (Buffer.from(payloadText, 'utf8').toString('base64url') !== encodedPayload) throw new Error('bad cursor')
    const decoded: unknown = JSON.parse(payloadText)
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) throw new Error('bad cursor')
    const record = decoded as Record<string, unknown>
    if (Object.keys(record).length !== 4 || record.v !== CURSOR_VERSION || record.context !== expectedContext
      || typeof record.at !== 'string' || typeof record.id !== 'string') throw new Error('bad cursor')
    if (!isCursorOrderValue(record.at) || !isCursorId(record.id)) throw new Error('bad cursor')
    if (payloadText !== canonicalPayload(record.context, record.at, record.id)) throw new Error('bad cursor')
    return { createdAt: record.at, id: record.id }
  } catch {
    throw new ValidationError('Cursor is invalid')
  }
}

export function pageFromRows<T extends { id: string }>(
  rows: T[],
  limit: number,
  context: string,
  key: CursorSigningKey,
  createdAt: (item: T) => string = (item) => (item as T & { createdAt: string }).createdAt,
): Page<T> {
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const last = items.at(-1)
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: createdAt(last), id: last.id }, context, key) : null,
  }
}

export function cursorScope(endpoint: string, context: Record<string, string | boolean | null>): string {
  return JSON.stringify({ endpoint, ...context })
}

export function attachExactCursorTimestamp<T extends object>(value: T, timestamp: string): T {
  if (!isCursorOrderValue(timestamp)) throw new DataIntegrityError('Stored cursor timestamp is invalid')
  Object.defineProperty(value, EXACT_CURSOR_TIMESTAMP, { value: timestamp, enumerable: false })
  return value
}

export function exactCursorTimestamp(value: object, fallback: string): string {
  const timestamp = (value as Record<PropertyKey, unknown>)[EXACT_CURSOR_TIMESTAMP]
  return typeof timestamp === 'string' ? timestamp : fallback
}

function canonicalPayload(context: string, at: string, id: string): string {
  return JSON.stringify({ v: CURSOR_VERSION, context, at, id })
}

function signature(payload: string, key: CursorSigningKey): Buffer {
  return createHmac('sha256', key).update(payload, 'utf8').digest()
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value)
}

function isCursorId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001F\u007F]/.test(value)
}

function isCursorOrderValue(value: string): boolean {
  return value.length <= 32 && /^\d{1,20}(?:\.\d{1,6})?$/.test(value)
}
