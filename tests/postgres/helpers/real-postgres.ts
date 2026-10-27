import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'

import { Pool, type PoolClient } from 'pg'

const provisionerEnvironmentVariable = 'CREATIVE_INTELLIGENCE_TEST_PROVISIONER_URL'
const runtimeRole = 'creative_intelligence_runtime'
const rlsOwnerRole = 'creative_intelligence_rls_owner'
const loginLimiterOwnerRole = 'creative_intelligence_login_limiter_owner'
const artifactPrefix = 'creative_intelligence_test_'
const advisoryLockKey = 734_812_901

export interface RealPostgresContext {
  runtimePool: Pool
  inspectionPool: Pool
  databaseName: string
  runtimeLoginRole: string
  serverVersion: string
}

interface Provisioner {
  connectionString: string
  dispose(): Promise<void>
}

export interface CleanupNames {
  database: string | undefined
  loginRole: string | undefined
  runtimeRole: string
  rlsOwnerRole: string
  loginLimiterOwnerRole: string
}

export interface CleanupOwnership {
  databaseCreated?: boolean
  loginRoleCreated?: boolean
  fixedRolesOwned?: boolean
}

export function cleanupTargets(names: CleanupNames, ownership: CleanupOwnership): string[] {
  const targets: string[] = []
  if (ownership.databaseCreated && names.database) targets.push(`database:${names.database}`)
  if (ownership.loginRoleCreated && names.loginRole) targets.push(`role:${names.loginRole}`)
  if (ownership.fixedRolesOwned) targets.push(`role:${names.runtimeRole}`, `role:${names.rlsOwnerRole}`, `role:${names.loginLimiterOwnerRole}`)
  return targets
}

