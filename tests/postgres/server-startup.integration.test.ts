import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'

import { probeDatabase, verifyMediaWorkerDatabase, verifyRuntimeDatabase, verifyScheduledWorkerDatabase, type RuntimeSqlPool } from '../../src/persistence/postgres-pool.ts'
import { withRealPostgres } from './helpers/real-postgres.ts'

test('production startup validation accepts only the restricted real PostgreSQL runtime role', async () => {
  await withRealPostgres(async ({ runtimePool, inspectionPool, runtimeLoginRole }) => {
    const pool = runtimePool as unknown as RuntimeSqlPool
    await verifyRuntimeDatabase(pool, 'creative_intelligence_runtime', 2_000)
    assert.equal(await probeDatabase(pool, 500), true)
    await assert.rejects(
      () => verifyRuntimeDatabase(pool, 'wrong_runtime_role', 2_000),
      { message: 'Database startup validation failed' },
    )

    await inspectionPool.query(`GRANT creative_intelligence_rls_owner TO ${runtimeLoginRole}`)
    await assert.rejects(
      () => verifyRuntimeDatabase(pool, 'creative_intelligence_runtime', 2_000),
      { message: 'Database startup validation failed' },
    )
  })
})

test('media worker startup rejects direct privileges granted to its active role', async () => {
  await withRealPostgres(async ({ mediaWorkerPool, inspectionPool }) => {
    await verifyMediaWorkerDatabase(mediaWorkerPool as unknown as RuntimeSqlPool, 2_000)
    await inspectionPool.query(`GRANT INSERT ON organizations TO creative_intelligence_media_worker`)
    try {
      await assert.rejects(
        () => verifyMediaWorkerDatabase(mediaWorkerPool as unknown as RuntimeSqlPool, 2_000),
        { message: 'Database startup validation failed' },
      )
    } finally {
      await inspectionPool.query(`REVOKE INSERT ON organizations FROM creative_intelligence_media_worker`)
    }
  })
})

test('scheduled worker startup rejects a login that can assume the runtime role', async () => {
  await withRealPostgres(async ({ workerPool, inspectionPool }) => {
    await verifyScheduledWorkerDatabase(workerPool as unknown as RuntimeSqlPool, 2_000)
    const identity = await workerPool.query<{ session_user: string }>('SELECT session_user')
    const workerLogin = identity.rows[0]!.session_user
    await inspectionPool.query(`GRANT creative_intelligence_runtime TO ${workerLogin}`)
    await assert.rejects(
      () => verifyScheduledWorkerDatabase(workerPool as unknown as RuntimeSqlPool, 2_000),
      { message: 'Database startup validation failed' },
    )
  })
})

test('scheduled worker startup rejects arbitrary transitive writer-role membership', async () => {
  await withRealPostgres(async ({ workerPool, inspectionPool }) => {
    const identity = await workerPool.query<{ session_user: string }>('SELECT session_user')
    const workerLogin = identity.rows[0]!.session_user
    const writerRole = `ci_writer_${randomBytes(8).toString('hex')}`
    try {
      await inspectionPool.query(`CREATE ROLE ${writerRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`)
      await inspectionPool.query(`GRANT INSERT ON organizations TO ${writerRole}`)
      await inspectionPool.query(`GRANT ${writerRole} TO ${workerLogin}`)

      await assert.rejects(
        () => verifyScheduledWorkerDatabase(workerPool as unknown as RuntimeSqlPool, 2_000),
        { message: 'Database startup validation failed' },
      )
    } finally {
      await inspectionPool.query(`REVOKE ${writerRole} FROM ${workerLogin}`)
      await inspectionPool.query(`REVOKE ALL ON organizations FROM ${writerRole}`)
      await inspectionPool.query(`DROP ROLE ${writerRole}`)
    }
  })
})

