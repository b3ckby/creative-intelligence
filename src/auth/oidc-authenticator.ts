import { createHash } from 'node:crypto'

import type { FastifyRequest } from 'fastify'
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose'

import { AuthenticationError } from '../domain/errors.ts'
import { parseStrictJson } from '../http/strict-json.ts'

const DEFAULT_TIMEOUT_MS = 2_000
const DEFAULT_CACHE_TTL_MS = 300_000
const DEFAULT_MAX_BYTES = 64 * 1024
const DEFAULT_MAX_KEYS = 20
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 5
const DEFAULT_SUBJECT_MAX_LENGTH = 128

const SUPPORTED_ALGORITHMS = new Set(['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'])

export interface OidcAuthenticatorConfig {
  issuer: string
  jwksUrl: string
  audiences: string[]
  algorithms: string[]
  identityNamespace: string
  clockToleranceSeconds?: number
  jwksTimeoutMs?: number
  jwksCacheTtlMs?: number
  maxJwksBytes?: number
  maxJwksKeys?: number
  subjectMaxLength?: number
}

export interface OidcAuthenticatorDependencies {
  fetch?: typeof fetch
  now?: () => Date
  monotonicNow?: () => number
}

interface LoadedKey {
  alg: string
  key: CryptoKey
}

type KeySet = Map<string, LoadedKey>

export function createOidcAuthenticator(
  config: OidcAuthenticatorConfig,
  dependencies: OidcAuthenticatorDependencies = {},
): (request: FastifyRequest) => Promise<string> {
  const settings = validateConfig(config)
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch
  const now = dependencies.now ?? (() => new Date())
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now())
  let lastMonotonicTime = Number.NEGATIVE_INFINITY
  const elapsedNow = (): number => {
    const current = monotonicTime(monotonicNow)
    if (current < lastMonotonicTime) throw new Error('monotonic clock moved backward')
    lastMonotonicTime = current
    return current
  }
  let cached: { expiresAt: number, keys: KeySet } | undefined
  let refresh: Promise<KeySet> | undefined
  let lastUnknownRefreshAt = Number.NEGATIVE_INFINITY

  const startRefresh = async (): Promise<KeySet> => {
    if (refresh) return refresh
    refresh = fetchKeys(settings, fetchImplementation).then((keys) => {
      cached = { keys, expiresAt: elapsedNow() + settings.jwksCacheTtlMs }
      return keys
    }).finally(() => {
      refresh = undefined
    })
    return refresh
  }

  const loadKeys = async (): Promise<KeySet> => {
    const current = elapsedNow()
    if (cached && current < cached.expiresAt) return cached.keys
    return startRefresh()
  }

  const refreshKeys = async (): Promise<KeySet> => {
    if (refresh) return refresh
    const current = elapsedNow()
    const cooldown = Math.min(settings.jwksCacheTtlMs, 30_000)
    if (cached && current - lastUnknownRefreshAt < cooldown) return cached.keys
    lastUnknownRefreshAt = current
    return startRefresh()
  }

  return async (request: FastifyRequest): Promise<string> => {
    try {
      const token = bearerToken(request)
      const header = decodeProtectedHeader(token)
      if (typeof header.kid !== 'string' || typeof header.alg !== 'string') throw new Error('invalid protected header')
      let loaded = (await loadKeys()).get(header.kid)
      if (!loaded) loaded = (await refreshKeys()).get(header.kid)
      if (!loaded || loaded.alg !== header.alg) throw new Error('unknown key')
      const { payload } = await jwtVerify(token, loaded.key, {
        algorithms: settings.algorithms,
        audience: settings.audiences,
        issuer: settings.issuer,
        clockTolerance: settings.clockToleranceSeconds,
        currentDate: now(),
      })
      if (!Number.isInteger(payload.exp) || !Number.isInteger(payload.iat)) throw new Error('required time claim missing')
      if (payload.nbf !== undefined && !Number.isInteger(payload.nbf)) throw new Error('invalid time claim')
      const currentSeconds = Math.floor(now().getTime() / 1000)
      if ((payload.iat as number) > currentSeconds + settings.clockToleranceSeconds) throw new Error('future issued-at')
      const subject = validSubject(payload.sub, settings.subjectMaxLength)
      return `${settings.identityNamespace}:${createHash('sha256').update(settings.issuer).update('\0').update(subject).digest('base64url')}`
    } catch {
      throw new AuthenticationError()
    }
  }
}

