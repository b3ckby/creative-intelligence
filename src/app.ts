import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import type { FastifyInstance, FastifyRequest } from 'fastify'

import { createOidcAuthenticator, type OidcAuthenticatorDependencies } from './auth/oidc-authenticator.ts'
import { StagingPasswordLogin, type StagingLoginAttemptLimiter } from './auth/staging-password-login.ts'
import type { RuntimeConfig } from './config/runtime-config.ts'
import { buildApi } from './http/build-api.ts'
import { GeminiCreativeTagger } from './creative-analysis/gemini-creative-tagger.ts'
import { schemaFor } from './http/schemas.ts'
import { checkDatabaseReadiness, createPostgresPool, verifyRuntimeDatabase, type RuntimeSqlPool } from './persistence/postgres-pool.ts'
import { PostgresStagingLoginRateLimiter } from './persistence/postgres-staging-login-rate-limiter.ts'
import { PostgresScaleAnalyticsService } from './persistence/postgres-scale-analytics-service.ts'
import { PostgresCreativeAnalysisService } from './persistence/postgres-creative-analysis-service.ts'
import { withVerifiedUserReadContext } from './persistence/verified-user-context.ts'

export interface ProductionAppDependencies extends OidcAuthenticatorDependencies {
  createPool?: (config: RuntimeConfig['database']) => RuntimeSqlPool
  createId?: () => string
  now?: () => Date
  readinessCheck?: () => Promise<boolean>
  readSecretFile?: (path: string) => Promise<string>
  createStagingLoginRateLimiter?: (pool: RuntimeSqlPool, config: { maxAttempts: number, attemptWindowMs: number }) => StagingLoginAttemptLimiter
  verifyStagingMembership?: (pool: RuntimeSqlPool, userId: string, organizationId: string) => Promise<boolean>
}

export async function createProductionApp(
  config: RuntimeConfig,
  dependencies: ProductionAppDependencies = {},
): Promise<FastifyInstance> {
  const pool = (dependencies.createPool ?? createPostgresPool)(config.database)
  try {
    await verifyRuntimeDatabase(pool, config.database.expectedRole, config.database.connectTimeoutMs)
    const oidcDependencies = Object.fromEntries(Object.entries({
      fetch: dependencies.fetch,
      now: dependencies.now,
      monotonicNow: dependencies.monotonicNow,
    }).filter(([, value]) => value !== undefined)) as OidcAuthenticatorDependencies
    const authenticate = createOidcAuthenticator(config.oidc, oidcDependencies)
    const now = dependencies.now ?? (() => new Date())
    const readSecretFile = dependencies.readSecretFile ?? (async (path: string) => await readFile(path, 'utf8'))
    let stagingLogin: StagingPasswordLogin | undefined
    let stagingOrganizationId: string | undefined
    if (config.stagingLogin) {
      stagingOrganizationId = config.stagingLogin.organizationId

      const [passwordHash, privateKeyPem] = await Promise.all([
        readSecretFile(config.stagingLogin.passwordHashFile),
        readSecretFile(config.stagingLogin.privateKeyFile),
      ])
      const rateLimiterConfig = {
        maxAttempts: config.stagingLogin.maxAttempts,
        attemptWindowMs: config.stagingLogin.attemptWindowMs,
      }
      const rateLimiter = dependencies.createStagingLoginRateLimiter
        ? dependencies.createStagingLoginRateLimiter(pool, rateLimiterConfig)
        : new PostgresStagingLoginRateLimiter(pool, rateLimiterConfig)
      stagingLogin = new StagingPasswordLogin({
        passwordHash: passwordHash.trim(),
        privateKeyPem: privateKeyPem.trim(),
        keyId: config.stagingLogin.keyId,
        issuer: config.oidc.issuer,
        audiences: config.oidc.audiences,
        subject: config.stagingLogin.subject,
        tokenTtlSeconds: config.stagingLogin.tokenTtlSeconds,
        maxAttempts: config.stagingLogin.maxAttempts,
        attemptWindowMs: config.stagingLogin.attemptWindowMs,
        maxConcurrency: config.stagingLogin.maxConcurrency,
      }, {
        ...(dependencies.now ? { now: dependencies.now } : {}),
        rateLimiter,
      })
      await rateLimiter.ready?.()
      await stagingLogin.ready()
      const probeToken = await stagingLogin.startupProbeToken()
      const stagingUserId = await authenticate({ raw: { rawHeaders: ['Authorization', `Bearer ${probeToken}`] } } as unknown as FastifyRequest)
      const verifyMembership = dependencies.verifyStagingMembership ?? hasStagingMembership
      if (!await verifyMembership(pool, stagingUserId, config.stagingLogin.organizationId)) {
        throw new Error('Staging login membership is invalid')
      }
    }
    let creativeAnalysis: PostgresCreativeAnalysisService | undefined
    if (config.creativeAnalysis) {
      const apiKey = (await readSecretFile(config.creativeAnalysis.apiKeyFile)).trim()
      const tagger = new GeminiCreativeTagger({
        apiKey,
        model: config.creativeAnalysis.model,
        timeoutMs: config.creativeAnalysis.timeoutMs,
        maxConcurrency: config.creativeAnalysis.maxConcurrency,
      }, {
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      })
      creativeAnalysis = new PostgresCreativeAnalysisService(pool, tagger, now, config.creativeAnalysis.dailyLimit)
    }
    const app = buildApi({
      pool,
      authenticate,
      trustedProxies: config.trustedProxies,
      ...(stagingLogin && stagingOrganizationId ? { stagingLogin, stagingOrganizationId } : {}),
      cursorSigningKey: config.cursorSigningKey,
      createId: dependencies.createId ?? randomUUID,
      now,
      scaleAnalytics: new PostgresScaleAnalyticsService(pool, now),
      ...(creativeAnalysis ? { creativeAnalysis } : {}),
      apify: {
        ...config.apify,
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      },
    })
    let readinessProbe: Promise<boolean> | undefined
    const checkReadiness = dependencies.readinessCheck ?? (async () => await checkDatabaseReadiness(config.database))
    const ready = (): Promise<boolean> => {
      readinessProbe ??= checkReadiness().finally(() => {
        readinessProbe = undefined
      })
      return readinessProbe
    }

    app.get('/health/live', { schema: schemaFor('getLiveness') }, async () => ({ status: 'ok' }))
    app.get('/health/ready', { schema: schemaFor('getReadiness') }, async (_request, reply) => {
      const isReady = await ready()
      return reply.code(isReady ? 200 : 503).send({ status: isReady ? 'ready' : 'not_ready' })
    })
    app.addHook('onClose', async () => {
      await pool.end()
    })
    return app
  } catch (error) {
    await pool.end().catch(() => undefined)
    throw error
  }
}

async function hasStagingMembership(pool: RuntimeSqlPool, userId: string, organizationId: string): Promise<boolean> {
  return await withVerifiedUserReadContext(pool, userId, async (connection) => {
    const result = await connection.query<{ member: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM organization_members
         WHERE organization_id = $1 AND user_id = $2
       ) AS member`,
      [organizationId, userId],
    )
    return result.rowCount === 1 && result.rows[0]?.member === true
  })
}
