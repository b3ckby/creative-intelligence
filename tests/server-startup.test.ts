import assert from 'node:assert/strict'
import { generateKeyPairSync, scryptSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import type { FastifyInstance } from 'fastify'
import { createProductionApp } from '../src/app.ts'
import { parseRuntimeConfig } from '../src/config/runtime-config.ts'
import { checkDatabaseReadiness, verifyScheduledWorkerDatabase, type RuntimeSqlPool } from '../src/persistence/postgres-pool.ts'
import { startProductionServer } from '../src/server.ts'

const VALID_ENV = {
  HOST: '127.0.0.1',
  PORT: '3000',
  TRUSTED_PROXY_ADDRESSES: '127.0.0.1',
  DATABASE_URL: 'postgresql://runtime:secret@127.0.0.1:5432/creative_intelligence',
  DATABASE_RUNTIME_ROLE: 'creative_intelligence_runtime',
  DATABASE_CONNECT_TIMEOUT_MS: '2000',
  DATABASE_HEALTH_TIMEOUT_MS: '500',
  DATABASE_POOL_MAX: '10',
  CURSOR_SIGNING_KEY: 'production-cursor-signing-key-at-least-32-bytes',
  OIDC_ISSUER: 'https://identity.example.com/',
  OIDC_JWKS_URL: 'https://identity.example.com/.well-known/jwks.json',
  OIDC_AUDIENCES: 'creative-api',
  OIDC_ALGORITHMS: 'RS256',
  OIDC_IDENTITY_NAMESPACE: 'creative_oidc',
  APIFY_API_TOKEN: 'fixture-apify-credential',
  APIFY_TIMEOUT_MS: '60000',
  APIFY_MAX_RESPONSE_BYTES: '5000000',
  APIFY_AD_COUNT: '100',
  APIFY_COUNTRY_CODE: 'ALL',
  APIFY_ACTIVE_STATUS: 'ACTIVE',
  APIFY_MAX_CONCURRENCY: '2',
}

function safeRoleRow(expectedRole: string): Record<string, unknown> {
  const scheduledWorker = expectedRole === 'creative_intelligence_scheduled_worker'
  return {
    current_user: expectedRole,
    session_user: `${expectedRole}_login`,
    rolsuper: false,
    rolbypassrls: false,
    rolcanlogin: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    session_rolsuper: false,
    session_rolbypassrls: false,
    session_rolcanlogin: true,
    session_rolcreatedb: false,
    session_rolcreaterole: false,
    session_rolreplication: false,
    can_assume_privileged_role: false,
    can_assume_scheduled_worker: scheduledWorker,
    can_assume_unexpected_role: false,
    has_unsafe_direct_acl: false,
    has_unsafe_owner: false,
  }
}

test('production start executable is installed with production dependencies', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts?: Record<string, string>
    dependencies?: Record<string, string>
  }
  const executable = manifest.scripts?.start?.trim().split(/\s+/, 1)[0]
  assert.equal(executable, 'tsx')
  assert.equal(typeof manifest.dependencies?.[executable], 'string')
})

test('runtime configuration fails closed when production authentication settings are missing', () => {
  const { OIDC_ISSUER: _missing, ...environment } = VALID_ENV
  assert.throws(() => parseRuntimeConfig(environment), {
    message: 'Runtime configuration is invalid',
  })
})

test('runtime configuration fails closed when Apify credentials are missing', () => {
  const { APIFY_API_TOKEN: _missing, ...environment } = VALID_ENV
  assert.throws(() => parseRuntimeConfig(environment), { message: 'Runtime configuration is invalid' })
})

