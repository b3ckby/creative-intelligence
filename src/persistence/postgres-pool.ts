import { Client, Pool, type PoolClient } from 'pg'

import type { RuntimeConfig } from '../config/runtime-config.ts'
import type { SqlPool } from './postgres-organization-repository.ts'

export interface RuntimeSqlPool extends SqlPool {
  end(): Promise<void>
  queryWithTimeout?<Row extends Record<string, unknown>>(
    text: string,
    timeoutMs: number,
  ): Promise<{ rows: Row[], rowCount: number | null }>
}

interface RoleRow extends Record<string, unknown> {
  current_user: string
  session_user: string
  rolsuper: boolean
  rolbypassrls: boolean
  session_rolsuper: boolean
  session_rolbypassrls: boolean
  can_assume_privileged_role: boolean
}

export function createPostgresPool(config: RuntimeConfig['database']): RuntimeSqlPool {
  const pool = new Pool({
    connectionString: config.url,
    max: config.poolMax,
    connectionTimeoutMillis: config.connectTimeoutMs,
    query_timeout: config.connectTimeoutMs,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: false,
  })
  const runtimePool = pool as unknown as RuntimeSqlPool
  runtimePool.queryWithTimeout = async <Row extends Record<string, unknown>>(text: string, timeoutMs: number) => {
    let client: PoolClient | undefined
    let destroyed = false
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const operation = async (): Promise<{ rows: Row[], rowCount: number | null }> => {
      const acquired = await pool.connect()
      if (timedOut) {
        acquired.release(new Error('Database operation timed out'))
        throw new Error('Database operation timed out')
      }
      client = acquired
      try {
        await client.query('BEGIN')
        await client.query(`SELECT pg_catalog.set_config('statement_timeout', $1, true)`, [`${timeoutMs}ms`])
        const result = await client.query<Row>(text)
        await client.query('COMMIT')
        return { rows: result.rows, rowCount: result.rowCount }
      } catch (error) {
        if (!destroyed) await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        if (!destroyed) client.release()
        client = undefined
      }
    }
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        if (client && !destroyed) {
          destroyed = true
          client.release(new Error('Database operation timed out'))
          client = undefined
        }
        reject(new Error('Database operation timed out'))
      }, timeoutMs)
    })
    try {
      return await Promise.race([operation(), timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  return runtimePool
}

export async function verifyRuntimeDatabase(
  pool: RuntimeSqlPool,
  expectedRole: string,
  timeoutMs: number,
): Promise<void> {
  try {
    const result = await withTimeout(
      boundedQuery<RoleRow>(
        pool,
        `SELECT current_user,
                session_user,
                active_role.rolsuper,
                active_role.rolbypassrls,
                login_role.rolsuper AS session_rolsuper,
                login_role.rolbypassrls AS session_rolbypassrls,
                EXISTS (
                  SELECT 1
                    FROM pg_catalog.pg_roles AS privileged_role
                   WHERE (privileged_role.rolsuper OR privileged_role.rolbypassrls)
                     AND (
                       pg_catalog.pg_has_role(current_user, privileged_role.oid, 'MEMBER')
                       OR pg_catalog.pg_has_role(session_user, privileged_role.oid, 'MEMBER')
                     )
                ) AS can_assume_privileged_role
           FROM pg_catalog.pg_roles AS active_role
           JOIN pg_catalog.pg_roles AS login_role ON login_role.rolname = session_user
          WHERE active_role.rolname = current_user`,
        timeoutMs,
      ),
      timeoutMs,
    )
    const role = result.rows[0]
    if (result.rows.length !== 1 || !role || role.current_user !== expectedRole
        || typeof role.session_user !== 'string' || role.session_user.length === 0
        || role.rolsuper !== false || role.rolbypassrls !== false
        || role.session_rolsuper !== false || role.session_rolbypassrls !== false
        || role.can_assume_privileged_role !== false) {
      throw new Error('unsafe database role')
    }
  } catch {
    throw new Error('Database startup validation failed')
  }
}

export interface ReadinessClient {
  connect(): Promise<unknown>
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>
  end(): Promise<void>
}

export async function checkDatabaseReadiness(
  config: RuntimeConfig['database'],
  createClient: (config: RuntimeConfig['database']) => ReadinessClient = (database) => new Client({
    connectionString: database.url,
    connectionTimeoutMillis: database.healthTimeoutMs,
    statement_timeout: database.healthTimeoutMs,
    query_timeout: database.healthTimeoutMs,
    application_name: 'creative-intelligence-readiness',
  }),
): Promise<boolean> {
  const client = createClient(config)
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= client.end().catch(() => undefined)
    return closing
  }
  const operation = async (): Promise<boolean> => {
    try {
      await client.connect()
      if (timedOut) return false
      const result = await client.query('SELECT 1 AS ready')
      return result.rows.length === 1 && result.rows[0]?.ready === 1
    } finally {
      if (timedOut) void close()
      else await close()
    }
  }
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      void close()
      resolve(false)
    }, config.healthTimeoutMs)
  })
  try {
    return await Promise.race([operation().catch(() => false), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function probeDatabase(pool: RuntimeSqlPool, timeoutMs: number): Promise<boolean> {
  try {
    const result = await withTimeout(boundedQuery<{ ready: number }>(pool, 'SELECT 1 AS ready', timeoutMs), timeoutMs)
    return result.rows.length === 1 && result.rows[0]?.ready === 1
  } catch {
    return false
  }
}

function boundedQuery<Row extends Record<string, unknown>>(
  pool: RuntimeSqlPool,
  text: string,
  timeoutMs: number,
): Promise<{ rows: Row[], rowCount: number | null }> {
  return pool.queryWithTimeout?.<Row>(text, timeoutMs) ?? pool.query<Row>(text)
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Database operation timed out')), timeoutMs)
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
