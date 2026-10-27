import { isIP } from 'node:net'
import { isAbsolute, normalize } from 'node:path'

import { createOidcAuthenticator, type OidcAuthenticatorConfig } from '../auth/oidc-authenticator.ts'
import { validateCursorSigningKey, type CursorSigningKey } from '../http/pagination.ts'

export interface RuntimeConfig {
  host: string
  port: number
  trustedProxies: string[]
  database: {
    url: string
    expectedRole: string
    connectTimeoutMs: number
    healthTimeoutMs: number
    poolMax: number
  }
  cursorSigningKey: CursorSigningKey
  oidc: OidcAuthenticatorConfig
  stagingLogin?: {
    passwordHashFile: string
    privateKeyFile: string
    keyId: string
    subject: string
    organizationId: string
    tokenTtlSeconds: number
    maxAttempts: number
    attemptWindowMs: number
    maxConcurrency: number
  }
  creativeAnalysis?: {
    apiKeyFile: string
    model: string
    timeoutMs: number
    maxConcurrency: number
    dailyLimit: number
  }
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
    const trustedProxies = csv(environment, 'TRUSTED_PROXY_ADDRESSES')
    if (trustedProxies.length > 16 || trustedProxies.some((value) => isIP(value) === 0) || new Set(trustedProxies).size !== trustedProxies.length) {
      throw new Error('invalid trusted proxies')
    }
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
    const stagingLogin = parseStagingLogin(environment)
    const creativeAnalysis = parseCreativeAnalysis(environment)
    if (stagingLogin) {
      const subjectMaximum = oidc.subjectMaxLength ?? 128
      if (!oidc.algorithms.includes('RS256') || stagingLogin.subject.length > subjectMaximum) throw new Error('staging signer does not match OIDC verifier')
    }
    return {
      host,
      port,
      trustedProxies,
      database: {
        url: databaseUrl,
        expectedRole,
        connectTimeoutMs: integer(environment, 'DATABASE_CONNECT_TIMEOUT_MS', 100, 30_000),
        healthTimeoutMs: integer(environment, 'DATABASE_HEALTH_TIMEOUT_MS', 50, 5_000),
        poolMax: integer(environment, 'DATABASE_POOL_MAX', 1, 100),
      },
      cursorSigningKey,
      oidc,
      ...(stagingLogin ? { stagingLogin } : {}),
      ...(creativeAnalysis ? { creativeAnalysis } : {}),
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

function parseCreativeAnalysis(environment: Readonly<Record<string, string | undefined>>): RuntimeConfig['creativeAnalysis'] {
  const enabled = environment.CREATIVE_ANALYSIS_ENABLED
  const settingNames = ['GEMINI_API_KEY_FILE', 'GEMINI_MODEL', 'GEMINI_TIMEOUT_MS', 'GEMINI_MAX_CONCURRENCY', 'CREATIVE_ANALYSIS_DAILY_LIMIT']
  if (enabled === undefined) {
    if (settingNames.some((name) => environment[name] !== undefined)) throw new Error('creative analysis settings require explicit enablement')
    return undefined
  }
  if (enabled !== 'true') throw new Error('invalid creative analysis enablement')
  const model = required(environment, 'GEMINI_MODEL', 100)
  if (!/^[A-Za-z0-9._-]+$/u.test(model)) throw new Error('invalid Gemini model')
  return {
    apiKeyFile: absolutePath(environment, 'GEMINI_API_KEY_FILE'),
    model,
    timeoutMs: integer(environment, 'GEMINI_TIMEOUT_MS', 1_000, 120_000),
    maxConcurrency: integer(environment, 'GEMINI_MAX_CONCURRENCY', 1, 16),
    dailyLimit: integer(environment, 'CREATIVE_ANALYSIS_DAILY_LIMIT', 1, 10_000),
  }
}

function parseStagingLogin(environment: Readonly<Record<string, string | undefined>>): RuntimeConfig['stagingLogin'] {
  const enabled = environment.STAGING_PASSWORD_LOGIN_ENABLED
  const settingNames = [
    'STAGING_LOGIN_PASSWORD_HASH_FILE', 'STAGING_LOGIN_PRIVATE_KEY_FILE', 'STAGING_LOGIN_KEY_ID', 'STAGING_LOGIN_SUBJECT', 'STAGING_LOGIN_ORGANIZATION_ID',
    'STAGING_LOGIN_TOKEN_TTL_SECONDS', 'STAGING_LOGIN_MAX_ATTEMPTS', 'STAGING_LOGIN_ATTEMPT_WINDOW_MS', 'STAGING_LOGIN_MAX_CONCURRENCY',
  ]
  if (enabled === undefined) {
    if (settingNames.some((name) => environment[name] !== undefined)) throw new Error('staging login settings require explicit enablement')
    return undefined
  }
  if (enabled !== 'true') throw new Error('invalid staging login enablement')
  const passwordHashFile = absolutePath(environment, 'STAGING_LOGIN_PASSWORD_HASH_FILE')
  const privateKeyFile = absolutePath(environment, 'STAGING_LOGIN_PRIVATE_KEY_FILE')
  return {
    passwordHashFile,
    privateKeyFile,
    keyId: required(environment, 'STAGING_LOGIN_KEY_ID', 128),
    subject: required(environment, 'STAGING_LOGIN_SUBJECT', 200),
    organizationId: required(environment, 'STAGING_LOGIN_ORGANIZATION_ID', 256),
    tokenTtlSeconds: integer(environment, 'STAGING_LOGIN_TOKEN_TTL_SECONDS', 300, 43_200),
    maxAttempts: integer(environment, 'STAGING_LOGIN_MAX_ATTEMPTS', 1, 100),
    attemptWindowMs: integer(environment, 'STAGING_LOGIN_ATTEMPT_WINDOW_MS', 1_000, 3_600_000),
    maxConcurrency: integer(environment, 'STAGING_LOGIN_MAX_CONCURRENCY', 1, 16),
  }
}

function absolutePath(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(environment, name, 4_096)
  if (!isAbsolute(value) || normalize(value) !== value) throw new Error(`invalid ${name}`)
  return value
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
