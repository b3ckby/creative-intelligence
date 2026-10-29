import assert from 'node:assert/strict'
import test from 'node:test'

import { PostgresCreativeAnalysisService } from '../src/persistence/postgres-creative-analysis-service.ts'
import type { SqlConnection, SqlPool } from '../src/persistence/postgres-organization-repository.ts'

class FakePool implements SqlPool, SqlConnection {
  readonly queries: string[] = []
  readonly parameters: unknown[][] = []
  async connect() { return this }
  release() {}
  async query<Row extends Record<string, unknown>>(text: string, values?: unknown[]) {
    this.queries.push(text)
    this.parameters.push(values ?? [])
    if (text.includes('SELECT a.*')) return { rows: [{
      id: 'ad-1', organization_id: 'org-1', product_id: 'product-1', competitor_id: 'competitor-1',
      provider_name: 'apify-meta-ads', platform: 'meta', external_id: 'external-1', advertiser_name: 'Example', body: 'Save time',
      call_to_action: 'LEARN_MORE', started_at: new Date('2026-10-01T00:00:00.000Z'), is_active: true,
      media_urls: [], source_url: 'https://www.facebook.com/ads/library/?id=external-1',
      first_seen_at: new Date('2026-10-02T00:00:00.000Z'), last_seen_at: new Date('2026-10-27T00:00:00.000Z'),
    }] as unknown as Row[], rowCount: 1 }
    if (text.includes('SELECT true AS allowed')) return { rows: [{ allowed: true }] as unknown as Row[], rowCount: 1 }
    if (text.includes('INSERT INTO creative_ad_analyses')) return { rows: [{ claim_token: values?.[5] }] as unknown as Row[], rowCount: 1 }
    if (text.includes('INSERT INTO creative_analysis_daily_usage')) return { rows: [{ usage_count: 1 }] as unknown as Row[], rowCount: 1 }
    if (text.includes('UPDATE creative_ad_analyses')) return { rows: [] as unknown as Row[], rowCount: 1 }
    return { rows: [] as unknown as Row[], rowCount: 0 }
  }
}

test('Postgres creative analysis claims a durable tenant-scoped daily slot before model use', async () => {
  const pool = new FakePool()
  let calls = 0
  const service = new PostgresCreativeAnalysisService(pool, {
    provider: 'gemini', model: 'gemini-test', async analyze() {
      calls += 1
      return { hookCategory: 'pain_point', angle: 'rational', emotion: 'relief', persona: 'busy marketers', format: 'tutorial', offerFrame: 'demo', cta: 'Learn more', visualSummary: 'Copy-led productivity message', funnelStage: 'consideration', confidence: 0.82 }
    },
  }, () => new Date('2026-10-27T12:00:00.000Z'), 25)
  const result = await service.analyze('member-1', 'org-1', 'product-1', 'ad-1')
  assert.equal(result.competitorAdId, 'ad-1')
  assert.equal(calls, 1)
  assert.ok(pool.queries.some((sql) => sql.includes('FOR UPDATE')))
  assert.ok(pool.queries.some((sql) => sql.includes('creative_analysis_daily_usage')))
  assert.ok(pool.queries.some((sql) => sql.includes('claim_expires_at')))
  assert.ok(pool.queries.some((sql) => sql.includes('claim_token = $11')))
})

test('Postgres creative analysis uses the database clock for lease expiry and UTC daily accounting', async () => {
  const pool = new FakePool()
  const processInstant = '1900-01-01T00:00:00.000Z'
  const service = new PostgresCreativeAnalysisService(pool, {
    provider: 'gemini', model: 'gemini-test', async analyze() {
      return { hookCategory: 'pain_point', angle: 'rational', emotion: 'relief', persona: 'busy marketers', format: 'tutorial', offerFrame: 'demo', cta: 'Learn more', visualSummary: 'Copy-led productivity message', funnelStage: 'consideration', confidence: 0.82 }
    },
  }, () => new Date(processInstant), 25)

  await service.analyze('member-1', 'org-1', 'product-1', 'ad-1')

  const claimIndex = pool.queries.findIndex((sql) => sql.includes('INSERT INTO creative_ad_analyses'))
  const usageIndex = pool.queries.findIndex((sql) => sql.includes('INSERT INTO creative_analysis_daily_usage'))
  const completeIndex = pool.queries.findIndex((sql) => sql.includes('UPDATE creative_ad_analyses') && sql.includes("status = 'completed'"))
  assert.match(pool.queries[claimIndex] ?? '', /statement_timestamp\(\) \+ interval '5 minutes'/u)
  assert.match(pool.queries[claimIndex] ?? '', /claim_expires_at <= statement_timestamp\(\)/u)
  assert.equal(pool.parameters[claimIndex]?.includes(processInstant), false)
  assert.match(pool.queries[usageIndex] ?? '', /statement_timestamp\(\) AT TIME ZONE 'UTC'/u)
  assert.equal(pool.parameters[usageIndex]?.includes(processInstant), false)
  assert.match(pool.queries[completeIndex] ?? '', /analyzed_at = \$9,[\s\S]*updated_at = statement_timestamp\(\)/u)
})
