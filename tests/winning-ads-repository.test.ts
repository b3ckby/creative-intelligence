import assert from 'node:assert/strict'
import test from 'node:test'

import { PostgresWinningAdsRepository } from '../src/persistence/postgres-winning-ads-repository.ts'
import type { SqlConnection, SqlPool } from '../src/persistence/postgres-organization-repository.ts'

class FakePool implements SqlPool, SqlConnection {
  readonly queries: Array<{ text: string; values: unknown[] }> = []
  rows: Record<string, unknown>[] = []
  async connect() { return this }
  release() {}
  async query<Row extends Record<string, unknown>>(text: string, values: unknown[] = []) {
    this.queries.push({ text, values })
    const rows = text.includes('RETURNING') || text.includes('FROM winning_ads') ? this.rows as Row[] : [] as Row[]
    return { rows, rowCount: rows.length }
  }
}

const now = new Date('2026-10-28T12:00:00.000Z')

test('winning ad save is idempotent per tenant source and requires a successful trusted mirror', async () => {
  const pool = new FakePool()
  const repository = new PostgresWinningAdsRepository(pool, () => 'winning-1', () => now)
  await assert.rejects(repository.save('member-1', 'org-1', 'ad-1', { title: 'Reference', category: 'modern', notes: '' }))
  const insert = pool.queries.find(({ text }) => text.includes('INSERT INTO winning_ads'))!
  assert.match(insert.text, /competitor_ad_media_positions[\s\S]*status = 'succeeded'[\s\S]*active_checksum IS NOT NULL/u)
  assert.match(insert.text, /creative_media_blobs/u)
  assert.match(insert.text, /ON CONFLICT \(organization_id,source_ad_id\)/u)
  assert.match(insert.text, /creative_ad_analyses[\s\S]*status = 'completed'[\s\S]*ORDER BY/u)
  assert.match(insert.text, /provenance/u)
})

test('winning ad list is tenant-scoped bounded and applies search category source-active and archive filters', async () => {
  const pool = new FakePool()
  const repository = new PostgresWinningAdsRepository(pool, () => 'winning-1', () => now)
  await repository.page('member-1', 'org-1', { limit: 20, search: 'testimonial', category: 'classic', active: true, includeArchived: false })
  const query = pool.queries.find(({ text }) => text.includes('FROM winning_ads'))!
  assert.match(query.text, /winning_ads\.organization_id = \$1/u)
  assert.match(query.text, /to_tsvector\('simple'/u)
  assert.match(query.text, /winning_ads\.category =/u)
  assert.match(query.text, /winning_ads\.source_is_active =/u)
  assert.match(query.text, /winning_ads\.archived_at IS NULL/u)
  assert.match(query.text, /ORDER BY winning_ads\.created_at,winning_ads\.id LIMIT/u)
  assert.equal(query.values.at(-1), 21)
})

test('winning ad metadata update is strict optimistic and member-scoped', async () => {
  const pool = new FakePool()
  const repository = new PostgresWinningAdsRepository(pool, () => 'winning-1', () => now)
  await assert.rejects(repository.update('member-1', 'org-1', 'winning-1', { expectedVersion: 2, title: 'Updated', category: 'bold', notes: 'Keep' }))
  const query = pool.queries.find(({ text }) => text.includes('UPDATE winning_ads SET title'))!
  assert.match(query.text, /version = version \+ 1/u)
  assert.match(query.text, /organization_id = \$1 AND id = \$2 AND version = \$6/u)
})
