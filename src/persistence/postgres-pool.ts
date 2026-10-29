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
  rolcanlogin?: boolean
  rolcreatedb?: boolean
  rolcreaterole?: boolean
  rolreplication?: boolean
  session_rolsuper: boolean
  session_rolbypassrls: boolean
  session_rolcanlogin?: boolean
  session_rolcreatedb?: boolean
  session_rolcreaterole?: boolean
  session_rolreplication?: boolean
  can_assume_privileged_role: boolean
  can_assume_forbidden_role?: boolean
  can_assume_scheduled_worker?: boolean
  can_assume_unexpected_role?: boolean
  has_unsafe_direct_acl?: boolean
  has_unsafe_owner?: boolean
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

export async function verifyScheduledWorkerDatabase(pool: RuntimeSqlPool, timeoutMs: number): Promise<void> {
  await verifyNarrowWorkerDatabase(pool, timeoutMs, 'creative_intelligence_scheduled_worker')
}

export async function verifyMediaWorkerDatabase(pool: RuntimeSqlPool, timeoutMs: number): Promise<void> {
  await verifyNarrowWorkerDatabase(pool, timeoutMs, 'creative_intelligence_media_worker')
}

export async function verifyAnalysisWorkerDatabase(pool: RuntimeSqlPool, timeoutMs: number): Promise<void> {
  await verifyNarrowWorkerDatabase(pool, timeoutMs, 'creative_intelligence_analysis_worker')
}

