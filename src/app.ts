import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { ApifyMetaAdsProvider, ApifyRequestGate } from './ad-ingestion/apify-meta-ads-provider.ts'

import type { FastifyInstance, FastifyRequest } from 'fastify'

import { createOidcAuthenticator, type OidcAuthenticatorDependencies } from './auth/oidc-authenticator.ts'
import { StagingPasswordLogin, type StagingLoginAttemptLimiter } from './auth/staging-password-login.ts'
import { AuthorizationError } from './domain/errors.ts'
import type { RuntimeConfig } from './config/runtime-config.ts'
import { buildApi } from './http/build-api.ts'
import { GeminiCreativeTagger } from './creative-analysis/gemini-creative-tagger.ts'
import { schemaFor } from './http/schemas.ts'
import { checkDatabaseReadiness, createPostgresPool, verifyAnalysisWorkerDatabase, verifyRuntimeDatabase, verifyScheduledWorkerDatabase, type RuntimeSqlPool } from './persistence/postgres-pool.ts'
import { PostgresStagingLoginRateLimiter } from './persistence/postgres-staging-login-rate-limiter.ts'
import { PostgresScaleAnalyticsService } from './persistence/postgres-scale-analytics-service.ts'
import { PostgresCompetitorAnalyticsService } from './persistence/postgres-competitor-analytics-service.ts'
import { PostgresCreativeAnalysisService } from './persistence/postgres-creative-analysis-service.ts'
import { PostgresCreativeStrategyService } from './persistence/postgres-creative-strategy-service.ts'
import { PostgresProviderAdImportService } from './persistence/postgres-provider-ad-import-service.ts'
import { PostgresScheduledAdSyncService, type ClaimedAdSyncRun } from './persistence/postgres-scheduled-ad-sync-service.ts'
import { ScheduledProviderSyncWorker } from './scheduling/scheduled-provider-sync-worker.ts'
import { withVerifiedUserReadContext } from './persistence/verified-user-context.ts'
import { LocalContentAddressedMediaStore } from './media/content-addressed-store.ts'
import { SafeMediaFetcher } from './media/safe-media-fetcher.ts'
import { PostgresMediaMirrorService, type ClaimedMediaMirrorJob } from './media/postgres-media-mirror-service.ts'
import { verifyMediaWorkerDatabase } from './persistence/postgres-pool.ts'
import { PostgresAutoAnalysisService, type ClaimedCreativeAnalysisJob } from './creative-analysis/postgres-auto-analysis-service.ts'

export interface ProductionAppDependencies extends OidcAuthenticatorDependencies {
  createPool?: (config: RuntimeConfig['database']) => RuntimeSqlPool
  createId?: () => string
  now?: () => Date
  readinessCheck?: () => Promise<boolean>
  readSecretFile?: (path: string) => Promise<string>
  createStagingLoginRateLimiter?: (pool: RuntimeSqlPool, config: { maxAttempts: number, attemptWindowMs: number }) => StagingLoginAttemptLimiter
  verifyStagingMembership?: (pool: RuntimeSqlPool, userId: string, organizationId: string) => Promise<boolean>
  createScheduledWorker?: (options: ConstructorParameters<typeof ScheduledProviderSyncWorker<ClaimedAdSyncRun>>[0]) => ScheduledProviderSyncWorker<ClaimedAdSyncRun>
  reportScheduledWorkerError?: (event: { event: 'scheduled_worker_error'; category: 'poll_failed' | 'run_failed' }) => void
}