export async function withRealPostgres<T>(operation: (context: RealPostgresContext) => Promise<T>): Promise<T> {
  const provisioner = await resolveProvisioner()
  const adminPool = new Pool({ connectionString: provisioner.connectionString, max: 2 })
  let lockClient: PoolClient | undefined
  let databasePool: Pool | undefined
  let runtimePool: Pool | undefined
  let databaseName: string | undefined
  let runtimeLoginRole: string | undefined
  let advisoryLockHeld = false
  const ownership: CleanupOwnership = {}
  let primaryError: unknown

  try {
    lockClient = await adminPool.connect()
    await assertSafeProvisioner(lockClient)
    await assertSharedRolesAbsent(lockClient)
    await lockClient.query(`SET lock_timeout = '10s'`)
    await lockClient.query('SELECT pg_advisory_lock($1)', [advisoryLockKey])
    advisoryLockHeld = true
    await assertSharedRolesAbsent(lockClient)

    const suffix = randomBytes(8).toString('hex')
    databaseName = `${artifactPrefix}${suffix}`
    runtimeLoginRole = `${artifactPrefix}login_${suffix}`
    await lockClient.query(`CREATE DATABASE ${databaseName}`)
    ownership.databaseCreated = true

    databasePool = new Pool({ connectionString: databaseUrl(provisioner.connectionString, databaseName), max: 1 })
    for (const migration of ['001_initial.sql', '002_tenant_rls.sql', '003_provider_sync_limits.sql', '004_provider_sync_limits_rls.sql', '005_staging_login_attempts.sql', '006_ad_intelligence.sql', '007_creative_analysis.sql', '008_brief_workflow.sql']) {
      const sql = await readFile(new URL(`../../../migrations/${migration}`, import.meta.url), 'utf8')
      await databasePool.query(sql)
      if (migration === '002_tenant_rls.sql') ownership.fixedRolesOwned = true
    }
    const runtimePassword = randomBytes(24).toString('hex')
    await lockClient.query(
      `CREATE ROLE ${runtimeLoginRole} LOGIN PASSWORD '${runtimePassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
    )
    ownership.loginRoleCreated = true
    await lockClient.query(`GRANT ${runtimeRole} TO ${runtimeLoginRole}`)
    runtimePool = new Pool({
      connectionString: loginUrl(provisioner.connectionString, databaseName, runtimeLoginRole, runtimePassword),
      options: `-c role=${runtimeRole}`,
      max: 8,
    })
    const identity = await runtimePool.query<{
      current_user: string
      session_user: string
      rolsuper: boolean
      rolbypassrls: boolean
      server_version: string
    }>(`
      SELECT current_user, session_user, rolsuper, rolbypassrls,
             current_setting('server_version') AS server_version
      FROM pg_roles
      WHERE rolname = current_user
    `)
    const row = identity.rows[0]
    if (!row || row.current_user !== runtimeRole || row.session_user !== runtimeLoginRole || row.rolsuper || row.rolbypassrls) {
      throw new Error('Integration connections did not assume the restricted runtime role')
    }

    return await operation({
      runtimePool,
      inspectionPool: databasePool,
      databaseName,
      runtimeLoginRole,
      serverVersion: row.server_version,
    })
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    const cleanupErrors: unknown[] = []
    const cleanup = async (action: () => Promise<unknown>): Promise<void> => {
      try {
        await action()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (runtimePool) {
      const pool = runtimePool
      await cleanup(() => pool.end())
    }
    if (databasePool) {
      const pool = databasePool
      await cleanup(() => pool.end())
    }
    if (lockClient) {
      const targets = cleanupTargets({
        database: databaseName,
        loginRole: runtimeLoginRole,
        runtimeRole,
        rlsOwnerRole,
        loginLimiterOwnerRole,
      }, ownership)
      if (databaseName && targets.includes(`database:${databaseName}`)) {
        await cleanup(() => lockClient!.query(`DROP DATABASE IF EXISTS ${databaseName}`))
      }
      if (runtimeLoginRole && targets.includes(`role:${runtimeLoginRole}`)) {
        await cleanup(() => lockClient!.query(`DROP ROLE IF EXISTS ${runtimeLoginRole}`))
      }
      if (targets.includes(`role:${runtimeRole}`)) await cleanup(() => lockClient!.query(`DROP ROLE IF EXISTS ${runtimeRole}`))
      if (targets.includes(`role:${rlsOwnerRole}`)) await cleanup(() => lockClient!.query(`DROP ROLE IF EXISTS ${rlsOwnerRole}`))
      if (targets.includes(`role:${loginLimiterOwnerRole}`)) await cleanup(() => lockClient!.query(`DROP ROLE IF EXISTS ${loginLimiterOwnerRole}`))
      if (advisoryLockHeld) await cleanup(() => lockClient!.query('SELECT pg_advisory_unlock($1)', [advisoryLockKey]))
      lockClient.release()
    }
    await cleanup(() => adminPool.end())
    await cleanup(() => provisioner.dispose())
    if (cleanupErrors.length) {
      const errors = primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors]
      throw new AggregateError(errors, 'Real PostgreSQL integration cleanup failed')
    }
  }
}

async function resolveProvisioner(): Promise<Provisioner> {
  const configured = process.env[provisionerEnvironmentVariable]
  if (configured) {
    validateLocalProvisionerUrl(configured)
    return { connectionString: configured, async dispose() {} }
  }
  return detectRootLocalPostgres()
}

export function validateLocalProvisionerUrl(connectionString: string): void {
  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    throw new Error(`${provisionerEnvironmentVariable} must be a PostgreSQL URL`)
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${provisionerEnvironmentVariable} must use postgres:// or postgresql://`)
  }

  const host = url.hostname.toLowerCase()
  const hostValues = url.searchParams.getAll('host')
  const queryHost = hostValues[0]
  const queryKeys = [...url.searchParams.keys()]
  const isSocketQuery = host === '' && queryKeys.length === 1 && hostValues.length === 1
  if (queryKeys.length > 0 && !isSocketQuery) {
    throw new Error('Provisioner URL must not contain a routing override')
  }

  const isNumericLoopback = host === '127.0.0.1' || host === '[::1]' || host === '::1'
  const isLocalSocket = isSocketQuery && queryHost !== undefined && queryHost.startsWith('/')
  if (!isNumericLoopback && !isLocalSocket) {
    throw new Error('Provisioner URL must use a numeric loopback address or local Unix socket')
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, '') || 'postgres')
  if (database !== 'postgres') throw new Error('Provisioner URL must target the local postgres maintenance database')
}