function bearerToken(request: FastifyRequest): string {
  const raw = request.raw.rawHeaders
  let count = 0
  let value: string | undefined
  for (let index = 0; index < raw.length; index += 2) {
    if (raw[index]?.toLowerCase() === 'authorization') {
      count += 1
      value = raw[index + 1]
    }
  }
  if (count !== 1 || typeof value !== 'string' || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('invalid authorization')
  }
  return value.slice(7)
}

async function fetchKeys(settings: ValidatedConfig, fetchImplementation: typeof fetch): Promise<KeySet> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const retrieval = async (): Promise<KeySet> => {
    const response = await fetchImplementation(settings.jwksUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (response.status !== 200 || response.redirected || !response.body) throw new Error('JWKS request failed')
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > settings.maxJwksBytes) throw new Error('JWKS response too large')
      chunks.push(chunk)
    }
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    const parsed: unknown = parseStrictJson(decoded)
    if (!isRecord(parsed) || !Array.isArray(parsed.keys) || parsed.keys.length === 0 || parsed.keys.length > settings.maxJwksKeys) {
      throw new Error('invalid JWKS')
    }
    const result: KeySet = new Map()
    for (const candidate of parsed.keys) {
      const jwk = validateJwk(candidate, settings.algorithms)
      if (result.has(jwk.kid)) throw new Error('duplicate key identifier')
      result.set(jwk.kid, { alg: jwk.alg, key: await importJWK(jwk, jwk.alg) as CryptoKey })
    }
    return result
  }
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('JWKS request timed out'))
    }, settings.jwksTimeoutMs)
  })
  try {
    return await Promise.race([retrieval(), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

interface ValidatedJwk extends JWK {
  kid: string
  alg: string
}

function validateJwk(value: unknown, algorithms: readonly string[]): ValidatedJwk {
  if (!isRecord(value) || typeof value.kid !== 'string' || value.kid.length < 1 || value.kid.length > 128
      || /[\u0000-\u001f\u007f]/.test(value.kid)
      || typeof value.alg !== 'string' || !algorithms.includes(value.alg) || value.use !== 'sig') {
    throw new Error('unsupported JWK')
  }
  if (value.key_ops !== undefined
      && (!Array.isArray(value.key_ops) || value.key_ops.length !== 1 || value.key_ops[0] !== 'verify')) {
    throw new Error('unsupported JWK operations')
  }
  if (value.kty === 'RSA') {
    if (!value.alg.startsWith('RS') && !value.alg.startsWith('PS')) throw new Error('key algorithm mismatch')
    if (typeof value.n !== 'string' || typeof value.e !== 'string'
        || !isBase64urlUInt(value.n) || !isBase64urlUInt(value.e)
        || rsaModulusBits(value.n) < 2_048
        || !isSafeRsaExponent(value.e)
        || ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'].some((field) => field in value)) {
      throw new Error('invalid RSA key')
    }
  } else if (value.kty === 'EC') {
    const requiredCurve = { ES256: 'P-256', ES384: 'P-384', ES512: 'P-521' }[value.alg]
    const coordinateBytes = { ES256: 32, ES384: 48, ES512: 66 }[value.alg]
    if (!requiredCurve || !coordinateBytes || value.crv !== requiredCurve
        || typeof value.x !== 'string' || typeof value.y !== 'string'
        || !isCanonicalBase64urlBytes(value.x, coordinateBytes)
        || !isCanonicalBase64urlBytes(value.y, coordinateBytes)
        || (value.alg === 'ES512' && (Buffer.from(value.x, 'base64url')[0] ?? 2) > 1)
        || (value.alg === 'ES512' && (Buffer.from(value.y, 'base64url')[0] ?? 2) > 1)
        || 'd' in value) throw new Error('invalid EC key')
  } else {
    throw new Error('unsupported key type')
  }
  return value as unknown as ValidatedJwk
}

interface ValidatedConfig {
  issuer: string
  jwksUrl: string
  audiences: string[]
  algorithms: string[]
  identityNamespace: string
  clockToleranceSeconds: number
  jwksTimeoutMs: number
  jwksCacheTtlMs: number
  maxJwksBytes: number
  maxJwksKeys: number
  subjectMaxLength: number
}

function validateConfig(config: OidcAuthenticatorConfig): ValidatedConfig {
  try {
    const issuer = trustedUrl(config.issuer, false)
    const jwksUrl = trustedUrl(config.jwksUrl, true)
    const audiences = boundedUniqueStrings(config.audiences, 1, 16, 256)
    const algorithms = boundedUniqueStrings(config.algorithms, 1, SUPPORTED_ALGORITHMS.size, 8)
    if (algorithms.some((algorithm) => !SUPPORTED_ALGORITHMS.has(algorithm))) throw new Error('unsupported algorithm')
    if (typeof config.identityNamespace !== 'string' || !/^[a-z][a-z0-9_-]{7,31}$/.test(config.identityNamespace)) throw new Error('unsafe namespace')
    return {
      issuer,
      jwksUrl,
      audiences,
      algorithms,
      identityNamespace: config.identityNamespace,
      clockToleranceSeconds: boundedInteger(config.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS, 0, 60),
      jwksTimeoutMs: boundedInteger(config.jwksTimeoutMs ?? DEFAULT_TIMEOUT_MS, 100, 10_000),
      jwksCacheTtlMs: boundedInteger(config.jwksCacheTtlMs ?? DEFAULT_CACHE_TTL_MS, 1_000, 3_600_000),
      maxJwksBytes: boundedInteger(config.maxJwksBytes ?? DEFAULT_MAX_BYTES, 1_024, 1_048_576),
      maxJwksKeys: boundedInteger(config.maxJwksKeys ?? DEFAULT_MAX_KEYS, 1, 100),
      subjectMaxLength: boundedInteger(config.subjectMaxLength ?? DEFAULT_SUBJECT_MAX_LENGTH, 1, 200),
    }
  } catch {
    throw new Error('OIDC authentication configuration is invalid')
  }
}

function trustedUrl(value: unknown, allowQuery: boolean): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048
      || /[\s\p{Cc}\p{Cf}]/u.test(value) || value.includes('#')) throw new Error('invalid URL')
  const url = new URL(value)
  const authority = value.slice(value.indexOf('://') + 3).split(/[/?]/, 1)[0]
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (!allowQuery && url.search) || authority?.includes('@')) throw new Error('untrusted URL')
  return value
}