export async function createProductionApp(
  config: RuntimeConfig,
  dependencies: ProductionAppDependencies = {},
): Promise<FastifyInstance> {
  const pool = (dependencies.createPool ?? createPostgresPool)(config.database)
  let workerPool: RuntimeSqlPool | undefined
  let mediaWorkerPool: RuntimeSqlPool | undefined
  let analysisWorkerPool: RuntimeSqlPool | undefined
  try {
    await verifyRuntimeDatabase(pool, config.database.expectedRole, config.database.connectTimeoutMs)
    const oidcDependencies = Object.fromEntries(Object.entries({
      fetch: dependencies.fetch,
      now: dependencies.now,
      monotonicNow: dependencies.monotonicNow,
    }).filter(([, value]) => value !== undefined)) as OidcAuthenticatorDependencies
    const authenticate = createOidcAuthenticator(config.oidc, oidcDependencies)
    const now = dependencies.now ?? (() => new Date())
    const createId = dependencies.createId ?? randomUUID
    const readSecretFile = dependencies.readSecretFile ?? (async (path: string) => await readFile(path, 'utf8'))
    const mediaStore = config.mediaMirror ? new LocalContentAddressedMediaStore(config.mediaMirror.storageRoot) : undefined
    await mediaStore?.ready()
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
    let creativeTagger: GeminiCreativeTagger | undefined
    if (config.creativeAnalysis) {
      const apiKey = (await readSecretFile(config.creativeAnalysis.apiKeyFile)).trim()
      creativeTagger = new GeminiCreativeTagger({
        apiKey,
        model: config.creativeAnalysis.model,
        timeoutMs: config.creativeAnalysis.timeoutMs,
        maxConcurrency: config.creativeAnalysis.maxConcurrency,
        maxMediaCount: config.creativeAnalysis.maxMediaCount,
        maxMediaBytes: config.creativeAnalysis.maxMediaBytes,
      }, {
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      })
      creativeAnalysis = new PostgresCreativeAnalysisService(pool, creativeTagger, now, config.creativeAnalysis.dailyLimit, mediaStore)
    }
    const apifyGate = new ApifyRequestGate(config.apify.maxConcurrency)
    const app = buildApi({
      pool,
      authenticate,
      trustedProxies: config.trustedProxies,
      logger: true,
      ...(stagingLogin && stagingOrganizationId ? { stagingLogin, stagingOrganizationId } : {}),
      cursorSigningKey: config.cursorSigningKey,
      createId,
      now,
      scaleAnalytics: new PostgresScaleAnalyticsService(pool, now),
      competitorAnalytics: new PostgresCompetitorAnalyticsService(pool),
      creativeStrategy: new PostgresCreativeStrategyService(pool),
      ...(creativeAnalysis ? { creativeAnalysis } : {}),
      apify: {
        ...config.apify,
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      },
      apifyGate,
      mediaMirrors: config.mediaMirror !== undefined,
      adLibraryDiscovery: true,
    })
    let scheduledWorker: ScheduledProviderSyncWorker<ClaimedAdSyncRun> | undefined
    if (config.scheduledSync) {
      const settings = config.scheduledSync
      workerPool = (dependencies.createPool ?? createPostgresPool)({
        ...config.database, url: settings.workerDatabase.url, expectedRole: settings.workerDatabase.expectedRole,
      })
      await verifyScheduledWorkerDatabase(workerPool, config.database.connectTimeoutMs)
      const imports = new PostgresProviderAdImportService(workerPool, createId, now)
      const scheduled = new PostgresScheduledAdSyncService(
        workerPool, imports, randomUUID(), settings,
        async (run) => {
          const pageUrl = await withVerifiedUserReadContext(pool, run.actor_user_id, async (connection) => {
            const result = await connection.query<{ meta_page_url: string | null }>(
              `SELECT c.meta_page_url FROM competitors c
               JOIN products p ON p.organization_id=c.organization_id AND p.id=c.product_id
               WHERE c.organization_id=$1 AND c.product_id=$2 AND c.id=$3
                 AND c.archived_at IS NULL AND p.archived_at IS NULL`,
              [run.organization_id, run.product_id, run.competitor_id],
            )
            return result.rows[0]?.meta_page_url
          })
          if (!pageUrl) throw new AuthorizationError('Scheduled competitor or actor is unavailable')
          return new ApifyMetaAdsProvider({ ...config.apify, facebookPageUrl: pageUrl }, {
            ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
            gate: apifyGate,
          })
        },
      )
      const reportScheduledWorkerError = dependencies.reportScheduledWorkerError
        ?? ((event: { event: 'scheduled_worker_error'; category: 'poll_failed' | 'run_failed' }) => { app.log.error(event) })
      const options = {
        intervalMs: settings.intervalMs,
        concurrency: settings.concurrency,
        batchSize: settings.batchSize,
        poll: async (batchSize: number) => await scheduled.claim(batchSize),
        run: async (run: ClaimedAdSyncRun) => await scheduled.run(run),
        onPollError: () => { reportScheduledWorkerError({ event: 'scheduled_worker_error', category: 'poll_failed' }) },
        onRunError: () => { reportScheduledWorkerError({ event: 'scheduled_worker_error', category: 'run_failed' }) },
      }
      scheduledWorker = dependencies.createScheduledWorker
        ? dependencies.createScheduledWorker(options)
        : new ScheduledProviderSyncWorker(options)
      app.addHook('onReady', async () => { void scheduledWorker?.start() })
    }
    let mediaWorker: ScheduledProviderSyncWorker<ClaimedMediaMirrorJob> | undefined
    if (config.mediaMirror) {
      const settings = config.mediaMirror
      const store = mediaStore!
      mediaWorkerPool = (dependencies.createPool ?? createPostgresPool)({
        ...config.database, url: settings.workerDatabase.url, expectedRole: settings.workerDatabase.expectedRole,
      })
      await verifyMediaWorkerDatabase(mediaWorkerPool, config.database.connectTimeoutMs)
      const media = new PostgresMediaMirrorService(mediaWorkerPool, randomUUID(), settings, {
        fetcher: new SafeMediaFetcher(undefined, { maxRedirects: settings.maxRedirects, maxBytes: settings.maxBytes, timeoutMs: settings.fetchTimeoutMs }),
        store,
      })
      let backfillComplete = false
      mediaWorker = new ScheduledProviderSyncWorker({
        intervalMs: settings.intervalMs,
        concurrency: settings.concurrency,
        batchSize: settings.batchSize,
        poll: async () => {
          if (!backfillComplete) {
            const page = await media.backfill()
            backfillComplete = page.nextCursor === null
          }
          return await media.claim()
        },
        run: async (job) => await media.run(job),
        onPollError: () => { app.log.error({ event: 'media_worker_error', category: 'poll_failed' }) },
        onRunError: () => { app.log.error({ event: 'media_worker_error', category: 'run_failed' }) },
      })
      app.get('/media/sha256/:checksum', {
        schema: { security: [], params: { type: 'object', additionalProperties: false, required: ['checksum'], properties: { checksum: { type: 'string', pattern: '^[a-f0-9]{64}$' } } } },
      }, async (request, reply) => {
        try {
          const mediaObject = await store.read((request.params as { checksum: string }).checksum)
          return reply.headers({
            'content-type': mediaObject.mediaType, 'content-length': String(mediaObject.byteSize),
            'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; sandbox",
          }).send(mediaObject.bytes)
        } catch {
          return reply.code(404).send({ error: 'Not found' })
        }
      })
      app.addHook('onReady', async () => { void mediaWorker?.start() })
    }
    let analysisWorker: ScheduledProviderSyncWorker<ClaimedCreativeAnalysisJob> | undefined
    if (config.creativeAnalysis?.autoTagging && creativeTagger && mediaStore) {
      const settings = config.creativeAnalysis.autoTagging
      analysisWorkerPool = (dependencies.createPool ?? createPostgresPool)({
        ...config.database, url: settings.workerDatabase.url, expectedRole: settings.workerDatabase.expectedRole,
      })
      await verifyAnalysisWorkerDatabase(analysisWorkerPool, config.database.connectTimeoutMs)
      const automatic = new PostgresAutoAnalysisService(analysisWorkerPool, mediaStore, creativeTagger, randomUUID(), {
        ...settings, dailyLimit: config.creativeAnalysis.dailyLimit,
        maxMediaCount: config.creativeAnalysis.maxMediaCount, maxMediaBytes: config.creativeAnalysis.maxMediaBytes,
      })
      analysisWorker = new ScheduledProviderSyncWorker({
        intervalMs: settings.intervalMs, concurrency: settings.concurrency, batchSize: settings.batchSize,
        poll: async () => await automatic.claim(), run: async (job) => await automatic.run(job),
        onPollError: () => { app.log.error({ event: 'analysis_worker_error', category: 'poll_failed' }) },
        onRunError: () => { app.log.error({ event: 'analysis_worker_error', category: 'run_failed' }) },
      })
      app.addHook('onReady', async () => { void analysisWorker?.start() })
    }
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
      const workerStates = [scheduledWorker?.state(), mediaWorker?.state(), analysisWorker?.state()].filter((state) => state !== undefined)
      const workerReady = workerStates.every((state) => state.firstSuccessfulPollAt !== null && state.currentFailure === null)
      const isReady = workerReady && await ready()
      return reply.code(isReady ? 200 : 503).send({ status: isReady ? 'ready' : 'not_ready' })
    })
    app.addHook('onClose', async () => {
      await scheduledWorker?.stop()
      await mediaWorker?.stop()
      await analysisWorker?.stop()
      await Promise.all([pool.end(), workerPool?.end(), mediaWorkerPool?.end(), analysisWorkerPool?.end()])
    })
    return app
  } catch (error) {
    await Promise.all([pool.end().catch(() => undefined), workerPool?.end().catch(() => undefined), mediaWorkerPool?.end().catch(() => undefined), analysisWorkerPool?.end().catch(() => undefined)])
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