async function assertSafeProvisioner(client: PoolClient): Promise<void> {
  const result = await client.query<{
    database: string
    server_address: string | null
    is_superuser: string
    can_create_database: boolean
    can_create_role: boolean
  }>(`
    SELECT current_database() AS database,
           host(inet_server_addr()) AS server_address,
           current_setting('is_superuser') AS is_superuser,
           rolcreatedb AS can_create_database,
           rolcreaterole AS can_create_role
    FROM pg_roles WHERE rolname = current_user
  `)
  const row = result.rows[0]
  if (!row || row.database !== 'postgres') throw new Error('Provisioner must connect to the postgres maintenance database')
  if (row.server_address && !['127.0.0.1', '::1'].includes(row.server_address)) {
    throw new Error('Refusing PostgreSQL server that is not bound to a loopback address')
  }
  if (row.is_superuser !== 'on') {
    throw new Error('Provisioner must be a local superuser so the migration can create its BYPASSRLS helper role')
  }
}

async function assertSharedRolesAbsent(client: PoolClient): Promise<void> {
  const result = await client.query<{ rolname: string }>(
    'SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname',
    [[runtimeRole, rlsOwnerRole, loginLimiterOwnerRole]],
  )
  if (result.rowCount) {
    throw new Error(`Refusing cluster with existing application roles: ${result.rows.map(({ rolname }) => rolname).join(', ')}`)
  }
}

async function detectRootLocalPostgres(): Promise<Provisioner> {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    throw new Error(`Set ${provisionerEnvironmentVariable} to an explicitly local PostgreSQL provisioner URL`)
  }
  const probe = await runPsql(`
    SELECT current_database(), current_user, host(inet_server_addr()),
           current_setting('port'), current_setting('listen_addresses');
  `)
  const [database, user, address = '', port, listenAddresses] = probe.trim().split('|')
  if (database !== 'postgres' || user !== 'postgres' || (address && !['127.0.0.1', '::1'].includes(address))) {
    throw new Error('Local PostgreSQL auto-detection failed its safety checks')
  }
  if (!port || !/^\d+$/.test(port) || !listenAddresses?.split(',').map((value) => value.trim()).some((value) => ['localhost', '127.0.0.1', '::1'].includes(value))) {
    throw new Error('Local PostgreSQL auto-detection requires a loopback TCP listener')
  }

  const suffix = randomBytes(8).toString('hex')
  const role = `${artifactPrefix}provisioner_${suffix}`
  const password = randomBytes(24).toString('hex')
  await runPsql(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' SUPERUSER;`)
  const connectionString = buildLoopbackProvisionerUrl(role, password, port)
  return {
    connectionString,
    async dispose() {
      await runPsql(`DROP ROLE IF EXISTS ${role};`)
    },
  }
}

export function buildLoopbackProvisionerUrl(role: string, password: string, port: string): string {
  const url = new URL('postgresql://127.0.0.1/postgres')
  url.username = role
  url.password = password
  url.port = port
  return url.toString()
}

function runPsql(sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('runuser', ['-u', 'postgres', '--', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-d', 'postgres'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`Local PostgreSQL provisioner failed: ${stderr.trim()}`))
    })
    child.stdin.end(sql)
  })
}

function databaseUrl(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString)
  url.pathname = `/${databaseName}`
  return url.toString()
}

function loginUrl(connectionString: string, databaseName: string, username: string, password: string): string {
  const url = new URL(databaseUrl(connectionString, databaseName))
  url.username = username
  url.password = password
  return url.toString()
}
