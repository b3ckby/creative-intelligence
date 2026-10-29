import assert from 'node:assert/strict'
import test from 'node:test'

import { PostgresCreativeStrategyService } from '../src/persistence/postgres-creative-strategy-service.ts'
import type { SqlConnection, SqlPool } from '../src/persistence/postgres-organization-repository.ts'

class FakePool implements SqlPool, SqlConnection {
  readonly queries: string[] = []
  async connect() { return this }
  release() {}
  async query<Row extends Record<string, unknown>>(text: string) {
    this.queries.push(text)
    if (text.includes('DISTINCT ON (a.id)')) return { rows: [
      { dimension: 'hooks', value: 'pain_point', tag_count: '3', total_ads: '8', analyzed_ads: '5' },
      { dimension: 'angles', value: 'rational', tag_count: '2', total_ads: '8', analyzed_ads: '5' },
      { dimension: 'personas', value: 'Busy Marketers', tag_count: '2', total_ads: '8', analyzed_ads: '5' },
    ] as unknown as Row[], rowCount: 3 }
    return { rows: [] as unknown as Row[], rowCount: 0 }
  }
}

test('creative strategy counts only the latest completed analysis per ad and returns deterministic frequencies', async () => {
  const pool = new FakePool()
  const service = new PostgresCreativeStrategyService(pool)
  const summary = await service.get('member-1', 'org-1', 'product-1', 'competitor-1')

  assert.equal(summary.totalAds, 8)
  assert.equal(summary.analyzedAds, 5)
  assert.deepEqual(summary.dimensions.hooks, [{ value: 'pain_point', count: 3, percentage: 60 }])
  assert.deepEqual(summary.dimensions.personas, [{ value: 'Busy Marketers', count: 2, percentage: 40 }])
  const sql = pool.queries.find((query) => query.includes('DISTINCT ON (a.id)')) ?? ''
  assert.match(sql, /DISTINCT ON \(a\.id\)/u)
  assert.match(sql, /ca\.status = 'completed'/u)
  assert.match(sql, /creative_analysis_reviews/u)
  assert.match(sql, /decision <> 'rejected'/u)
  assert.match(sql, /ca\.tags \|\| COALESCE\(latest_review\.corrections/u)
  assert.match(sql, /ORDER BY a\.id, ca\.analyzed_at DESC/u)
  assert.match(sql, /ROW_NUMBER\(\) OVER/u)
})
