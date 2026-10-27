import { createOidcAuthenticator, type OidcAuthenticatorConfig } from '../auth/oidc-authenticator.ts'
import { validateCursorSigningKey, type CursorSigningKey } from '../http/pagination.ts'

export interface RuntimeConfig {
  host: string
  port: number
  database: {
    url: string
    expectedRole: string
    connectTimeoutMs: number
    healthTimeoutMs: number
    poolMax: number
  }
  cursorSigningKey: CursorSigningKey
  oidc: OidcAuthenticatorConfig
  apify: {
    apiToken: string
    timeoutMs: number
    maxResponseBytes: number
    limit: number
    countryCode: string
    activeStatus: 'all' | 'active' | 'inactive'
    maxConcurrency: number
  }
}

export function parseRuntimeConfig(environment: Readonly<Record<string, string | undefined>>): RuntimeConfig {
  try {
    const host = required(environment, 'HOST', 255)
    if (/\s|[\u0000-\u001f\u007f]/u.test(host)) throw new Error('invalid host')
    const port = integer(environment, 'PORT', 1, 65_535)
    const databaseUrl = required(environment, 'DATABASE_URL', 4_096)
    const database = new URL(databaseUrl)
    if ((database.protocol !== 'postgres:' && database.protocol !== 'postgresql:') || database.hash) throw new Error('invalid database URL')
    const expectedRole = required(environment, 'DATABASE_RUNTIME_ROLE', 63)
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(expectedRole)) throw new Error('invalid database role')
    const cursorSigningKey = required(environment, 'CURSOR_SIGNING_KEY', 4_096)
    validateCursorSigningKey(cursorSigningKey)
    const oidcValues = {
      issuer: required(environment, 'OIDC_ISSUER', 2_048),
      jwksUrl: required(environment, 'OIDC_JWKS_URL', 2_048),
      audiences: csv(environment, 'OIDC_AUDIENCES'),
      algorithms: csv(environment, 'OIDC_ALGORITHMS'),
      identityNamespace: required(environment, 'OIDC_IDENTITY_NAMESPACE', 32),
      clockToleranceSeconds: optionalInteger(environment, 'OIDC_CLOCK_TOLERANCE_SECONDS'),
      jwksTimeoutMs: optionalInteger(environment, 'OIDC_JWKS_TIMEOUT_MS'),
      jwksCacheTtlMs: optionalInteger(environment, 'OIDC_JWKS_CACHE_TTL_MS'),
      maxJwksBytes: optionalInteger(environment, 'OIDC_MAX_JWKS_BYTES'),
      maxJwksKeys: optionalInteger(environment, 'OIDC_MAX_JWKS_KEYS'),
      subjectMaxLength: optionalInteger(environment, 'OIDC_SUBJECT_MAX_LENGTH'),
    }
    const oidc = Object.fromEntries(Object.entries(oidcValues).filter(([, value]) => value !== undefined)) as unknown as OidcAuthenticatorConfig
    createOidcAuthenticator(oidc, { fetch: async () => { throw new Error('not called') } })
    const activeStatus = required(environment, 'APIFY_ACTIVE_STATUS', 8)
    if (activeStatus !== 'ALL' && activeStatus !== 'ACTIVE' && activeStatus !== 'INACTIVE') throw new Error('invalid Apify active status')
    const countryCode = required(environment, 'APIFY_COUNTRY_CODE', 3)
    if (countryCode !== 'ALL' && !/^[A-Z]{2}$/u.test(countryCode)) throw new Error('invalid Apify country code')
    const apifyApiToken = required(environment, 'APIFY_API_TOKEN', 4_096)
    if (apifyApiToken.length < 10) throw new Error('invalid Apify API token')
    return {
      host,
      port,
      database: {
        url: databaseUrl,
        expectedRole,
        connectTimeoutMs: integer(environment, 'DATABASE_CONNECT_TIMEOUT_MS', 100, 30_000),
        healthTimeoutMs: integer(environment, 'DATABASE_HEALTH_TIMEOUT_MS', 50, 5_000),
        poolMax: integer(environment, 'DATABASE_POOL_MAX', 1, 100),
      },
      cursorSigningKey,
      oidc,
      apify: {
        apiToken: apifyApiToken,
        timeoutMs: integer(environment, 'APIFY_TIMEOUT_MS', 100, 120_000),
        maxResponseBytes: integer(environment, 'APIFY_MAX_RESPONSE_BYTES', 1_000, 16_777_216),
        limit: integer(environment, 'APIFY_AD_COUNT', 10, 100),
        countryCode,
        activeStatus: activeStatus.toLowerCase() as 'all' | 'active' | 'inactive',
        maxConcurrency: integer(environment, 'APIFY_MAX_CONCURRENCY', 1, 10),
      },
    }
  } catch {
    throw new Error('Runtime configuration is invalid')
  }
}

function required(environment: Readonly<Record<string, string | undefined>>, name: string, maxLength: number): string {
  const value = environment[name]
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || /[\s\p{Cc}\p{Cf}]/u.test(value)) throw new Error(`invalid ${name}`)
  return value
}

function integer(environment: Readonly<Record<string, string | undefined>>, name: string, minimum: number, maximum: number): number {
  const value = required(environment, name, 10)
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`invalid ${name}`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`invalid ${name}`)
  return parsed
}

function optionalInteger(environment: Readonly<Record<string, string | undefined>>, name: string): number | undefined {
  if (environment[name] === undefined) return undefined
  const value = required(environment, name, 10)
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`invalid ${name}`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid ${name}`)
  return parsed
}

function csv(environment: Readonly<Record<string, string | undefined>>, name: string): string[] {
  const value = required(environment, name, 4_096)
  const entries = value.split(',')
  if (entries.some((entry) => entry.length === 0 || entry !== entry.trim())) throw new Error(`invalid ${name}`)
  return entries
}
