import assert from 'node:assert/strict'
import test from 'node:test'

import { PostgresInspirationRepository } from '../src/persistence/postgres-inspiration-repository.ts'
import type { SqlConnection, SqlPool } from '../src/persistence/postgres-organization-repository.ts'

class FakePool implements SqlPool, SqlConnection {
  readonly queries: Array<{ text: string; values: unknown[] }> = []
  async connect() { return this }
  release() {}
  async query<Row extends Record<string, unknown>>(text: string, values: unknown[] = []) {
    this.queries.push({ text, values })
    return { rows: [] as Row[], rowCount: 0 }
  }
}

const now = new Date('2026-10-28T12:00:00.000Z')

test('Inspiration creates tenant-owned boards with bounded canonical metadata', async () => {
  const pool = new FakePool()
  const repository = new PostgresInspirationRepository(pool, () => 'board-1', () => now)
  await assert.rejects(() => repository.createBoard('member-1', 'org-1', { name: '  Moodboard  ', description: '  Launch language  ' }))
  const insert = pool.queries.find(({ text }) => text.includes('INSERT INTO inspiration_boards'))!
  assert.deepEqual(insert.values.slice(0, 5), ['org-1', 'board-1', 'Moodboard', 'Launch language', 'member-1'])
})

test('Inspiration snapshots only trusted mirrored competitor or Winning Ad media without source foreign keys', async () => {
  const pool = new FakePool()
  const ids = ['item-1', 'unused']
  const repository = new PostgresInspirationRepository(pool, () => ids.shift()!, () => now)
  await assert.rejects(() => repository.addItem('member-1', 'org-1', 'board-1', { sourceKind: 'competitor_ad', sourceId: 'ad-1', title: 'Visual rhythm', notes: '', tags: ['motion', 'proof'] }))
  const insert = pool.queries.find(({ text }) => text.includes('INSERT INTO inspiration_items'))!
  assert.match(insert.text, /competitor_ad_media_positions[\s\S]*status='succeeded'[\s\S]*active_checksum IS NOT NULL/u)
  assert.match(insert.text, /UNION ALL[\s\S]*FROM winning_ads/u)
  assert.match(insert.text, /ON CONFLICT \(organization_id,board_id,source_kind,source_ref_id\)/u)
  assert.doesNotMatch(insert.text, /https?:\/\//u)
})

test('Inspiration item listing is tenant scoped bounded searchable filterable and sortable', async () => {
  const pool = new FakePool()
  const repository = new PostgresInspirationRepository(pool, () => 'id-1', () => now)
  await repository.pageItems('member-1', 'org-1', { limit: 20, includeArchived: false, boardId: 'board-1', search: 'kinetic', tag: 'motion', sourceKind: 'winning_ad', sort: 'updated_desc' })
  const query = pool.queries.find(({ text }) => text.includes('FROM inspiration_items'))!
  assert.match(query.text, /inspiration_items\.organization_id=\$1/u)
  assert.match(query.text, /to_tsvector\('simple'/u)
  assert.match(query.text, /\$\d+ = ANY\(inspiration_items\.tags\)/u)
  assert.match(query.text, /source_kind=/u)
  assert.match(query.text, /ORDER BY inspiration_items\.updated_at DESC,inspiration_items\.id DESC/u)
  assert.equal(query.values.at(-1), 21)
})

test('Inspiration metadata updates use optimistic concurrency and archive/remove stay tenant scoped', async () => {
  const pool = new FakePool()
  const repository = new PostgresInspirationRepository(pool, () => 'id-1', () => now)
  await assert.rejects(() => repository.updateItem('member-1', 'org-1', 'item-1', { expectedVersion: 2, boardId: 'board-1', title: 'Study', notes: 'Reuse this composition', tags: ['composition'] }))
  const update = pool.queries.find(({ text }) => text.includes('UPDATE inspiration_items SET'))!
  assert.match(update.text, /version=version\+1/u)
  assert.match(update.text, /organization_id=\$1 AND id=\$2 AND version=\$7/u)
})