test('scheduled sync config requires explicit enablement and bounded safe values', () => {
  assert.equal(parseRuntimeConfig(VALID_ENV).scheduledSync, undefined)
  assert.throws(() => parseRuntimeConfig({ ...VALID_ENV, AD_SYNC_INTERVAL_MS: '1000' }), { message: 'Runtime configuration is invalid' })
  const enabled = parseRuntimeConfig({
    ...VALID_ENV,
    AD_SYNC_ENABLED: 'true', AD_SYNC_INTERVAL_MS: '5000', AD_SYNC_LEASE_SECONDS: '120',
    AD_SYNC_MAX_ATTEMPTS: '4', AD_SYNC_BACKOFF_BASE_MS: '1000', AD_SYNC_BACKOFF_MAX_MS: '60000',
    AD_SYNC_BATCH_SIZE: '10', AD_SYNC_CONCURRENCY: '2',
    AD_SYNC_WORKER_DATABASE_URL: 'postgresql://worker:***@127.0.0.1:5432/creative_intelligence',
    AD_SYNC_WORKER_DATABASE_ROLE: 'creative_intelligence_scheduled_worker',
  }).scheduledSync
  assert.deepEqual(enabled, { intervalMs: 5000, leaseSeconds: 120, maxAttempts: 4, backoffBaseMs: 1000, backoffMaxMs: 60000, batchSize: 10, concurrency: 2,
    workerDatabase: { url: 'postgresql://worker:***@127.0.0.1:5432/creative_intelligence', expectedRole: 'creative_intelligence_scheduled_worker' } })
  assert.throws(() => parseRuntimeConfig({ ...VALID_ENV, AD_SYNC_ENABLED: 'true', AD_SYNC_INTERVAL_MS: '1' }), { message: 'Runtime configuration is invalid' })
  assert.throws(() => parseRuntimeConfig({ ...VALID_ENV, AD_SYNC_ENABLED: 'true', AD_SYNC_INTERVAL_MS: '5000', AD_SYNC_LEASE_SECONDS: '60', AD_SYNC_MAX_ATTEMPTS: '4', AD_SYNC_BACKOFF_BASE_MS: '1000', AD_SYNC_BACKOFF_MAX_MS: '60000', AD_SYNC_BATCH_SIZE: '10', AD_SYNC_CONCURRENCY: '2' }), { message: 'Runtime configuration is invalid' })
  assert.throws(() => parseRuntimeConfig({ ...VALID_ENV, AD_SYNC_ENABLED: 'true', AD_SYNC_INTERVAL_MS: '5000', AD_SYNC_LEASE_SECONDS: '60', AD_SYNC_MAX_ATTEMPTS: '4', AD_SYNC_BACKOFF_BASE_MS: '1000', AD_SYNC_BACKOFF_MAX_MS: '60000', AD_SYNC_BATCH_SIZE: '10', AD_SYNC_CONCURRENCY: '2', AD_SYNC_WORKER_DATABASE_URL: 'postgresql://worker:***@127.0.0.1/db', AD_SYNC_WORKER_DATABASE_ROLE: 'creative_intelligence_scheduled_worker' }), { message: 'Runtime configuration is invalid' })
  assert.throws(() => parseRuntimeConfig({ ...VALID_ENV, AD_SYNC_ENABLED: 'true', AD_SYNC_INTERVAL_MS: '5000', AD_SYNC_LEASE_SECONDS: '120', AD_SYNC_MAX_ATTEMPTS: '4', AD_SYNC_BACKOFF_BASE_MS: '1000', AD_SYNC_BACKOFF_MAX_MS: '60000', AD_SYNC_BATCH_SIZE: '10', AD_SYNC_CONCURRENCY: '2', AD_SYNC_WORKER_DATABASE_URL: 'postgresql://worker:***@127.0.0.1/db', AD_SYNC_WORKER_DATABASE_ROLE: 'some_other_worker' }), { message: 'Runtime configuration is invalid' })
})

test('documented scheduled defaults have a thirty-second post-provider lease margin', async () => {
  const text = await readFile(new URL('../.env.example', import.meta.url), 'utf8')
  const scheduledNames = new Set([
    'AD_SYNC_ENABLED', 'AD_SYNC_INTERVAL_MS', 'AD_SYNC_LEASE_SECONDS', 'AD_SYNC_MAX_ATTEMPTS',
    'AD_SYNC_BACKOFF_BASE_MS', 'AD_SYNC_BACKOFF_MAX_MS', 'AD_SYNC_BATCH_SIZE', 'AD_SYNC_CONCURRENCY',
    'AD_SYNC_WORKER_DATABASE_URL', 'AD_SYNC_WORKER_DATABASE_ROLE',
  ])
  const environment: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = /^(?:# )?([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line)
    if (match && (!line.startsWith('# ') || scheduledNames.has(match[1]!))) environment[match[1]!] = match[2]!
  }
  const parsed = parseRuntimeConfig(environment)
  assert.equal(parsed.apify.timeoutMs, 120_000)
  assert.equal(parsed.scheduledSync?.leaseSeconds, 180)
  assert.throws(() => parseRuntimeConfig({ ...environment, AD_SYNC_LEASE_SECONDS: '149' }), {
    message: 'Runtime configuration is invalid',
  })
})

