import assert from 'node:assert/strict'
import test from 'node:test'

import { probeDatabase, verifyRuntimeDatabase, type RuntimeSqlPool } from '../../src/persistence/postgres-pool.ts'
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
