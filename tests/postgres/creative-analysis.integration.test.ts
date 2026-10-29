import assert from 'node:assert/strict'
import test from 'node:test'

import { ApplicationError, ConflictError } from '../../src/domain/errors.ts'
import { OrganizationService } from '../../src/organizations/organization-service.ts'
import { PostgresCreativeAnalysisService } from '../../src/persistence/postgres-creative-analysis-service.ts'
import { PostgresOrganizationRepository } from '../../src/persistence/postgres-organization-repository.ts'
import { withVerifiedUserContext } from '../../src/persistence/verified-user-context.ts'
import { withRealPostgres } from './helpers/real-postgres.ts'

const tags = { hookCategory: 'pain_point', angle: 'rational', emotion: 'relief', persona: 'busy marketers', format: 'tutorial', offerFrame: 'demo', cta: 'Learn more', visualSummary: 'Copy-led productivity message', funnelStage: 'consideration', confidence: 0.82 } as const
const instant = new Date('2026-10-27T12:00:00.000Z')

test('real PostgreSQL creative analysis leases and accounting fail closed', async () => {
  await withRealPostgres(async ({ runtimePool }) => {
    const organizations = new OrganizationService(new PostgresOrganizationRepository(runtimePool), () => 'org-ai', () => instant)
    await organizations.create({ name: 'AI org', actorUserId: 'user-ai' })
    await withVerifiedUserContext(runtimePool, 'user-ai', async (connection) => {
      await connection.query(`INSERT INTO products (id, organization_id, name) VALUES ('product-ai', 'org-ai', 'Product')`)
      await connection.query(`INSERT INTO competitors (id, organization_id, product_id, name) VALUES ('competitor-ai', 'org-ai', 'product-ai', 'Competitor')`)
      await connection.query(`INSERT INTO competitor_ads
        (id, ingestion_token, organization_id, product_id, competitor_id, provider_name, platform, external_id,
         advertiser_name, body, started_at, is_active, source_url, first_seen_at, last_seen_at)
        VALUES ('ad-ai', 'token', 'org-ai', 'product-ai', 'competitor-ai', 'provider', 'meta', 'external-ai',
                'Advertiser', 'A', $1, true, 'https://example.test/ad', $1, $1)`, [instant.toISOString()])
    })

    let releaseClockProbe!: () => void
    let enteredClockProbe!: () => void
    const clockProbeEntered = new Promise<void>((resolve) => { enteredClockProbe = resolve })
    const clockProbeGate = new Promise<void>((resolve) => { releaseClockProbe = resolve })
    const skewedProcessClock = new Date('1900-01-01T00:00:00.000Z')
    const clockProbe = new PostgresCreativeAnalysisService(runtimePool, {
      provider: 'gemini', model: 'gemini-test', async analyze() { enteredClockProbe(); await clockProbeGate; return tags },
    }, () => skewedProcessClock, 20)
    const clockProbeAnalysis = clockProbe.analyze('user-ai', 'org-ai', 'product-ai', 'ad-ai')
    await clockProbeEntered
    const durableClockState = await withVerifiedUserContext(runtimePool, 'user-ai', async (connection) => connection.query<{
      lease_uses_database_clock: boolean
      usage_uses_database_date: boolean
    }>(`SELECT
          a.claim_expires_at > statement_timestamp()
            AND a.claim_expires_at <= statement_timestamp() + interval '5 minutes 5 seconds' AS lease_uses_database_clock,
          u.usage_date = (statement_timestamp() AT TIME ZONE 'UTC')::date AS usage_uses_database_date
        FROM creative_ad_analyses a
        JOIN creative_analysis_daily_usage u USING (organization_id)
        WHERE a.competitor_ad_id = 'ad-ai' AND a.status = 'pending'`))
    assert.deepEqual(durableClockState.rows[0], { lease_uses_database_clock: true, usage_uses_database_date: true })
    releaseClockProbe()
    const clockProbeResult = await clockProbeAnalysis
    assert.equal(clockProbeResult.analyzedAt, skewedProcessClock.toISOString())
    await withVerifiedUserContext(runtimePool, 'user-ai', async (connection) => {
      await connection.query(`UPDATE competitor_ads SET body = 'provider failure' WHERE id = 'ad-ai'`)
    })

    const failed = new PostgresCreativeAnalysisService(runtimePool, {
      provider: 'gemini', model: 'gemini-test', async analyze() { throw new Error('provider failed') },
    }, () => instant, 20)
    await assert.rejects(failed.analyze('user-ai', 'org-ai', 'product-ai', 'ad-ai'), (error) => error instanceof ApplicationError && error.statusCode === 502 && error.publicMessage === 'AI provider is unavailable')

    let state = await withVerifiedUserContext(runtimePool, 'user-ai', async (connection) => connection.query<{ status: string; usage_count: number }>(`
      SELECT a.status, u.usage_count FROM creative_ad_analyses a
      JOIN creative_analysis_daily_usage u USING (organization_id)
      WHERE a.competitor_ad_id = 'ad-ai' AND a.status = 'failed'`))
    assert.deepEqual(state.rows[0], { status: 'failed', usage_count: 2 })

    const succeeds = new PostgresCreativeAnalysisService(runtimePool, {
      provider: 'gemini', model: 'gemini-test', async analyze() { return tags },
    }, () => instant, 20)
    await succeeds.analyze('user-ai', 'org-ai', 'product-ai', 'ad-ai')

    await withVerifiedUserContext(runtimePool, 'user-ai', async (connection) => {
      await connection.query(`UPDATE competitor_ads SET body = 'expired lease' WHERE id = 'ad-ai'`)
    })
    let releaseExpired!: () => void
    let enteredExpired!: () => void
    const expiredGate = new Promise<void>((resolve) => { releaseExpired = resolve })
    const expiredEntered = new Promise<void>((resolve) => { enteredExpired = resolve })
    const expiredWorker = new PostgresCreativeAnalysisService(runtimePool, {
      provider: 'gemini', model: 'gemini-test', async analyze() { enteredExpired(); await expiredGate; return tags },
    }, () => instant, 20)
    const staleAttempt = expiredWorker.analyze('user-ai', 'org-ai', 'product-ai', 'ad-ai')
    await expiredEntered
    await withVerifiedUserContext(runtimePool, 'user-ai', async (connection) => {
      await connection.query(`UPDATE creative_ad_analyses SET claim_expires_at = $1
        WHERE competitor_ad_id = 'ad-ai' AND status = 'pending'`, ['2026-10-27T11:00:00.000Z'])
    })
    await succeeds.analyze('user-ai', 'org-ai', 'product-ai', 'ad-ai')
    releaseExpired()
    await assert.rejects(staleAttempt, /Creative analysis claim was lost/u)

    await withVerifiedUserContext(runtimePool, 'user-ai', async (connection) => {
      await connection.query(`UPDATE competitor_ads SET body = 'concurrent' WHERE id = 'ad-ai'`)
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const concurrent = new PostgresCreativeAnalysisService(runtimePool, {
      provider: 'gemini', model: 'gemini-test', async analyze() { entered(); await gate; return tags },
    }, () => instant, 20)
    const first = concurrent.analyze('user-ai', 'org-ai', 'product-ai', 'ad-ai')
    await started
    await assert.rejects(concurrent.analyze('user-ai', 'org-ai', 'product-ai', 'ad-ai'), ConflictError)
    release()
    await first

    state = await withVerifiedUserContext(runtimePool, 'user-ai', async (connection) => connection.query<{ status: string; usage_count: number }>(`
      SELECT a.status, u.usage_count FROM creative_ad_analyses a
      JOIN creative_analysis_daily_usage u USING (organization_id)
      WHERE a.competitor_ad_id = 'ad-ai' AND a.status = 'completed'
      ORDER BY a.created_at DESC LIMIT 1`))
    assert.equal(state.rows[0]?.status, 'completed')
    assert.equal(state.rows[0]?.usage_count, 6)
  })
})
