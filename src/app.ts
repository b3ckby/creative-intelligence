import { randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'

import { createOidcAuthenticator, type OidcAuthenticatorDependencies } from './auth/oidc-authenticator.ts'
import type { RuntimeConfig } from './config/runtime-config.ts'
import { buildApi } from './http/build-api.ts'
import { schemaFor } from './http/schemas.ts'
import { checkDatabaseReadiness, createPostgresPool, verifyRuntimeDatabase, type RuntimeSqlPool } from './persistence/postgres-pool.ts'

export interface ProductionAppDependencies extends OidcAuthenticatorDependencies {
  createPool?: (config: RuntimeConfig['database']) => RuntimeSqlPool
  createId?: () => string
  now?: () => Date
  readinessCheck?: () => Promise<boolean>
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
    const app = buildApi({
      pool,
      authenticate,
      cursorSigningKey: config.cursorSigningKey,
      createId: dependencies.createId ?? randomUUID,
      now: dependencies.now ?? (() => new Date()),
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