function isBase64urlUInt(value: string): boolean {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) return false
  const bytes = Buffer.from(value, 'base64url')
  return bytes[0] !== undefined && bytes[0] !== 0 && bytes.toString('base64url') === value
}

function isCanonicalBase64urlBytes(value: string, length: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false
  const bytes = Buffer.from(value, 'base64url')
  return bytes.length === length && bytes.toString('base64url') === value
}

function rsaModulusBits(value: string): number {
  const bytes = Buffer.from(value, 'base64url')
  const first = bytes[0]
  if (first === undefined || first === 0) return 0
  return ((bytes.length - 1) * 8) + (32 - Math.clz32(first))
}

function isSafeRsaExponent(value: string): boolean {
  const bytes = Buffer.from(value, 'base64url')
  let exponent = 0n
  for (const byte of bytes) exponent = (exponent << 8n) | BigInt(byte)
  return exponent >= 3n && exponent <= 0xffff_ffffn && exponent % 2n === 1n
}

function boundedUniqueStrings(value: unknown, minimum: number, maximum: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error('invalid list')
  const strings = value.map((entry) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > maxLength || /[\u0000-\u001f\u007f]/.test(entry)) throw new Error('invalid string')
    return entry
  })
  if (new Set(strings).size !== strings.length) throw new Error('duplicate value')
  return [...strings]
}

function monotonicTime(clock: () => number): number {
  const value = clock()
  if (!Number.isFinite(value) || value < 0) throw new Error('invalid monotonic clock')
  return value
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error('invalid bound')
  return value as number
}

function validSubject(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('invalid subject')
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