async function verifyNarrowWorkerDatabase(pool: RuntimeSqlPool, timeoutMs: number, expectedRole: 'creative_intelligence_scheduled_worker' | 'creative_intelligence_media_worker' | 'creative_intelligence_analysis_worker'): Promise<void> {
  const allowedWorkerFunctions = expectedRole === 'creative_intelligence_scheduled_worker'
    ? `(function_acl_owner.proname, pg_catalog.oidvectortypes(function_acl_owner.proargtypes)) IN (
         ('app_claim_due_ad_sync_runs','text, integer, integer, integer'),
         ('app_upsert_scheduled_competitor_ad','text, text, text, text, text, jsonb, text'),
         ('app_retire_scheduled_competitor_ads','text, text, text, text, text[]'),
         ('app_finish_ad_sync_run_success','text, text, text, integer, integer, integer'),
         ('app_finish_ad_sync_run_failure','text, text, text, text, integer'),
         ('app_lock_scheduled_ingestion_product','text, text, text'),
         ('app_capture_scheduled_ingestion_analytics_snapshot','text, text, text')
       )`
    : expectedRole === 'creative_intelligence_media_worker'
      ? `(function_acl_owner.proname, pg_catalog.oidvectortypes(function_acl_owner.proargtypes)) IN (
         ('app_claim_media_mirror_jobs','text, integer, integer'),
         ('app_finish_media_mirror_success','uuid, text, text, text, bigint, text'),
         ('app_finish_media_mirror_failure','uuid, text, text, text, integer, boolean'),
         ('app_enqueue_media_backfill','text, integer')
       )`
      : `(function_acl_owner.proname, pg_catalog.oidvectortypes(function_acl_owner.proargtypes)) IN (
         ('app_claim_creative_analysis_jobs','text, integer, integer'),
         ('app_begin_auto_analysis','uuid, text, text, text, text, text, text, text, text, integer, integer'),
         ('app_finish_auto_analysis_success','uuid, text, text, text, text, text, jsonb'),
         ('app_finish_auto_analysis_failure','uuid, text, text, text, text, text, text, integer, boolean')
       )`
  try {
    const result = await withTimeout(
      boundedQuery<RoleRow>(
        pool,
        `SELECT current_user,
                session_user,
                active_role.rolsuper,
                active_role.rolbypassrls,
                active_role.rolcanlogin,
                active_role.rolcreatedb,
                active_role.rolcreaterole,
                active_role.rolreplication,
                login_role.rolsuper AS session_rolsuper,
                login_role.rolbypassrls AS session_rolbypassrls,
                login_role.rolcanlogin AS session_rolcanlogin,
                login_role.rolcreatedb AS session_rolcreatedb,
                login_role.rolcreaterole AS session_rolcreaterole,
                login_role.rolreplication AS session_rolreplication,
                EXISTS (
                  SELECT 1
                    FROM pg_catalog.pg_roles AS privileged_role
                   WHERE (privileged_role.rolsuper OR privileged_role.rolbypassrls)
                     AND (
                       pg_catalog.pg_has_role(current_user, privileged_role.oid, 'MEMBER')
                       OR pg_catalog.pg_has_role(session_user, privileged_role.oid, 'MEMBER')
                     )
                ) AS can_assume_privileged_role,
                pg_catalog.pg_has_role(
                  login_role.oid,
                  scheduled_worker_role.oid,
                  'MEMBER'
                ) AS can_assume_scheduled_worker,
                EXISTS (
                  SELECT 1
                    FROM pg_catalog.pg_roles AS unexpected_role
                   WHERE unexpected_role.oid <> login_role.oid
                     AND unexpected_role.oid <> scheduled_worker_role.oid
                     AND pg_catalog.pg_has_role(login_role.oid, unexpected_role.oid, 'MEMBER')
                ) AS can_assume_unexpected_role,
                EXISTS (
                  SELECT 1
                    FROM pg_catalog.pg_database AS database_acl_owner
                    CROSS JOIN LATERAL pg_catalog.aclexplode(
                      COALESCE(database_acl_owner.datacl, pg_catalog.acldefault('d', database_acl_owner.datdba))
                    ) AS database_acl
                   WHERE database_acl_owner.datname = pg_catalog.current_database()
                     AND database_acl.grantee IN (login_role.oid, active_role.oid)
                     AND (database_acl.privilege_type <> 'CONNECT' OR database_acl.is_grantable)
                  UNION ALL
                  SELECT 1
                    FROM pg_catalog.pg_namespace AS namespace_acl_owner
                    CROSS JOIN LATERAL pg_catalog.aclexplode(
                      COALESCE(namespace_acl_owner.nspacl, pg_catalog.acldefault('n', namespace_acl_owner.nspowner))
                    ) AS namespace_acl
                   WHERE namespace_acl_owner.nspname <> 'information_schema'
                     AND namespace_acl_owner.nspname !~ '^pg_'
                     AND namespace_acl.grantee IN (login_role.oid, active_role.oid)
                     AND (namespace_acl.privilege_type <> 'USAGE' OR namespace_acl.is_grantable)
                  UNION ALL
                  SELECT 1
                    FROM pg_catalog.pg_class AS relation_acl_owner
                    JOIN pg_catalog.pg_namespace AS relation_namespace
                      ON relation_namespace.oid = relation_acl_owner.relnamespace
                    CROSS JOIN LATERAL pg_catalog.aclexplode(
                      COALESCE(
                        relation_acl_owner.relacl,
                        pg_catalog.acldefault(
                          CASE WHEN relation_acl_owner.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END,
                          relation_acl_owner.relowner
                        )
                      )
                    ) AS relation_acl
                   WHERE relation_namespace.nspname <> 'information_schema'
                     AND relation_namespace.nspname !~ '^pg_'
                     AND relation_acl_owner.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
                     AND relation_acl.grantee IN (login_role.oid, active_role.oid)
                  UNION ALL
                  SELECT 1
                    FROM pg_catalog.pg_attribute AS column_acl_owner
                    JOIN pg_catalog.pg_class AS column_relation
                      ON column_relation.oid = column_acl_owner.attrelid
                    JOIN pg_catalog.pg_namespace AS column_namespace
                      ON column_namespace.oid = column_relation.relnamespace
                    CROSS JOIN LATERAL pg_catalog.aclexplode(column_acl_owner.attacl) AS column_acl
                   WHERE column_namespace.nspname <> 'information_schema'
                     AND column_namespace.nspname !~ '^pg_'
                     AND column_relation.relkind IN ('r', 'p', 'v', 'm', 'f')
                     AND column_acl_owner.attnum > 0
                     AND NOT column_acl_owner.attisdropped
                     AND column_acl.grantee IN (login_role.oid, active_role.oid)
                  UNION ALL
                  SELECT 1
                    FROM pg_catalog.pg_proc AS function_acl_owner
                    JOIN pg_catalog.pg_namespace AS function_namespace
                      ON function_namespace.oid = function_acl_owner.pronamespace
                    CROSS JOIN LATERAL pg_catalog.aclexplode(
                      COALESCE(function_acl_owner.proacl, pg_catalog.acldefault('f', function_acl_owner.proowner))
                    ) AS function_acl
                   WHERE function_namespace.nspname <> 'information_schema'
                     AND function_namespace.nspname !~ '^pg_'
                     AND (
                       function_acl.grantee = login_role.oid
                       OR (function_acl.grantee = active_role.oid AND NOT (
                         function_acl.privilege_type = 'EXECUTE' AND NOT function_acl.is_grantable
                         AND function_namespace.nspname = 'public' AND (${allowedWorkerFunctions})
                       ))
                     )
                  UNION ALL
                  SELECT 1
                    FROM pg_catalog.pg_type AS type_acl_owner
                    JOIN pg_catalog.pg_namespace AS type_namespace
                      ON type_namespace.oid = type_acl_owner.typnamespace
                    CROSS JOIN LATERAL pg_catalog.aclexplode(
                      COALESCE(type_acl_owner.typacl, pg_catalog.acldefault('T', type_acl_owner.typowner))
                    ) AS type_acl
                   WHERE type_namespace.nspname <> 'information_schema'
                     AND type_namespace.nspname !~ '^pg_'
                     AND type_acl.grantee IN (login_role.oid, active_role.oid)
                ) AS has_unsafe_direct_acl,
                EXISTS (
                  SELECT 1
                    FROM pg_catalog.pg_database AS database_owner
                   WHERE database_owner.datname = pg_catalog.current_database()
                     AND database_owner.datdba IN (login_role.oid, active_role.oid)
                  UNION ALL
                  SELECT 1
                    FROM pg_catalog.pg_namespace AS namespace_owner
                   WHERE namespace_owner.nspname <> 'information_schema'
                     AND namespace_owner.nspname !~ '^pg_'
                     AND namespace_owner.nspowner IN (login_role.oid, active_role.oid)
                  UNION ALL
                  SELECT 1
                    FROM pg_catalog.pg_class AS relation_owner
                    JOIN pg_catalog.pg_namespace AS relation_owner_namespace
                      ON relation_owner_namespace.oid = relation_owner.relnamespace
                   WHERE relation_owner_namespace.nspname <> 'information_schema'
                     AND relation_owner_namespace.nspname !~ '^pg_'
                     AND relation_owner.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
                     AND relation_owner.relowner IN (login_role.oid, active_role.oid)
                  UNION ALL
                  SELECT 1
                    FROM pg_catalog.pg_proc AS function_owner
                    JOIN pg_catalog.pg_namespace AS function_owner_namespace
                      ON function_owner_namespace.oid = function_owner.pronamespace
                   WHERE function_owner_namespace.nspname <> 'information_schema'
                     AND function_owner_namespace.nspname !~ '^pg_'
                     AND function_owner.proowner IN (login_role.oid, active_role.oid)
                  UNION ALL
                  SELECT 1
                    FROM pg_catalog.pg_type AS type_owner
                    JOIN pg_catalog.pg_namespace AS type_owner_namespace
                      ON type_owner_namespace.oid = type_owner.typnamespace
                   WHERE type_owner_namespace.nspname <> 'information_schema'
                     AND type_owner_namespace.nspname !~ '^pg_'
                     AND type_owner.typowner IN (login_role.oid, active_role.oid)
                ) AS has_unsafe_owner
           FROM pg_catalog.pg_roles AS active_role
           JOIN pg_catalog.pg_roles AS login_role ON login_role.rolname = session_user
           JOIN pg_catalog.pg_roles AS scheduled_worker_role
             ON scheduled_worker_role.rolname = '${expectedRole}'
          WHERE active_role.rolname = current_user`,
        timeoutMs,
      ),
      timeoutMs,
    )
    const role = result.rows[0]
    if (result.rows.length !== 1 || !role || role.current_user !== expectedRole
        || typeof role.session_user !== 'string' || role.session_user.length === 0
        || role.session_user === role.current_user
        || role.rolsuper !== false || role.rolbypassrls !== false
        || role.rolcanlogin !== false || role.rolcreatedb !== false
        || role.rolcreaterole !== false || role.rolreplication !== false
        || role.session_rolsuper !== false || role.session_rolbypassrls !== false
        || role.session_rolcanlogin !== true || role.session_rolcreatedb !== false
        || role.session_rolcreaterole !== false || role.session_rolreplication !== false
        || role.can_assume_privileged_role !== false
        || role.can_assume_scheduled_worker !== true
        || role.can_assume_unexpected_role !== false
        || role.has_unsafe_direct_acl !== false
        || role.has_unsafe_owner !== false) {
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