test('scheduled worker verification rejects arbitrary role membership and inspects exact login ACLs', async () => {
  const queried: string[] = []
  const pool = {
    query: async (sql: string) => {
      queried.push(sql)
      return { rows: [{
        ...safeRoleRow('creative_intelligence_scheduled_worker'),
        can_assume_unexpected_role: true,
      }], rowCount: 1 }
    },
    connect: async () => { throw new Error('not used') },
    end: async () => undefined,
  } as unknown as RuntimeSqlPool
  await assert.rejects(() => verifyScheduledWorkerDatabase(pool, 2_000), {
    message: 'Database startup validation failed',
  })
  assert.match(queried[0]!, /unexpected_role/u)
  assert.match(queried[0]!, /aclexplode/u)
  assert.match(queried[0]!, /grantee = login_role\.oid/u)
})

test('scheduled worker verification rejects application object ownership independently of ACLs', async () => {
  const queried: string[] = []
  const pool = {
    query: async (sql: string) => {
      queried.push(sql)
      return { rows: [{
        ...safeRoleRow('creative_intelligence_scheduled_worker'),
        has_unsafe_owner: true,
      }], rowCount: 1 }
    },
    connect: async () => { throw new Error('not used') },
    end: async () => undefined,
  } as unknown as RuntimeSqlPool
  await assert.rejects(() => verifyScheduledWorkerDatabase(pool, 2_000), {
    message: 'Database startup validation failed',
  })
  assert.match(queried[0]!, /datdba = login_role\.oid/u)
  assert.match(queried[0]!, /nspowner = login_role\.oid/u)
  assert.match(queried[0]!, /relowner = login_role\.oid/u)
  assert.match(queried[0]!, /proowner = login_role\.oid/u)
  assert.match(queried[0]!, /typowner = login_role\.oid/u)
})

test('runtime configuration rejects unsafe database, network, pool, and signing settings', () => {
  const invalid = [
    { PORT: '0' },
    { HOST: 'bad host' },
    { TRUSTED_PROXY_ADDRESSES: '127.0.0.1,proxy.internal' },
    { DATABASE_URL: 'https://database.example.com/app' },
    { DATABASE_URL: 'postgresql://runtime:secret@db.example.com/app#fragment' },
    { DATABASE_URL: 'postgresql://runtime:secret@db.example.com/app\u00a0' },
    { DATABASE_RUNTIME_ROLE: 'Postgres' },
    { DATABASE_CONNECT_TIMEOUT_MS: '99' },
    { DATABASE_HEALTH_TIMEOUT_MS: '5001' },
    { DATABASE_POOL_MAX: '101' },
    { CURSOR_SIGNING_KEY: 'short' },
    { OIDC_AUDIENCES: 'one, two' },
    { OIDC_ALGORITHMS: 'HS256' },
    { APIFY_TIMEOUT_MS: '120001' },
    { APIFY_API_TOKEN: 'short' },
    { APIFY_MAX_RESPONSE_BYTES: '999' },
    { APIFY_AD_COUNT: '101' },
    { APIFY_COUNTRY_CODE: 'usa' },
    { APIFY_ACTIVE_STATUS: 'PAUSED' },
    { APIFY_MAX_CONCURRENCY: '11' },
  ]
  for (const override of invalid) {
    assert.throws(() => parseRuntimeConfig({ ...VALID_ENV, ...override }), {
      message: 'Runtime configuration is invalid',
    })
  }
})

