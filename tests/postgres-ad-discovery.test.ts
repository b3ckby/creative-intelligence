import assert from 'node:assert/strict'
import test from 'node:test'

import { PostgresCatalogRepository } from '../src/persistence/postgres-catalog-repository.ts'
import type { SqlConnection, SqlPool } from '../src/persistence/postgres-organization-repository.ts'

class FakePool implements SqlPool, SqlConnection {
  readonly queries: Array<{ text: string; values: unknown[] }> = []
  async connect() { return this }
  release() {}
  async query<Row extends Record<string, unknown>>(text: string, values: unknown[] = []) {
    this.queries.push({ text, values })
    return { rows: [] as Row[], rowCount: text.includes('INSERT INTO competitor_ad_bookmarks') || text.includes('DELETE FROM competitor_ad_bookmarks') ? 1 : 0 }
  }
}

test('ad discovery applies bounded full-text, latest-tag, private bookmark filters and deterministic sort', async () => {
  const pool = new FakePool()
  const repository = new PostgresCatalogRepository(pool)
  await repository.pageAds('member-1', 'org-1', {
    limit: 25, includeArchived: false, productId: 'product-1', search: 'missed calls', hookCategory: 'pain_point',
    angle: 'rational', creativeFormat: 'ugc', bookmarked: true, sort: 'impressions_desc',
  })

  const query = pool.queries.find(({ text }) => text.includes('FROM competitor_ads'))!
  assert.match(query.text, /plainto_tsquery\('simple'/u)
  assert.match(query.text, /LEFT JOIN LATERAL[\s\S]*creative_ad_analyses/u)
  assert.match(query.text, /creative_analysis_reviews/u)
  assert.match(query.text, /decision <> 'rejected'/u)
  assert.match(query.text, /ca\.tags \|\| COALESCE\(latest_review\.corrections/u)
  assert.match(query.text, /latest_analysis\.tags->>'hookCategory'/u)
  assert.match(query.text, /competitor_ad_bookmarks/u)
  assert.match(query.text, /bookmarks\.user_id = app_verified_user_id\(\)/u)
  assert.match(query.text, /bookmarks\.competitor_ad_id IS NOT NULL/u)
  assert.match(query.text, /ORDER BY COALESCE\(competitor_ads\.impressions_upper_bound, 0\) DESC, competitor_ads\.id DESC/u)
  assert.deepEqual(query.values.slice(0, -1), ['org-1', 'product-1', 'missed calls', 'pain_point', 'rational', 'ugc'])
})

test('bookmark mutations are idempotent and scoped to the verified user', async () => {
  const pool = new FakePool()
  const repository = new PostgresCatalogRepository(pool)
  await repository.setAdBookmark('member-1', 'org-1', 'ad-1', true)
  await repository.setAdBookmark('member-1', 'org-1', 'ad-1', false)

  assert.match(pool.queries.find(({ text }) => text.includes('INSERT INTO competitor_ad_bookmarks'))!.text, /ON CONFLICT DO NOTHING/u)
  assert.match(pool.queries.find(({ text }) => text.includes('DELETE FROM competitor_ad_bookmarks'))!.text, /user_id = app_verified_user_id\(\)/u)
})
