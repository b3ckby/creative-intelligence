import assert from 'node:assert/strict'
import test from 'node:test'

import { PostgresScaleAnalyticsService } from '../src/persistence/postgres-scale-analytics-service.ts'
import type { SqlConnection, SqlPool } from '../src/persistence/postgres-organization-repository.ts'

class FakePool implements SqlPool, SqlConnection {
  readonly queries: Array<{ text: string; values?: unknown[] }> = []
  constructor(private readonly analyticsRows: Array<Record<string, unknown>> = [{
    competitor_id: 'c-1', competitor_name: 'Example', active_ad_count: 4, new_ads_last_7d: 3,
    new_ads_prev_7d: 1, avg_days_active: 25.04, long_runner_count: 3,
    image_count: 2, video_count: 2, carousel_count: 0, text_count: 0, impression_weight: 500,
    total_ad_count: 4, newly_tracked: false,
  }], private readonly competitorIds = analyticsRows.map((row) => String(row.competitor_id))) {}
  async connect() { return this }
  release() {}
  async query<Row extends Record<string, unknown>>(text: string, values?: unknown[]) {
    this.queries.push({ text, ...(values === undefined ? {} : { values }) })
    if (text.includes('FROM products')) return { rows: [{ present: true }] as unknown as Row[], rowCount: 1 }
    if (text.includes('SELECT c.id') && text.includes('FROM competitors')) {
      const rows = this.competitorIds.map((id) => ({ id }))
      return { rows: rows as unknown as Row[], rowCount: rows.length }
    }
    if (text.includes('FROM competitors')) return { rows: this.analyticsRows as Row[], rowCount: this.analyticsRows.length }
    return { rows: [] as unknown as Row[], rowCount: 0 }
  }
}

test('Postgres scaling analytics aggregates in SQL and returns the labeled scored proxy', async () => {
  const pool = new FakePool()
  const service = new PostgresScaleAnalyticsService(pool, () => new Date('2026-10-27T12:00:00.000Z'))
  const result = await service.get('member-1', 'org-1', 'product-1')
  assert.equal(result.label, 'Public Ad Library momentum proxy')
  assert.equal(result.items[0]?.launchVelocityDelta, 2)
  assert.equal(result.items[0]?.scaleScore, 50)
  assert.ok(pool.queries.some(({ text }) => text.includes('COUNT') && text.includes('FILTER')))
  assert.ok(pool.queries.some(({ text }) => text.includes('INSERT INTO competitor_analytics_snapshots')))
  assert.ok(pool.queries.some(({ text }) => text.includes('INSERT INTO competitor_analytics_snapshots') && text.includes('carousel_count')))
  assert.ok(pool.queries.some(({ text }) => text.includes("set_config('app.user_id'")))
})

test('Postgres scaling analytics returns zero metrics for a competitor with no ads', async () => {
  const pool = new FakePool([{
    competitor_id: 'empty', competitor_name: 'Empty', active_ad_count: 0, new_ads_last_7d: 0,
    new_ads_prev_7d: 0, avg_days_active: 0, long_runner_count: 0,
    image_count: 0, video_count: 0, carousel_count: 0, text_count: 0, impression_weight: null,
    total_ad_count: 0, newly_tracked: null,
  }])
  const service = new PostgresScaleAnalyticsService(pool, () => new Date('2026-10-27T12:00:00.000Z'))

  const result = await service.get('member-1', 'org-1', 'product-1')

  assert.deepEqual(result.items, [{
    competitorId: 'empty', competitorName: 'Empty', activeAdCount: 0, newAdsLast7d: 0,
    newAdsPrev7d: 0, launchVelocityDelta: 0, avgDaysActive: 0, longRunnerCount: 0,
    formatMix: { image: 0, video: 0, carousel: 0, text: 0 }, newlyTracked: false, scaleScore: 0,
  }])
})

test('Postgres scaling analytics bounds competitors before the aggregate and rejects cap-plus-one', async () => {
  const competitorIds = Array.from({ length: 10_001 }, (_, index) => `competitor-${index}`)
  const pool = new FakePool([], competitorIds)
  const service = new PostgresScaleAnalyticsService(pool, () => new Date('2026-10-27T12:00:00.000Z'))

  await assert.rejects(service.get('member-1', 'org-1', 'product-1'), /Analytics competitor limit exceeded/)

  const capQuery = pool.queries.find(({ text }) => text.includes('SELECT c.id') && text.includes('FROM competitors'))
  assert.ok(capQuery)
  assert.match(capQuery.text, /ORDER BY c\.id[\s\S]*LIMIT 10001/i)
  assert.equal(pool.queries.some(({ text }) => text.includes('COUNT(a.id)')), false)
  assert.equal(pool.queries.some(({ text }) => text.includes('INSERT INTO competitor_analytics_snapshots')), false)
})

test('Postgres scaling analytics accepts the full 10,000 competitor sample', async () => {
  const competitorIds = Array.from({ length: 10_000 }, (_, index) => `competitor-${index}`)
  const pool = new FakePool([{
    competitor_id: 'competitor-0', competitor_name: 'Example', active_ad_count: 0, new_ads_last_7d: 0,
    new_ads_prev_7d: 0, avg_days_active: 0, long_runner_count: 0,
    image_count: 0, video_count: 0, carousel_count: 0, text_count: 0, impression_weight: null,
    total_ad_count: 0, newly_tracked: null,
  }], competitorIds)
  const service = new PostgresScaleAnalyticsService(pool, () => new Date('2026-10-27T12:00:00.000Z'))

  await assert.doesNotReject(service.get('member-1', 'org-1', 'product-1'))
  const aggregate = pool.queries.find(({ text }) => text.includes('COUNT(a.id)'))
  assert.deepEqual(aggregate?.values?.[6], competitorIds)
  assert.ok(pool.queries.some(({ text }) => text.includes('INSERT INTO competitor_analytics_snapshots')))
})

test('Postgres scaling analytics uses explicit ad type and the same legacy media fallback as memory', async () => {
  const pool = new FakePool([{
    competitor_id: 'formats', competitor_name: 'Formats', active_ad_count: 0, new_ads_last_7d: 0,
    new_ads_prev_7d: 0, avg_days_active: 0, long_runner_count: 0,
    image_count: 2, video_count: 3, carousel_count: 1, text_count: 2, impression_weight: null,
    total_ad_count: 8, newly_tracked: false,
  }])
  const service = new PostgresScaleAnalyticsService(pool, () => new Date('2026-10-27T12:00:00.000Z'))

  const result = await service.get('member-1', 'org-1', 'product-1')
  const aggregateSql = pool.queries.find(({ text }) => text.includes('FROM competitors') && text.includes('COUNT(a.id)'))?.text ?? ''

  assert.deepEqual(result.items[0]?.formatMix, { image: 2, video: 3, carousel: 1, text: 2 })
  assert.match(aggregateSql, /jsonb_array_elements_text\(a\.media_urls\)/)
  assert.match(aggregateSql, /video-/)
  assert.match(aggregateSql, /mp4\|m4v\|webm\|mov/i)
  assert.match(aggregateSql, /a\.ad_type/)
})