test('runtime configuration accepts complete opt-in staging password login settings and rejects partial settings', () => {
  const enabled = {
    ...VALID_ENV,
    STAGING_PASSWORD_LOGIN_ENABLED: 'true',
    STAGING_LOGIN_PASSWORD_HASH_FILE: '/run/credentials/password-hash',
    STAGING_LOGIN_PRIVATE_KEY_FILE: '/run/credentials/private-key',
    STAGING_LOGIN_KEY_ID: 'staging-key-1',
    STAGING_LOGIN_SUBJECT: 'denis',
    STAGING_LOGIN_ORGANIZATION_ID: 'staging-org',
    STAGING_LOGIN_TOKEN_TTL_SECONDS: '43200',
    STAGING_LOGIN_MAX_ATTEMPTS: '5',
    STAGING_LOGIN_ATTEMPT_WINDOW_MS: '300000',
    STAGING_LOGIN_MAX_CONCURRENCY: '2',
  }
  assert.deepEqual(parseRuntimeConfig(enabled).stagingLogin, {
    passwordHashFile: '/run/credentials/password-hash',
    privateKeyFile: '/run/credentials/private-key',
    keyId: 'staging-key-1',
    subject: 'denis',
    organizationId: 'staging-org',
    tokenTtlSeconds: 43_200,
    maxAttempts: 5,
    attemptWindowMs: 300_000,
    maxConcurrency: 2,
  })
  assert.deepEqual(parseRuntimeConfig(enabled).trustedProxies, ['127.0.0.1'])
  assert.throws(() => parseRuntimeConfig({ ...VALID_ENV, STAGING_PASSWORD_LOGIN_ENABLED: 'true' }), {
    message: 'Runtime configuration is invalid',
  })
  assert.throws(() => parseRuntimeConfig({ ...enabled, STAGING_LOGIN_PRIVATE_KEY_FILE: 'relative.pem' }), {
    message: 'Runtime configuration is invalid',
  })
  for (const override of [
    { OIDC_ALGORITHMS: 'ES256' },
    { STAGING_LOGIN_KEY_ID: 'k'.repeat(129) },
    { OIDC_SUBJECT_MAX_LENGTH: '8', STAGING_LOGIN_SUBJECT: 'subject-too-long' },
    { STAGING_LOGIN_MAX_CONCURRENCY: '17' },
  ]) {
    assert.throws(() => parseRuntimeConfig({ ...enabled, ...override }), { message: 'Runtime configuration is invalid' })
  }
})

test('runtime configuration accepts opt-in creative analysis only with an external credential file', () => {
  const enabled = {
    ...VALID_ENV,
    CREATIVE_ANALYSIS_ENABLED: 'true',
    GEMINI_API_KEY_FILE: '/run/credentials/gemini-api-key',
    GEMINI_MODEL: 'gemini-2.5-flash',
    GEMINI_TIMEOUT_MS: '30000',
    GEMINI_MAX_CONCURRENCY: '2',
    CREATIVE_ANALYSIS_DAILY_LIMIT: '100',
  }
  assert.deepEqual(parseRuntimeConfig(enabled).creativeAnalysis, {
    apiKeyFile: '/run/credentials/gemini-api-key', model: 'gemini-2.5-flash', timeoutMs: 30_000, maxConcurrency: 2, dailyLimit: 100,
  })
  assert.throws(() => parseRuntimeConfig({ ...VALID_ENV, CREATIVE_ANALYSIS_ENABLED: 'true' }), { message: 'Runtime configuration is invalid' })
  assert.throws(() => parseRuntimeConfig({ ...enabled, GEMINI_API_KEY_FILE: 'relative-key' }), { message: 'Runtime configuration is invalid' })
  assert.throws(() => parseRuntimeConfig({ ...enabled, GEMINI_MAX_CONCURRENCY: '0' }), { message: 'Runtime configuration is invalid' })
})

