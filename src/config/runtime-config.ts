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
    maxMediaCount: number
    maxMediaBytes: number
    autoTagging?: {
      intervalMs: number
      leaseSeconds: number
      batchSize: number
      concurrency: number
      backoffBaseMs: number
      backoffMaxMs: number
      workerDatabase: { url: string; expectedRole: string }
    }
  }
  scheduledSync?: {
    intervalMs: number
    leaseSeconds: number
    maxAttempts: number
    backoffBaseMs: number
    backoffMaxMs: number
    batchSize: number
    concurrency: number
    workerDatabase: { url: string; expectedRole: string }
  }
  mediaMirror?: {
    storageRoot: string
    intervalMs: number
    leaseSeconds: number
    batchSize: number
    concurrency: number
    backfillBatchSize: number
    backoffBaseMs: number
    backoffMaxMs: number
    fetchTimeoutMs: number
    maxBytes: number
    maxRedirects: number
    workerDatabase: { url: string; expectedRole: string }
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
    const scheduledSync = parseScheduledSync(environment)
    const mediaMirror = parseMediaMirror(environment)
    if (creativeAnalysis?.autoTagging && !mediaMirror) throw new Error('auto analysis requires media mirror')
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
      ...(scheduledSync ? { scheduledSync } : {}),
      ...(mediaMirror ? { mediaMirror } : {}),
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

function parseMediaMirror(environment: Readonly<Record<string, string | undefined>>): RuntimeConfig['mediaMirror'] {
  const enabled = environment.MEDIA_MIRROR_ENABLED
  const names = [
    'MEDIA_MIRROR_STORAGE_ROOT','MEDIA_MIRROR_INTERVAL_MS','MEDIA_MIRROR_LEASE_SECONDS','MEDIA_MIRROR_BATCH_SIZE','MEDIA_MIRROR_CONCURRENCY',
    'MEDIA_MIRROR_BACKFILL_BATCH_SIZE','MEDIA_MIRROR_BACKOFF_BASE_MS','MEDIA_MIRROR_BACKOFF_MAX_MS','MEDIA_MIRROR_FETCH_TIMEOUT_MS',
    'MEDIA_MIRROR_MAX_BYTES','MEDIA_MIRROR_MAX_REDIRECTS','MEDIA_MIRROR_WORKER_DATABASE_URL','MEDIA_MIRROR_WORKER_DATABASE_ROLE',
  ]
  if (enabled === undefined) {
    if (names.some((name) => environment[name] !== undefined)) throw new Error('media mirror settings require explicit enablement')
    return undefined
  }
  if (enabled !== 'true') throw new Error('invalid media mirror enablement')
  const storageRoot = absolutePath(environment, 'MEDIA_MIRROR_STORAGE_ROOT')
  if (storageRoot === '/') throw new Error('unsafe media storage root')
  const result = {
    storageRoot,
    intervalMs: integer(environment, 'MEDIA_MIRROR_INTERVAL_MS', 100, 3_600_000),
    leaseSeconds: integer(environment, 'MEDIA_MIRROR_LEASE_SECONDS', 10, 3_600),
    batchSize: integer(environment, 'MEDIA_MIRROR_BATCH_SIZE', 1, 100),
    concurrency: integer(environment, 'MEDIA_MIRROR_CONCURRENCY', 1, 16),
    backfillBatchSize: integer(environment, 'MEDIA_MIRROR_BACKFILL_BATCH_SIZE', 1, 1_000),
    backoffBaseMs: integer(environment, 'MEDIA_MIRROR_BACKOFF_BASE_MS', 100, 3_600_000),
    backoffMaxMs: integer(environment, 'MEDIA_MIRROR_BACKOFF_MAX_MS', 100, 86_400_000),
    fetchTimeoutMs: integer(environment, 'MEDIA_MIRROR_FETCH_TIMEOUT_MS', 100, 120_000),
    maxBytes: integer(environment, 'MEDIA_MIRROR_MAX_BYTES', 1_000, 104_857_600),
    maxRedirects: integer(environment, 'MEDIA_MIRROR_MAX_REDIRECTS', 0, 5),
    workerDatabase: {
      url: required(environment, 'MEDIA_MIRROR_WORKER_DATABASE_URL', 4_096),
      expectedRole: required(environment, 'MEDIA_MIRROR_WORKER_DATABASE_ROLE', 63),
    },
  }
  const workerUrl = new URL(result.workerDatabase.url)
  if ((workerUrl.protocol !== 'postgres:' && workerUrl.protocol !== 'postgresql:') || workerUrl.hash
    || result.workerDatabase.expectedRole !== 'creative_intelligence_media_worker'
    || result.concurrency > result.batchSize || result.backoffMaxMs < result.backoffBaseMs
    || result.leaseSeconds * 1_000 < result.fetchTimeoutMs + 10_000) throw new Error('unsafe media mirror settings')
  return result
}

function parseScheduledSync(environment: Readonly<Record<string, string | undefined>>): RuntimeConfig['scheduledSync'] {
  const scheduledWorkerRole = 'creative_intelligence_scheduled_worker'
  const enabled = environment.AD_SYNC_ENABLED
  const names = ['AD_SYNC_INTERVAL_MS', 'AD_SYNC_LEASE_SECONDS', 'AD_SYNC_MAX_ATTEMPTS', 'AD_SYNC_BACKOFF_BASE_MS', 'AD_SYNC_BACKOFF_MAX_MS', 'AD_SYNC_BATCH_SIZE', 'AD_SYNC_CONCURRENCY', 'AD_SYNC_WORKER_DATABASE_URL', 'AD_SYNC_WORKER_DATABASE_ROLE']
  if (enabled === undefined) {
    if (names.some((name) => environment[name] !== undefined)) throw new Error('scheduled sync settings require explicit enablement')
    return undefined
  }
  if (enabled !== 'true') throw new Error('invalid scheduled sync enablement')
  const result = {
    intervalMs: integer(environment, 'AD_SYNC_INTERVAL_MS', 100, 3_600_000),
    leaseSeconds: integer(environment, 'AD_SYNC_LEASE_SECONDS', 10, 3_600),
    maxAttempts: integer(environment, 'AD_SYNC_MAX_ATTEMPTS', 1, 20),
    backoffBaseMs: integer(environment, 'AD_SYNC_BACKOFF_BASE_MS', 100, 3_600_000),
    backoffMaxMs: integer(environment, 'AD_SYNC_BACKOFF_MAX_MS', 100, 86_400_000),
    batchSize: integer(environment, 'AD_SYNC_BATCH_SIZE', 1, 100),
    concurrency: integer(environment, 'AD_SYNC_CONCURRENCY', 1, 16),
    workerDatabase: {
      url: required(environment, 'AD_SYNC_WORKER_DATABASE_URL', 4_096),
      expectedRole: required(environment, 'AD_SYNC_WORKER_DATABASE_ROLE', 63),
    },
  }
  const workerUrl = new URL(result.workerDatabase.url)
  if ((workerUrl.protocol !== 'postgres:' && workerUrl.protocol !== 'postgresql:') || workerUrl.hash
      || result.workerDatabase.expectedRole !== scheduledWorkerRole
      || result.backoffMaxMs < result.backoffBaseMs || result.concurrency > result.batchSize
      || result.leaseSeconds * 1_000 < integer(environment, 'APIFY_TIMEOUT_MS', 100, 120_000) + 30_000) throw new Error('unsafe scheduled sync settings')
  return result
}

function parseCreativeAnalysis(environment: Readonly<Record<string, string | undefined>>): RuntimeConfig['creativeAnalysis'] {
  const enabled = environment.CREATIVE_ANALYSIS_ENABLED
  const settingNames = ['GEMINI_API_KEY_FILE', 'GEMINI_MODEL', 'GEMINI_TIMEOUT_MS', 'GEMINI_MAX_CONCURRENCY', 'CREATIVE_ANALYSIS_DAILY_LIMIT', 'CREATIVE_ANALYSIS_MAX_MEDIA_COUNT', 'CREATIVE_ANALYSIS_MAX_MEDIA_BYTES', 'AUTO_ANALYSIS_ENABLED', 'AUTO_ANALYSIS_INTERVAL_MS', 'AUTO_ANALYSIS_LEASE_SECONDS', 'AUTO_ANALYSIS_BATCH_SIZE', 'AUTO_ANALYSIS_CONCURRENCY', 'AUTO_ANALYSIS_BACKOFF_BASE_MS', 'AUTO_ANALYSIS_BACKOFF_MAX_MS', 'AUTO_ANALYSIS_WORKER_DATABASE_URL', 'AUTO_ANALYSIS_WORKER_DATABASE_ROLE']
  if (enabled === undefined) {
    if (settingNames.some((name) => environment[name] !== undefined)) throw new Error('creative analysis settings require explicit enablement')
    return undefined
  }
  if (enabled !== 'true') throw new Error('invalid creative analysis enablement')
  const model = required(environment, 'GEMINI_MODEL', 100)
  if (!/^[A-Za-z0-9._-]+$/u.test(model)) throw new Error('invalid Gemini model')
  const timeoutMs = integer(environment, 'GEMINI_TIMEOUT_MS', 1_000, 120_000)
  const autoEnabled = environment.AUTO_ANALYSIS_ENABLED
  if (autoEnabled !== undefined && autoEnabled !== 'true') throw new Error('invalid auto analysis enablement')
  const autoTagging = autoEnabled === 'true' ? {
    intervalMs: integer(environment, 'AUTO_ANALYSIS_INTERVAL_MS', 100, 3_600_000),
    leaseSeconds: integer(environment, 'AUTO_ANALYSIS_LEASE_SECONDS', 10, 3_600),
    batchSize: integer(environment, 'AUTO_ANALYSIS_BATCH_SIZE', 1, 100),
    concurrency: integer(environment, 'AUTO_ANALYSIS_CONCURRENCY', 1, 16),
    backoffBaseMs: integer(environment, 'AUTO_ANALYSIS_BACKOFF_BASE_MS', 100, 3_600_000),
    backoffMaxMs: integer(environment, 'AUTO_ANALYSIS_BACKOFF_MAX_MS', 100, 86_400_000),
    workerDatabase: { url: required(environment, 'AUTO_ANALYSIS_WORKER_DATABASE_URL', 4_096), expectedRole: required(environment, 'AUTO_ANALYSIS_WORKER_DATABASE_ROLE', 63) },
  } : undefined
  if (autoTagging) {
    const workerUrl = new URL(autoTagging.workerDatabase.url)
    if ((workerUrl.protocol !== 'postgres:' && workerUrl.protocol !== 'postgresql:') || workerUrl.hash
      || autoTagging.workerDatabase.expectedRole !== 'creative_intelligence_analysis_worker'
      || autoTagging.concurrency > autoTagging.batchSize || autoTagging.backoffMaxMs < autoTagging.backoffBaseMs
      || autoTagging.leaseSeconds * 1_000 < timeoutMs + 10_000) throw new Error('unsafe auto analysis settings')
  }
  const maxMediaCount = optionalInteger(environment, 'CREATIVE_ANALYSIS_MAX_MEDIA_COUNT') ?? 4
  const maxMediaBytes = optionalInteger(environment, 'CREATIVE_ANALYSIS_MAX_MEDIA_BYTES') ?? 8 * 1024 * 1024
  if (maxMediaCount < 0 || maxMediaCount > 16 || maxMediaBytes < 1 || maxMediaBytes > 32 * 1024 * 1024) throw new Error('invalid creative media bounds')
  return {
    apiKeyFile: absolutePath(environment, 'GEMINI_API_KEY_FILE'),
    model,
    timeoutMs,
    maxConcurrency: integer(environment, 'GEMINI_MAX_CONCURRENCY', 1, 16),
    dailyLimit: integer(environment, 'CREATIVE_ANALYSIS_DAILY_LIMIT', 1, 10_000),
    maxMediaCount,
    maxMediaBytes,
    ...(autoTagging ? { autoTagging } : {}),
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
