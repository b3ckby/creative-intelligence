import assert from 'node:assert/strict'
import test from 'node:test'

import { PostgresStagingLoginRateLimiter } from '../../src/persistence/postgres-staging-login-rate-limiter.ts'
import { withRealPostgres } from './helpers/real-postgres.ts'

test('real PostgreSQL serializes staging login attempt claims across service instances', async () => {
  await withRealPostgres(async ({ runtimePool, inspectionPool }) => {
    const first = new PostgresStagingLoginRateLimiter(runtimePool, { maxAttempts: 1, attemptWindowMs: 300_000 })
    const second = new PostgresStagingLoginRateLimiter(runtimePool, { maxAttempts: 1, attemptWindowMs: 300_000 })

    const claims = await Promise.all([
      first.claim('203.0.113.10'),
      second.claim('203.0.113.10'),
    ])
    assert.deepEqual(claims.sort(), [false, true])

    const stored = await inspectionPool.query<{ address_hash: string, attempts: number }>(
      `SELECT address_hash, attempts FROM staging_login_attempts`,
    )
    assert.equal(stored.rows.length, 1)
    assert.equal(stored.rows[0]?.address_hash.length, 43)
    assert.equal(stored.rows[0]?.attempts, 1)
    assert.equal(JSON.stringify(stored.rows).includes('203.0.113.10'), false)

    for (const statement of [
      'SELECT * FROM staging_login_attempts',
      `INSERT INTO staging_login_attempts (address_hash, window_started_at, expires_at, attempts) VALUES ('${'a'.repeat(43)}', clock_timestamp(), clock_timestamp() + interval '1 minute', 1)`,
      'UPDATE staging_login_attempts SET attempts = 1',
      'DELETE FROM staging_login_attempts',
    ]) {
      await assert.rejects(runtimePool.query(statement), /permission denied/i)
    }

    await first.reset('203.0.113.10')
    assert.equal(await second.claim('203.0.113.10'), true)
  })
})

test('real PostgreSQL bounds and expires staging login attempt buckets', async () => {
  await withRealPostgres(async ({ runtimePool, inspectionPool }) => {
    await inspectionPool.query('TRUNCATE staging_login_attempts')
    await inspectionPool.query(`
      INSERT INTO staging_login_attempts (address_hash, window_started_at, expires_at, attempts)
      SELECT lpad(value::text, 43, '0'), clock_timestamp(), clock_timestamp() + interval '1 hour', 1
      FROM generate_series(1, 10000) AS value
    `)
    const limiter = new PostgresStagingLoginRateLimiter(runtimePool, { maxAttempts: 5, attemptWindowMs: 300_000 })
    assert.equal(await limiter.claim('capacity-probe'), false)

    await inspectionPool.query(`UPDATE staging_login_attempts SET window_started_at = clock_timestamp() - interval '2 seconds', expires_at = clock_timestamp() - interval '1 second'`)
    assert.equal(await limiter.claim('after-expiry'), true)
    const count = await inspectionPool.query<{ count: string }>('SELECT count(*)::text AS count FROM staging_login_attempts')
    assert.equal(Number(count.rows[0]?.count), 1)
  })
})