test('production composition loads staging login secrets from files and enables password exchange', async () => {
  const salt = Buffer.from('0123456789abcdef', 'utf8')
  const password = 'correct horse battery staple'
  const digest = scryptSync(password, salt, 32)
  const hash = `scrypt-v1$${salt.toString('base64url')}$${digest.toString('base64url')}`
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'staging-key-1', alg: 'RS256', use: 'sig' }
  let jwksFetches = 0
  const environment = {
    ...VALID_ENV,
    STAGING_PASSWORD_LOGIN_ENABLED: 'true',
    STAGING_LOGIN_PASSWORD_HASH_FILE: '/run/credentials/password-hash',
    STAGING_LOGIN_PRIVATE_KEY_FILE: '/run/credentials/private-key',
    STAGING_LOGIN_KEY_ID: 'staging-key-1',
    STAGING_LOGIN_SUBJECT: 'denis',
    STAGING_LOGIN_ORGANIZATION_ID: 'staging-org',
    STAGING_LOGIN_TOKEN_TTL_SECONDS: '43200',
    STAGING_LOGIN_MAX_ATTEMPTS: '5',
    STAGING_LOGIN_ATTEMPT_WINDOW_MS: '300000',
    STAGING_LOGIN_MAX_CONCURRENCY: '2',
  }
  const pool = {
    query: async () => ({ rows: [{ current_user: 'creative_intelligence_runtime', session_user: 'application_login', rolsuper: false, rolbypassrls: false, session_rolsuper: false, session_rolbypassrls: false, can_assume_privileged_role: false, can_assume_forbidden_role: false }], rowCount: 1 }),
    connect: async () => { throw new Error('not used') },
    end: async () => undefined,
  } as unknown as RuntimeSqlPool
  const app = await createProductionApp(parseRuntimeConfig(environment), {
    createPool: () => pool,
    readSecretFile: async (path) => path.endsWith('password-hash') ? hash : privateKeyPem,
    createStagingLoginRateLimiter: () => ({ claim: async () => true, reset: async () => undefined }),
    verifyStagingMembership: async (_pool, _userId, organizationId) => organizationId === 'staging-org',
    fetch: async () => {
      jwksFetches += 1
      return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  assert.equal(jwksFetches, 1)
  const response = await app.inject({ method: 'POST', url: '/auth/staging-login', payload: { password } })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().organizationId, 'staging-org')
  assert.match(response.json().accessToken, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u)
  await app.close()

  await assert.rejects(() => createProductionApp(parseRuntimeConfig(environment), {
    createPool: () => pool,
    readSecretFile: async (path) => path.endsWith('password-hash') ? hash : privateKeyPem,
    createStagingLoginRateLimiter: () => ({ claim: async () => true, reset: async () => undefined }),
    verifyStagingMembership: async () => false,
    fetch: async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { 'content-type': 'application/json' } }),
  }), { message: 'Staging login membership is invalid' })
})

test('startup rejects a database role mismatch and closes the pool', async () => {
  let ended = 0
  const pool = {
    query: async () => ({ rows: [{ current_user: 'wrong_role', session_user: 'application_login', rolsuper: false, rolbypassrls: false, session_rolsuper: false, session_rolbypassrls: false, can_assume_privileged_role: false, can_assume_forbidden_role: false }], rowCount: 1 }),
    connect: async () => { throw new Error('not used') },
    end: async () => { ended += 1 },
  } as unknown as RuntimeSqlPool

  await assert.rejects(
    () => createProductionApp(parseRuntimeConfig(VALID_ENV), { createPool: () => pool }),
    { message: 'Database startup validation failed' },
  )
  assert.equal(ended, 1)
})

test('startup rejects unavailable and privileged database roles with one fixed error', async () => {
  for (const query of [
    async () => { throw new Error('connect ECONNREFUSED postgresql://secret@private-host') },
    async () => ({ rows: [{ current_user: 'creative_intelligence_runtime', session_user: 'application_login', rolsuper: true, rolbypassrls: false, session_rolsuper: false, session_rolbypassrls: false, can_assume_privileged_role: false, can_assume_forbidden_role: false }], rowCount: 1 }),
    async () => ({ rows: [{ current_user: 'creative_intelligence_runtime', session_user: 'application_login', rolsuper: false, rolbypassrls: true, session_rolsuper: false, session_rolbypassrls: false, can_assume_privileged_role: false, can_assume_forbidden_role: false }], rowCount: 1 }),
    async () => ({ rows: [{ current_user: 'creative_intelligence_runtime', session_user: 'application_login', rolsuper: false, rolbypassrls: false, session_rolsuper: true, session_rolbypassrls: false, can_assume_privileged_role: false, can_assume_forbidden_role: false }], rowCount: 1 }),
    async () => ({ rows: [{ current_user: 'creative_intelligence_runtime', session_user: 'application_login', rolsuper: false, rolbypassrls: false, session_rolsuper: false, session_rolbypassrls: true, can_assume_privileged_role: false, can_assume_forbidden_role: false }], rowCount: 1 }),
    async () => ({ rows: [{ current_user: 'creative_intelligence_runtime', session_user: 'application_login', rolsuper: false, rolbypassrls: false, session_rolsuper: false, session_rolbypassrls: false, can_assume_privileged_role: true }], rowCount: 1 }),
  ]) {
    let ended = 0
    const pool = {
      query,
      connect: async () => { throw new Error('not used') },
      end: async () => { ended += 1 },
    } as unknown as RuntimeSqlPool
    await assert.rejects(
      () => createProductionApp(parseRuntimeConfig(VALID_ENV), { createPool: () => pool }),
      { message: 'Database startup validation failed' },
    )
    assert.equal(ended, 1)
  }
})