test('scheduled worker startup rejects direct login ACLs on application objects', async () => {
  await withRealPostgres(async ({ workerPool, inspectionPool, databaseName }) => {
    const identity = await workerPool.query<{ session_user: string }>('SELECT session_user')
    const workerLogin = identity.rows[0]!.session_user
    await inspectionPool.query('CREATE SEQUENCE ci_acl_test_sequence')
    await inspectionPool.query('CREATE VIEW ci_acl_test_view AS SELECT id FROM organizations')
    await inspectionPool.query(`CREATE TYPE ci_acl_test_type AS ENUM ('one')`)
    const cases = [
      {
        name: 'database',
        grant: `GRANT CREATE ON DATABASE ${databaseName} TO ${workerLogin}`,
        revoke: `REVOKE CREATE ON DATABASE ${databaseName} FROM ${workerLogin}`,
      },
      {
        name: 'schema',
        grant: `GRANT CREATE ON SCHEMA public TO ${workerLogin}`,
        revoke: `REVOKE CREATE ON SCHEMA public FROM ${workerLogin}`,
      },
      {
        name: 'table',
        grant: `GRANT INSERT ON organizations TO ${workerLogin}`,
        revoke: `REVOKE INSERT ON organizations FROM ${workerLogin}`,
      },
      {
        name: 'table column',
        grant: `GRANT UPDATE (name) ON organizations TO ${workerLogin}`,
        revoke: `REVOKE UPDATE (name) ON organizations FROM ${workerLogin}`,
      },
      {
        name: 'view',
        grant: `GRANT SELECT ON ci_acl_test_view TO ${workerLogin}`,
        revoke: `REVOKE SELECT ON ci_acl_test_view FROM ${workerLogin}`,
      },
      {
        name: 'sequence',
        grant: `GRANT USAGE ON SEQUENCE ci_acl_test_sequence TO ${workerLogin}`,
        revoke: `REVOKE USAGE ON SEQUENCE ci_acl_test_sequence FROM ${workerLogin}`,
      },
      {
        name: 'function',
        grant: `GRANT EXECUTE ON FUNCTION app_claim_due_ad_sync_runs(text,integer,integer,integer) TO ${workerLogin}`,
        revoke: `REVOKE EXECUTE ON FUNCTION app_claim_due_ad_sync_runs(text,integer,integer,integer) FROM ${workerLogin}`,
      },
      {
        name: 'type',
        grant: `GRANT USAGE ON TYPE ci_acl_test_type TO ${workerLogin}`,
        revoke: `REVOKE USAGE ON TYPE ci_acl_test_type FROM ${workerLogin}`,
      },
    ]
    const acceptedDirectGrants: string[] = []
    for (const testCase of cases) {
      await inspectionPool.query(testCase.grant)
      try {
        await verifyScheduledWorkerDatabase(workerPool as unknown as RuntimeSqlPool, 2_000)
        acceptedDirectGrants.push(testCase.name)
      } catch (error) {
        assert.match(String(error), /Database startup validation failed/u)
      } finally {
        await inspectionPool.query(testCase.revoke)
      }
    }
    assert.deepEqual(acceptedDirectGrants, [])

    await inspectionPool.query(`GRANT CONNECT ON DATABASE ${databaseName} TO ${workerLogin}`)
    await inspectionPool.query(`GRANT USAGE ON SCHEMA public TO ${workerLogin}`)
    await verifyScheduledWorkerDatabase(workerPool as unknown as RuntimeSqlPool, 2_000)
    await inspectionPool.query(`REVOKE CONNECT ON DATABASE ${databaseName} FROM ${workerLogin}`)
    await inspectionPool.query(`REVOKE USAGE ON SCHEMA public FROM ${workerLogin}`)
  })
})

