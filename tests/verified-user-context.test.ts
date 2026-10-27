import assert from 'node:assert/strict'
import test from 'node:test'

import type { SqlConnection, SqlPool } from '../src/persistence/postgres-organization-repository.ts'
import { withVerifiedUserContext } from '../src/persistence/verified-user-context.ts'

test('rollback failure preserves the primary error and destroys the connection', async () => {
  const primary = new Error('operation failed')
  const rollback = new Error('rollback failed')
  let releasedWith: Error | undefined
  const connection: SqlConnection = {
    async query(text: string) {
      if (text === 'ROLLBACK') throw rollback
      return { rows: [], rowCount: 0 }
    },
    release(error?: Error) { releasedWith = error },
  }
  const pool: SqlPool = {
    async connect() { return connection },
    async query() { return { rows: [], rowCount: 0 } },
  }

  await assert.rejects(
    withVerifiedUserContext(pool, 'user-1', async () => { throw primary }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(error.errors, [primary, rollback])
      return true
    },
  )
  assert.equal(releasedWith, rollback)
})