test('liveness avoids the database while readiness uses a bounded sanitized probe', async () => {
  let healthAvailable = false
  let ended = 0
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('pg_roles')) {
        return { rows: [{ current_user: 'creative_intelligence_runtime', session_user: 'application_login', rolsuper: false, rolbypassrls: false, session_rolsuper: false, session_rolbypassrls: false, can_assume_privileged_role: false, can_assume_forbidden_role: false }], rowCount: 1 }
      }
      if (sql.includes('SELECT 1') && healthAvailable) return { rows: [{ ready: 1 }], rowCount: 1 }
      throw new Error('database private-host unavailable')
    },
    connect: async () => { throw new Error('not used') },
    end: async () => { ended += 1 },
  } as unknown as RuntimeSqlPool
  const app = await createProductionApp(parseRuntimeConfig(VALID_ENV), {
    createPool: () => pool,
    readinessCheck: async () => healthAvailable,
  })

  const live = await app.inject({ method: 'GET', url: '/health/live' })
  assert.equal(live.statusCode, 200)
  assert.deepEqual(live.json(), { status: 'ok' })

  const testHeaderFallback = await app.inject({
    method: 'POST', url: '/organizations', headers: { 'x-user-id': 'test-user' }, payload: { name: 'Team' },
  })
  assert.equal(testHeaderFallback.statusCode, 401)
  assert.deepEqual(testHeaderFallback.json(), { error: 'Authentication is required' })

  const unavailable = await app.inject({ method: 'GET', url: '/health/ready' })
  assert.equal(unavailable.statusCode, 503)
  assert.deepEqual(unavailable.json(), { status: 'not_ready' })
  assert.doesNotMatch(unavailable.body, /private-host|database/i)

  healthAvailable = true
  const ready = await app.inject({ method: 'GET', url: '/health/ready' })
  assert.equal(ready.statusCode, 200)
  assert.deepEqual(ready.json(), { status: 'ready' })

  await app.close()
  assert.equal(ended, 1)
})

test('concurrent timed-out readiness probes coalesce instead of accumulating database work', async () => {
  let readinessQueries = 0
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('pg_roles')) {
        return { rows: [{ current_user: 'creative_intelligence_runtime', session_user: 'application_login', rolsuper: false, rolbypassrls: false, session_rolsuper: false, session_rolbypassrls: false, can_assume_privileged_role: false, can_assume_forbidden_role: false }], rowCount: 1 }
      }
      readinessQueries += 1
      return await new Promise<never>(() => {})
    },
    connect: async () => { throw new Error('not used') },
    end: async () => undefined,
  } as unknown as RuntimeSqlPool
  const app = await createProductionApp(
    parseRuntimeConfig({ ...VALID_ENV, DATABASE_HEALTH_TIMEOUT_MS: '50' }),
    {
      createPool: () => pool,
      readinessCheck: async () => {
        readinessQueries += 1
        await new Promise((resolve) => setTimeout(resolve, 50))
        return false
      },
    },
  )
  const responses = await Promise.all(Array.from({ length: 10 }, async () => await app.inject({ method: 'GET', url: '/health/ready' })))
  assert.equal(readinessQueries, 1)
  assert.ok(responses.every((response) => response.statusCode === 503))
  await app.close()
})