test('scheduled worker startup rejects ownership even when the owner is absent from explicit ACLs', async (t) => {
  await withRealPostgres(async ({ workerPool, inspectionPool, databaseName }) => {
    const identity = await workerPool.query<{ session_user: string }>('SELECT session_user')
    const workerLogin = identity.rows[0]!.session_user
    const originalDatabaseOwner = await inspectionPool.query<{ owner: string }>(
      `SELECT pg_catalog.pg_get_userbyid(datdba) AS owner FROM pg_catalog.pg_database WHERE datname = current_database()`,
    )
    const assertRejected = async (): Promise<void> => {
      await assert.rejects(
        () => verifyScheduledWorkerDatabase(workerPool as unknown as RuntimeSqlPool, 2_000),
        { message: 'Database startup validation failed' },
      )
    }
    const assertOwnerAbsentFromAcl = async (sql: string): Promise<void> => {
      const result = await inspectionPool.query<{ owner_in_acl: boolean }>(sql, [workerLogin])
      assert.equal(result.rows[0]?.owner_in_acl, false)
    }

    await t.test('current database owner', async () => {
      try {
        await inspectionPool.query(`ALTER DATABASE ${databaseName} OWNER TO ${workerLogin}`)
        await inspectionPool.query(`REVOKE ALL ON DATABASE ${databaseName} FROM ${workerLogin}`)
        await inspectionPool.query(`REVOKE TEMPORARY ON DATABASE ${databaseName} FROM PUBLIC`)
        await assertOwnerAbsentFromAcl(`
          SELECT EXISTS (
            SELECT 1 FROM pg_catalog.pg_database AS d
            CROSS JOIN LATERAL pg_catalog.aclexplode(d.datacl) AS acl
            WHERE d.datname = current_database() AND acl.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
          ) AS owner_in_acl
        `)
        await assertRejected()
      } finally {
        await inspectionPool.query(`ALTER DATABASE ${databaseName} OWNER TO ${originalDatabaseOwner.rows[0]!.owner}`)
        await inspectionPool.query(`GRANT TEMPORARY ON DATABASE ${databaseName} TO PUBLIC`)
      }
    })

    const objectCases = [
      {
        name: 'non-system schema owner',
        create: 'CREATE SCHEMA ci_owner_test_schema',
        transfer: `ALTER SCHEMA ci_owner_test_schema OWNER TO ${workerLogin}`,
        revoke: `REVOKE ALL ON SCHEMA ci_owner_test_schema FROM ${workerLogin}`,
        makeAclNonNull: 'GRANT USAGE ON SCHEMA ci_owner_test_schema TO PUBLIC',
        acl: `SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_namespace AS n CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) AS acl
          WHERE n.nspname = 'ci_owner_test_schema' AND acl.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
        ) AS owner_in_acl`,
        drop: 'DROP SCHEMA ci_owner_test_schema',
      },
      {
        name: 'table owner',
        create: 'CREATE TABLE ci_owner_test_table (id integer)',
        transfer: `ALTER TABLE ci_owner_test_table OWNER TO ${workerLogin}`,
        revoke: `REVOKE ALL ON TABLE ci_owner_test_table FROM ${workerLogin}`,
        makeAclNonNull: 'GRANT SELECT ON TABLE ci_owner_test_table TO creative_intelligence_scheduled_worker',
        acl: `SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_class AS c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) AS acl
          WHERE c.oid = 'ci_owner_test_table'::regclass AND acl.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
        ) AS owner_in_acl`,
        drop: 'DROP TABLE ci_owner_test_table',
      },
      {
        name: 'view owner',
        create: 'CREATE VIEW ci_owner_test_view AS SELECT 1 AS id',
        transfer: `ALTER VIEW ci_owner_test_view OWNER TO ${workerLogin}`,
        revoke: `REVOKE ALL ON TABLE ci_owner_test_view FROM ${workerLogin}`,
        makeAclNonNull: 'GRANT SELECT ON TABLE ci_owner_test_view TO creative_intelligence_scheduled_worker',
        acl: `SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_class AS c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) AS acl
          WHERE c.oid = 'ci_owner_test_view'::regclass AND acl.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
        ) AS owner_in_acl`,
        drop: 'DROP VIEW ci_owner_test_view',
      },
      {
        name: 'sequence owner',
        create: 'CREATE SEQUENCE ci_owner_test_sequence',
        transfer: `ALTER SEQUENCE ci_owner_test_sequence OWNER TO ${workerLogin}`,
        revoke: `REVOKE ALL ON SEQUENCE ci_owner_test_sequence FROM ${workerLogin}`,
        makeAclNonNull: 'GRANT SELECT ON SEQUENCE ci_owner_test_sequence TO creative_intelligence_scheduled_worker',
        acl: `SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_class AS c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) AS acl
          WHERE c.oid = 'ci_owner_test_sequence'::regclass AND acl.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
        ) AS owner_in_acl`,
        drop: 'DROP SEQUENCE ci_owner_test_sequence',
      },
      {
        name: 'function owner',
        create: 'CREATE FUNCTION ci_owner_test_function() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$',
        transfer: `ALTER FUNCTION ci_owner_test_function() OWNER TO ${workerLogin}`,
        revoke: `REVOKE ALL ON FUNCTION ci_owner_test_function() FROM ${workerLogin}`,
        makeAclNonNull: 'GRANT EXECUTE ON FUNCTION ci_owner_test_function() TO creative_intelligence_scheduled_worker',
        acl: `SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_proc AS p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) AS acl
          WHERE p.oid = 'ci_owner_test_function()'::regprocedure AND acl.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
        ) AS owner_in_acl`,
        drop: 'DROP FUNCTION ci_owner_test_function()',
      },
      {
        name: 'type owner',
        create: `CREATE TYPE ci_owner_test_type AS ENUM ('one')`,
        transfer: `ALTER TYPE ci_owner_test_type OWNER TO ${workerLogin}`,
        revoke: `REVOKE ALL ON TYPE ci_owner_test_type FROM ${workerLogin}`,
        makeAclNonNull: 'GRANT USAGE ON TYPE ci_owner_test_type TO creative_intelligence_scheduled_worker',
        acl: `SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_type AS ty CROSS JOIN LATERAL pg_catalog.aclexplode(ty.typacl) AS acl
          WHERE ty.oid = 'ci_owner_test_type'::regtype AND acl.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
        ) AS owner_in_acl`,
        drop: 'DROP TYPE ci_owner_test_type',
      },
    ]

    for (const testCase of objectCases) {
      await t.test(testCase.name, async () => {
        await inspectionPool.query(testCase.create)
        try {
          await inspectionPool.query(testCase.transfer)
          await inspectionPool.query(testCase.revoke)
          await inspectionPool.query(testCase.makeAclNonNull)
          await assertOwnerAbsentFromAcl(testCase.acl)
          await assertRejected()
        } finally {
          await inspectionPool.query(testCase.drop)
        }
      })
    }

    await verifyScheduledWorkerDatabase(workerPool as unknown as RuntimeSqlPool, 2_000)
  })
})
