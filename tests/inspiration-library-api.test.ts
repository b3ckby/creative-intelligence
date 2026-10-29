import assert from 'node:assert/strict'
import test from 'node:test'

import { buildApi } from '../src/http/build-api.ts'
import { API_CONTRACTS } from '../src/http/schemas.ts'
import type { SqlConnection, SqlPool } from '../src/persistence/postgres-organization-repository.ts'

class NoQueryPool implements SqlPool, SqlConnection {
  async connect(): Promise<SqlConnection> { throw new Error('database should not be reached') }
  release() {}
  async query<Row extends Record<string, unknown>>() { return { rows: [] as Row[], rowCount: 0 } }
}
const options = { pool: new NoQueryPool(), createId: () => 'inspiration-1', now: () => new Date('2026-10-28T12:00:00.000Z'), cursorSigningKey: 'test-cursor-signing-key-at-least-32-bytes', authenticate: async () => 'member-1' }

test('Inspiration API exposes board organization and full item lifecycle without upload or generation routes', () => {
  const operations = new Map(API_CONTRACTS.map((contract) => [contract.operationId, contract]))
  assert.deepEqual([...operations.keys()].filter((key) => key.toLowerCase().includes('inspiration')).sort(), [
    'archiveInspirationItem', 'createInspirationBoard', 'createInspirationItem', 'getInspirationItem', 'listInspirationBoards', 'listInspirationItems', 'removeInspirationItem', 'updateInspirationItem',
  ])
  assert.equal(operations.get('removeInspirationItem')?.method, 'DELETE')
  assert.equal([...operations.values()].some(({ fastifyPath }) => /upload|generate|external-url/i.test(fastifyPath)), false)
  assert.deepEqual((operations.get('createInspirationItem')!.schema.body as { additionalProperties: boolean }).additionalProperties, false)
})

test('Inspiration API rejects arbitrary source kinds, unknown fields and invalid sorts before PostgreSQL', async () => {
  const app = buildApi(options)
  const source = await app.inject({ method: 'POST', url: '/organizations/org-1/inspiration/boards/board-1/items', payload: { sourceKind: 'external_url', sourceId: 'https://evil.test/x', title: 'Study', notes: '', tags: [] } })
  assert.equal(source.statusCode, 400)
  const field = await app.inject({ method: 'POST', url: '/organizations/org-1/inspiration/boards', payload: { name: 'Launch', description: '', imageData: 'abc' } })
  assert.equal(field.statusCode, 400)
  const sort = await app.inject({ method: 'GET', url: '/organizations/org-1/inspiration/items?sort=random' })
  assert.equal(sort.statusCode, 400)
  await app.close()
})