test('standalone readiness cancels a stalled connection within its health deadline', async () => {
  let ends = 0
  let queries = 0
  const config = parseRuntimeConfig({ ...VALID_ENV, DATABASE_HEALTH_TIMEOUT_MS: '50' }).database
  const ready = await checkDatabaseReadiness(config, () => ({
    connect: async () => await new Promise<never>(() => {}),
    query: async () => { queries += 1; return { rows: [{ ready: 1 }] } },
    end: async () => { ends += 1 },
  }))
  assert.equal(ready, false)
  assert.equal(queries, 0)
  assert.equal(ends, 1)
})

test('scheduled production composition isolates pools and exposes poll failure readiness recovery', async () => {
  const config = parseRuntimeConfig({
    ...VALID_ENV,
    AD_SYNC_ENABLED: 'true', AD_SYNC_INTERVAL_MS: '100', AD_SYNC_LEASE_SECONDS: '120', AD_SYNC_MAX_ATTEMPTS: '3',
    AD_SYNC_BACKOFF_BASE_MS: '1000', AD_SYNC_BACKOFF_MAX_MS: '60000', AD_SYNC_BATCH_SIZE: '1', AD_SYNC_CONCURRENCY: '1',
    AD_SYNC_WORKER_DATABASE_URL: 'postgresql://worker:***@127.0.0.1:5432/creative_intelligence',
    AD_SYNC_WORKER_DATABASE_ROLE: 'creative_intelligence_scheduled_worker',
  })
  let pools = 0
  let closes = 0
  let polls = 0
  const app = await createProductionApp(config, {
    createPool: (database) => {
      pools += 1
      return {
        query: async (sql: string) => {
          if (sql.includes('pg_roles')) return { rows: [safeRoleRow(database.expectedRole)], rowCount: 1 }
          if (sql.includes('app_claim_due_ad_sync_runs')) { if (++polls === 1) throw new Error('private tenant detail'); return { rows: [], rowCount: 0 } }
          return { rows: [], rowCount: 0 }
        },
        connect: async () => { throw new Error('not used') },
        end: async () => { closes += 1 },
      } as unknown as RuntimeSqlPool
    },
    readinessCheck: async () => true,
  })
  assert.equal(pools, 2)
  const failed = await app.inject({ method: 'GET', url: '/health/ready' })
  assert.equal(failed.statusCode, 503)
  while (polls < 2) await new Promise((resolve) => setTimeout(resolve, 20))
  const recovered = await app.inject({ method: 'GET', url: '/health/ready' })
  assert.equal(recovered.statusCode, 200)
  await app.close()
  assert.equal(closes, 2)
})

test('scheduled production composition closes both pools when the worker login has arbitrary membership', async () => {
  const config = parseRuntimeConfig({
    ...VALID_ENV,
    AD_SYNC_ENABLED: 'true', AD_SYNC_INTERVAL_MS: '100', AD_SYNC_LEASE_SECONDS: '120', AD_SYNC_MAX_ATTEMPTS: '3',
    AD_SYNC_BACKOFF_BASE_MS: '1000', AD_SYNC_BACKOFF_MAX_MS: '60000', AD_SYNC_BATCH_SIZE: '1', AD_SYNC_CONCURRENCY: '1',
    AD_SYNC_WORKER_DATABASE_URL: 'postgresql://worker:***@127.0.0.1:5432/creative_intelligence',
    AD_SYNC_WORKER_DATABASE_ROLE: 'creative_intelligence_scheduled_worker',
  })
  let closes = 0
  await assert.rejects(() => createProductionApp(config, {
    createPool: (database) => ({
      query: async () => ({ rows: [{
        ...safeRoleRow(database.expectedRole),
        can_assume_unexpected_role: database.expectedRole === 'creative_intelligence_scheduled_worker',
      }], rowCount: 1 }),
      connect: async () => { throw new Error('not used') },
      end: async () => { closes += 1 },
    }) as unknown as RuntimeSqlPool,
  }), { message: 'Database startup validation failed' })
  assert.equal(closes, 2)
})

