import assert from 'node:assert/strict'
import test from 'node:test'

import { PostgresCompetitorAnalyticsService } from '../src/persistence/postgres-competitor-analytics-service.ts'
import type { SqlConnection, SqlPool } from '../src/persistence/postgres-organization-repository.ts'

class FakePool implements SqlPool, SqlConnection {
  readonly queries: Array<{ text: string; values?: unknown[] }> = []
  constructor(private readonly rows: Array<Record<string, unknown>>) {}
  async connect() { return this }
  release() {}
  async query<Row extends Record<string, unknown>>(text: string, values?: unknown[]) {
    this.queries.push({ text, ...(values === undefined ? {} : { values }) })
    if (text.includes('FROM products')) return { rows: [{ present: true }] as unknown as Row[], rowCount: 1 }
    if (text.includes('competitor_analytics_snapshots')) {
      return { rows: this.rows as Row[], rowCount: this.rows.length }
    }
    return { rows: [] as unknown as Row[], rowCount: 0 }
  }
}

const latest = {
  competitor_id: 'competitor-1', competitor_name: 'Orbit', snapshot_date: '2026-10-27', captured_at: new Date('2026-10-27T12:00:00.000Z'),
  active_ad_count: 12, new_ads_last_7d: 5, launch_velocity_delta: 3, avg_days_active: 18.5, long_runner_count: 4,
  image_count: 5, video_count: 6, carousel_count: 1, text_count: 0, impression_weight: 1250, scale_score: 88, newly_tracked: false,
  is_displayed: true,
}

const baseline = {
  ...latest, snapshot_date: '2026-10-20', captured_at: new Date('2026-10-20T12:00:00.000Z'), active_ad_count: 8, scale_score: 70,
}

test('competitor analytics comparison preserves explicit selection order and reports latest metrics and trends', async () => {
  const peerLatest = { ...latest, competitor_id: 'competitor-2', competitor_name: 'Nova', active_ad_count: 6, scale_score: 55 }
  const peerBaseline = { ...baseline, competitor_id: 'competitor-2', competitor_name: 'Nova', active_ad_count: 8, scale_score: 60 }
  const pool = new FakePool([peerLatest, peerBaseline, latest, baseline])
  const service = new PostgresCompetitorAnalyticsService(pool)

  const result = await service.compare('member-1', 'org-1', 'product-1', ['competitor-2', 'competitor-1'])

  assert.equal(result.label, 'Public Ad Library momentum proxy')
  assert.deepEqual(result.items.map(({ competitor }) => competitor.id), ['competitor-2', 'competitor-1'])
  assert.equal(result.items[0]?.latest?.activeAdCount, 6)
  assert.deepEqual(result.items[0]?.trend7d, {
    activeAdCountChange: -2,
    activeAdCountChangePercent: -25,
    scaleScoreChange: -5,
    direction: 'down',
  })
  const query = pool.queries.find(({ text }) => text.includes('competitor_analytics_snapshots'))
  assert.ok(query)
  assert.match(query.text, /unnest\(\$3::text\[\]\) WITH ORDINALITY/)
  assert.match(query.text, /c\.archived_at IS NULL/)
  assert.match(query.text, /LEFT JOIN LATERAL/)
  assert.match(query.text, /ORDER BY stored\.snapshot_date DESC[\s\S]*LIMIT 8/)
  assert.deepEqual(query.values, ['org-1', 'product-1', ['competitor-2', 'competitor-1']])
})

test('competitor analytics comparison rejects duplicate, undersized, and oversized selections before connecting', async () => {
  const pool = new FakePool([])
  const service = new PostgresCompetitorAnalyticsService(pool)
  await assert.rejects(service.compare('member-1', 'org-1', 'product-1', ['competitor-1']), /2 to 10/)
  await assert.rejects(service.compare('member-1', 'org-1', 'product-1', ['competitor-1', 'competitor-1']), /unique/)
  await assert.rejects(service.compare('member-1', 'org-1', 'product-1', Array.from({ length: 11 }, (_, index) => `competitor-${index}`)), /2 to 10/)
  assert.equal(pool.queries.length, 0)
})

test('competitor analytics history reads bounded durable snapshots and reports a seven-day trend', async () => {
  const pool = new FakePool([latest, baseline])
  const service = new PostgresCompetitorAnalyticsService(pool)

  const result = await service.history('member-1', 'org-1', 'product-1', 'competitor-1', 30)

  assert.equal(result.label, 'Public Ad Library momentum proxy')
  assert.deepEqual(result.competitor, { id: 'competitor-1', name: 'Orbit' })
  assert.equal(result.windowDays, 30)
  assert.deepEqual(result.trend7d, {
    activeAdCountChange: 4,
    activeAdCountChangePercent: 50,
    scaleScoreChange: 18,
    direction: 'up',
  })
  assert.equal(result.items.length, 2)
  assert.equal(result.items[0]?.snapshotDate, '2026-10-27')
  assert.equal(result.items[0]?.formatMix.carousel, 1)
  const query = pool.queries.find(({ text }) => text.includes('competitor_analytics_snapshots'))
  assert.ok(query)
  assert.match(query.text, /c\.organization_id\s*=\s*\$1/)
  assert.match(query.text, /stored\.organization_id\s*=\s*c\.organization_id/)
  assert.match(query.text, /clock_timestamp\(\) AT TIME ZONE 'UTC'/)
  assert.match(query.text, /LIMIT 91/)
  assert.deepEqual(query.values, ['org-1', 'product-1', 'competitor-1', 30])
  assert.ok(pool.queries.some(({ text }) => text.includes("set_config('app.user_id'")))
})

test('seven-day history keeps its exact baseline out of displayed items while using it for trend', async () => {
  const pool = new FakePool([latest, { ...baseline, is_displayed: false }])
  const service = new PostgresCompetitorAnalyticsService(pool)

  const result = await service.history('member-1', 'org-1', 'product-1', 'competitor-1', 7)

  assert.deepEqual(result.items.map(({ snapshotDate }) => snapshotDate), ['2026-10-27'])
  assert.equal(result.trend7d?.activeAdCountChange, 4)
  const query = pool.queries.find(({ text }) => text.includes('competitor_analytics_snapshots'))
  assert.ok(query)
  assert.match(query.text, /is_displayed/)
})
