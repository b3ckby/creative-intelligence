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

const options = {
  pool: new NoQueryPool(), createId: () => 'winning-1', now: () => new Date('2026-10-28T12:00:00.000Z'),
  cursorSigningKey: 'test-cursor-signing-key-at-least-32-bytes', authenticate: async () => 'member-1',
}

test('Winning Ads API exposes strict save list detail optimistic update archive and remove contracts', () => {
  const operations = new Map(API_CONTRACTS.map((contract) => [contract.operationId, contract]))
  assert.deepEqual([...operations.keys()].filter((key) => key.toLowerCase().includes('winningad')).sort(), [
    'archiveWinningAd', 'getWinningAd', 'listWinningAds', 'removeWinningAd', 'saveWinningAd', 'updateWinningAd',
  ])
  assert.equal(operations.get('removeWinningAd')?.method, 'DELETE')
  assert.deepEqual((operations.get('saveWinningAd')!.schema.body as { additionalProperties: boolean }).additionalProperties, false)
})

test('Winning Ads API rejects invalid categories and unknown filters before PostgreSQL', async () => {
  const app = buildApi(options)
  const invalidCategory = await app.inject({ method: 'POST', url: '/organizations/org-1/winning-ads', payload: { sourceAdId: 'ad-1', title: 'Reference', category: 'retro', notes: '' } })
  assert.equal(invalidCategory.statusCode, 400)
  assert.deepEqual(invalidCategory.json(), { error: 'Invalid request' })
  const unknownFilter = await app.inject({ method: 'GET', url: '/organizations/org-1/winning-ads?unbounded=true' })
  assert.equal(unknownFilter.statusCode, 400)
  await app.close()
})