test('scheduled production composition reports sanitized run and poll failures externally', async () => {
  const config = parseRuntimeConfig({
    ...VALID_ENV,
    AD_SYNC_ENABLED: 'true', AD_SYNC_INTERVAL_MS: '100', AD_SYNC_LEASE_SECONDS: '120', AD_SYNC_MAX_ATTEMPTS: '3',
    AD_SYNC_BACKOFF_BASE_MS: '1000', AD_SYNC_BACKOFF_MAX_MS: '60000', AD_SYNC_BATCH_SIZE: '1', AD_SYNC_CONCURRENCY: '1',
    AD_SYNC_WORKER_DATABASE_URL: 'postgresql://worker:tenant-secret@127.0.0.1:5432/creative_intelligence',
    AD_SYNC_WORKER_DATABASE_ROLE: 'creative_intelligence_scheduled_worker',
  })
  let captured: { onRunError?: (failure: { category: 'run_failed'; at: string }) => void; onPollError?: (failure: { category: 'poll_failed' }) => void } = {}
  const reports: unknown[] = []
  const app = await createProductionApp(config, {
    createPool: (database) => ({
      query: async (sql: string) => sql.includes('pg_roles')
        ? { rows: [safeRoleRow(database.expectedRole)], rowCount: 1 }
        : { rows: [], rowCount: 0 },
      connect: async () => { throw new Error('not used') },
      end: async () => undefined,
    }) as unknown as RuntimeSqlPool,
    createScheduledWorker: (options) => {
      captured = options
      return { start: async () => undefined, stop: async () => undefined, state: () => ({ firstSuccessfulPollAt: null, lastSuccessfulPollAt: null, currentFailure: null, lastRunFailure: null }) } as never
    },
    reportScheduledWorkerError: (event) => { reports.push(event) },
  })
  assert.equal(app.log.level, 'info')
  captured.onRunError?.({ category: 'run_failed', at: '2026-01-01T00:00:00.000Z', runId: 'tenant-run-secret', error: 'database secret' } as never)
  captured.onPollError?.({ category: 'poll_failed', error: 'connection secret' } as never)
  assert.deepEqual(reports, [
    { event: 'scheduled_worker_error', category: 'run_failed' },
    { event: 'scheduled_worker_error', category: 'poll_failed' },
  ])
  assert.doesNotMatch(JSON.stringify(reports), /tenant|run-secret|database|connection|2026/)
  await app.close()
})

test('server binds configured address and graceful shutdown is idempotent', async () => {
  const calls: unknown[] = []
  let closes = 0
  const fakeApp = {
    listen: async (options: unknown) => { calls.push(options); return 'http://127.0.0.1:3000' },
    close: async () => { closes += 1 },
  } as unknown as FastifyInstance
  const config = parseRuntimeConfig(VALID_ENV)
  const server = await startProductionServer(config, { createApp: async () => fakeApp })
  assert.deepEqual(calls, [{ host: '127.0.0.1', port: 3000 }])
  await server.shutdown()
  await server.shutdown()
  assert.equal(closes, 1)
})

test('executable composition listens on a real socket and serves liveness', async () => {
  let ended = 0
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('pg_roles')) {
        return { rows: [{ current_user: 'creative_intelligence_runtime', session_user: 'application_login', rolsuper: false, rolbypassrls: false, session_rolsuper: false, session_rolbypassrls: false, can_assume_privileged_role: false, can_assume_forbidden_role: false }], rowCount: 1 }
      }
      return { rows: [{ ready: 1 }], rowCount: 1 }
    },
    connect: async () => { throw new Error('not used') },
    end: async () => { ended += 1 },
  } as unknown as RuntimeSqlPool
  const config = { ...parseRuntimeConfig(VALID_ENV), port: 0 }
  const server = await startProductionServer(config, { createPool: () => pool })
  const address = server.app.server.address()
  assert.ok(address && typeof address === 'object')
  const response = await fetch(`http://127.0.0.1:${address.port}/health/live`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: 'ok' })
  await server.shutdown()
  assert.equal(ended, 1)
})

test('server closes resources and returns one fixed error when binding fails', async () => {
  let closes = 0
  const fakeApp = {
    listen: async () => { throw new Error('listen EADDRINUSE 127.0.0.1:3000') },
    close: async () => { closes += 1 },
  } as unknown as FastifyInstance
  await assert.rejects(
    () => startProductionServer(parseRuntimeConfig(VALID_ENV), { createApp: async () => fakeApp }),
    { message: 'Server startup failed' },
  )
  assert.equal(closes, 1)
})
