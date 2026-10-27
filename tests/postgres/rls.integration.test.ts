import assert from 'node:assert/strict'
import test from 'node:test'

import { ConflictError } from '../../src/domain/errors.ts'
import { OrganizationService } from '../../src/organizations/organization-service.ts'
import { PostgresOrganizationRepository } from '../../src/persistence/postgres-organization-repository.ts'
import { PostgresProviderSyncRateLimiter } from '../../src/persistence/postgres-provider-sync-rate-limiter.ts'
import { withVerifiedUserContext } from '../../src/persistence/verified-user-context.ts'
import { withRealPostgres } from './helpers/real-postgres.ts'

test('real PostgreSQL migrations enforce runtime RLS', async (t) => {
  await withRealPostgres(async ({ runtimePool, inspectionPool, databaseName, serverVersion }) => {
    await t.test('applies all migrations to an isolated database', async () => {
      assert.match(databaseName, /^creative_intelligence_test_[a-f0-9]+$/)
      assert.match(serverVersion, /^18\.(?:\d+)(?:\s|$)/)
      const tables = await inspectionPool.query<{ table_name: string }>(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
      `)
      assert.deepEqual(tables.rows.map(({ table_name }) => table_name), [
        'competitor_ads',
        'competitor_analytics_snapshots',
        'competitors',
        'creative_ad_analyses',
        'creative_analysis_daily_usage',
        'creative_brief_versions',
        'creative_briefs',
        'organization_members',
        'organizations',
        'products',
        'provider_sync_limits',
        'staging_login_attempts',
      ])
      const security = await inspectionPool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(`
        SELECT relname, relrowsecurity, relforcerowsecurity
        FROM pg_class
        WHERE relname = ANY($1::text[])
        ORDER BY relname
      `, [[
        'organizations', 'organization_members', 'products', 'competitors', 'competitor_ads', 'creative_briefs', 'creative_brief_versions',
        'provider_sync_limits', 'creative_ad_analyses', 'creative_analysis_daily_usage', 'competitor_analytics_snapshots',
      ]])
      assert.equal(security.rowCount, 11)
      assert.ok(security.rows.every(({ relrowsecurity, relforcerowsecurity }) => relrowsecurity && relforcerowsecurity))
    })

    await t.test('fails closed when verified user context is missing', async () => {
      const visible = await runtimePool.query('SELECT id FROM organizations')
      assert.equal(visible.rowCount, 0)
      await assert.rejects(
        runtimePool.query(`INSERT INTO organizations (id, name) VALUES ('missing-context', 'Denied')`),
        /row-level security policy/i,
      )
    })

    await t.test('isolates tenants for unrestricted runtime queries', async () => {
      const ids = ['org-one', 'org-two']
      const organizations = new OrganizationService(
        new PostgresOrganizationRepository(runtimePool),
        () => ids.shift() ?? 'unexpected',
        () => new Date('2026-10-26T00:00:00.000Z'),
      )
      await organizations.create({ name: 'One', actorUserId: 'user-one' })
      await organizations.create({ name: 'Two', actorUserId: 'user-two' })
      await withVerifiedUserContext(runtimePool, 'user-one', async (connection) => {
        await connection.query(`INSERT INTO products (id, organization_id, name) VALUES ('product-one', 'org-one', 'One')`)
        await connection.query(`INSERT INTO creative_briefs (id, organization_id, product_id, title, status, hook, dimensions)
          VALUES ('brief-one', 'org-one', 'product-one', 'One', 'draft', '', '{"audience":"a","market":"m","angle":"x","format":"f"}')`)
        await connection.query(`INSERT INTO creative_brief_versions
          (organization_id, brief_id, version, product_id, title, status, hook, dimensions, brief_created_at, changed_by, changed_at)
          VALUES ('org-one', 'brief-one', 1, 'product-one', 'One', 'draft', '', '{"audience":"a","market":"m","angle":"x","format":"f"}', now(), 'user-one', now())`)
        await connection.query(`INSERT INTO competitors (id, organization_id, product_id, name) VALUES ('competitor-one', 'org-one', 'product-one', 'One')`)
        await connection.query(`INSERT INTO competitor_ads
          (id, ingestion_token, organization_id, product_id, competitor_id, provider_name, platform, external_id,
           advertiser_name, body, started_at, is_active, source_url, first_seen_at, last_seen_at)
          VALUES ('ad-one', 'token-one', 'org-one', 'product-one', 'competitor-one', 'provider', 'meta', 'external-one',
                  'Advertiser', '', now(), true, 'https://example.test/one', now(), now())`)
        await connection.query(`INSERT INTO creative_ad_analyses
          (organization_id, product_id, competitor_ad_id, analysis_version, model_provider, model_name, prompt_version,
           input_fingerprint, status, claim_token, claim_expires_at)
          VALUES ('org-one', 'product-one', 'ad-one', 'v1', 'provider', 'model', 'prompt', $1, 'pending', $1, now() + interval '1 hour')`, ['a'.repeat(64)])
        await connection.query(`INSERT INTO creative_analysis_daily_usage (organization_id, usage_date, usage_count)
          VALUES ('org-one', current_date, 1)`)
        await connection.query(`INSERT INTO competitor_analytics_snapshots
          (organization_id, product_id, competitor_id, snapshot_date, active_ad_count, new_ads_last_7d, new_ads_prev_7d,
           launch_velocity_delta, avg_days_active, long_runner_count, image_count, video_count, carousel_count, text_count,
           scale_score, newly_tracked, captured_at)
          VALUES ('org-one', 'product-one', 'competitor-one', current_date, 1, 1, 0, 1, 1, 0, 1, 0, 0, 0, 10, false, now())`)
      })
      await withVerifiedUserContext(runtimePool, 'user-two', async (connection) => {
        await connection.query(`INSERT INTO products (id, organization_id, name) VALUES ('product-two', 'org-two', 'Two')`)
        await connection.query(`INSERT INTO creative_briefs (id, organization_id, product_id, title, status, hook, dimensions)
          VALUES ('brief-two', 'org-two', 'product-two', 'Two', 'draft', '', '{"audience":"a","market":"m","angle":"x","format":"f"}')`)
        await connection.query(`INSERT INTO creative_brief_versions
          (organization_id, brief_id, version, product_id, title, status, hook, dimensions, brief_created_at, changed_by, changed_at)
          VALUES ('org-two', 'brief-two', 1, 'product-two', 'Two', 'draft', '', '{"audience":"a","market":"m","angle":"x","format":"f"}', now(), 'user-two', now())`)
        await connection.query(`INSERT INTO competitors (id, organization_id, product_id, name) VALUES ('competitor-two', 'org-two', 'product-two', 'Two')`)
        await connection.query(`INSERT INTO competitor_ads
          (id, ingestion_token, organization_id, product_id, competitor_id, provider_name, platform, external_id,
           advertiser_name, body, started_at, is_active, source_url, first_seen_at, last_seen_at)
          VALUES ('ad-two', 'token-two', 'org-two', 'product-two', 'competitor-two', 'provider', 'meta', 'external-two',
                  'Advertiser', '', now(), true, 'https://example.test/two', now(), now())`)
        await connection.query(`INSERT INTO creative_ad_analyses
          (organization_id, product_id, competitor_ad_id, analysis_version, model_provider, model_name, prompt_version,
           input_fingerprint, status, claim_token, claim_expires_at)
          VALUES ('org-two', 'product-two', 'ad-two', 'v1', 'provider', 'model', 'prompt', $1, 'pending', $1, now() + interval '1 hour')`, ['b'.repeat(64)])
        await connection.query(`INSERT INTO creative_analysis_daily_usage (organization_id, usage_date, usage_count)
          VALUES ('org-two', current_date, 1)`)
        await connection.query(`INSERT INTO competitor_analytics_snapshots
          (organization_id, product_id, competitor_id, snapshot_date, active_ad_count, new_ads_last_7d, new_ads_prev_7d,
           launch_velocity_delta, avg_days_active, long_runner_count, image_count, video_count, carousel_count, text_count,
           scale_score, newly_tracked, captured_at)
          VALUES ('org-two', 'product-two', 'competitor-two', current_date, 1, 1, 0, 1, 1, 0, 1, 0, 0, 0, 10, false, now())`)
      })

      await withVerifiedUserContext(runtimePool, 'user-one', async (connection) => {
        const organizationsVisible = await connection.query<{ id: string }>('SELECT id FROM organizations ORDER BY id')
        const productsVisible = await connection.query<{ id: string }>('SELECT id FROM products ORDER BY id')
        const analysesVisible = await connection.query<{ competitor_ad_id: string }>('SELECT competitor_ad_id FROM creative_ad_analyses ORDER BY competitor_ad_id')
        const usageVisible = await connection.query<{ organization_id: string }>('SELECT organization_id FROM creative_analysis_daily_usage ORDER BY organization_id')
        const snapshotsVisible = await connection.query<{ competitor_id: string }>('SELECT competitor_id FROM competitor_analytics_snapshots ORDER BY competitor_id')
        const briefVersionsVisible = await connection.query<{ brief_id: string }>('SELECT brief_id FROM creative_brief_versions ORDER BY brief_id')
        assert.deepEqual(organizationsVisible.rows.map(({ id }) => id), ['org-one'])
        assert.deepEqual(productsVisible.rows.map(({ id }) => id), ['product-one'])
        assert.deepEqual(analysesVisible.rows.map(({ competitor_ad_id }) => competitor_ad_id), ['ad-one'])
        assert.deepEqual(usageVisible.rows.map(({ organization_id }) => organization_id), ['org-one'])
        assert.deepEqual(snapshotsVisible.rows.map(({ competitor_id }) => competitor_id), ['competitor-one'])
        assert.deepEqual(briefVersionsVisible.rows.map(({ brief_id }) => brief_id), ['brief-one'])
      })
    })

    await t.test('denies outsiders access to analysis, usage, and analytics snapshot tables', async () => {
      await withVerifiedUserContext(runtimePool, 'outsider', async (connection) => {
        for (const table of ['creative_ad_analyses', 'creative_analysis_daily_usage', 'competitor_analytics_snapshots', 'creative_brief_versions']) {
          const visible = await connection.query(`SELECT * FROM ${table}`)
          assert.equal(visible.rowCount, 0, table)
        }
      })
      await assert.rejects(
        withVerifiedUserContext(runtimePool, 'outsider', async (connection) => connection.query(
          `INSERT INTO creative_analysis_daily_usage (organization_id, usage_date, usage_count)
           VALUES ('org-one', current_date + 1, 1)`,
        )),
        /row-level security policy/i,
      )
      await assert.rejects(
        withVerifiedUserContext(runtimePool, 'outsider', async (connection) => connection.query(
          `INSERT INTO competitor_analytics_snapshots
           (organization_id, product_id, competitor_id, snapshot_date, active_ad_count, new_ads_last_7d, new_ads_prev_7d,
            launch_velocity_delta, avg_days_active, long_runner_count, image_count, video_count, carousel_count, text_count,
            scale_score, newly_tracked, captured_at)
           VALUES ('org-one', 'product-one', 'competitor-one', current_date + 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, false, now())`,
        )),
        /row-level security policy/i,
      )
      await assert.rejects(
        withVerifiedUserContext(runtimePool, 'outsider', async (connection) => connection.query(
          `INSERT INTO creative_ad_analyses
           (organization_id, product_id, competitor_ad_id, analysis_version, model_provider, model_name, prompt_version,
            input_fingerprint, status, claim_token, claim_expires_at)
           VALUES ('org-one', 'product-one', 'ad-one', 'outsider', 'provider', 'model', 'prompt', $1, 'pending', $1, now() + interval '1 hour')`,
          ['c'.repeat(64)],
        )),
        /row-level security policy/i,
      )
      await assert.rejects(
        withVerifiedUserContext(runtimePool, 'outsider', async (connection) => connection.query(
          `INSERT INTO creative_brief_versions
           (organization_id, brief_id, version, product_id, title, status, hook, dimensions, brief_created_at, changed_by, changed_at)
           VALUES ('org-one', 'brief-one', 2, 'product-one', 'Denied', 'draft', '', '{}', now(), 'outsider', now())`,
        )),
        /row-level security policy/i,
      )
    })

    await t.test('keeps brief history immutable for runtime users', async () => {
      await assert.rejects(
        withVerifiedUserContext(runtimePool, 'user-one', async (connection) => connection.query(
          `UPDATE creative_brief_versions SET title = 'Changed' WHERE organization_id = 'org-one' AND brief_id = 'brief-one'`,
        )),
        /permission denied/i,
      )
      await assert.rejects(
        withVerifiedUserContext(runtimePool, 'user-one', async (connection) => connection.query(
          `DELETE FROM creative_brief_versions WHERE organization_id = 'org-one' AND brief_id = 'brief-one'`,
        )),
        /permission denied/i,
      )
    })

    await t.test('allows an ordinary organization member to claim a provider cooldown', async () => {
      await withVerifiedUserContext(runtimePool, 'user-one', async (connection) => {
        await connection.query(
          `INSERT INTO organization_members (organization_id, user_id, role)
           VALUES ('org-one', 'member-one', 'member')`,
        )
      })
      const limiter = new PostgresProviderSyncRateLimiter(runtimePool)
      await limiter.claim('member-one', 'org-one', 'member-provider')
    })

    await t.test('uses the database clock for the cooldown timestamp', async () => {
      const limiter = new PostgresProviderSyncRateLimiter(runtimePool)
      const before = await runtimePool.query<{ current_time: Date }>(`SELECT clock_timestamp() AS current_time`)
      await limiter.claim('user-one', 'org-one', 'clock-provider')
      const stored = await withVerifiedUserContext(runtimePool, 'user-one', async (connection) => connection.query<{ last_started_at: Date }>(
        `SELECT last_started_at FROM provider_sync_limits
         WHERE organization_id = 'org-one' AND provider_name = 'clock-provider'`,
      ))
      const after = await runtimePool.query<{ current_time: Date }>(`SELECT clock_timestamp() AS current_time`)
      const storedTime = stored.rows[0]?.last_started_at.getTime()
      assert.ok(storedTime !== undefined)
      assert.ok(storedTime >= (before.rows[0]?.current_time.getTime() ?? Number.POSITIVE_INFINITY))
      assert.ok(storedTime <= (after.rows[0]?.current_time.getTime() ?? Number.NEGATIVE_INFINITY))
      await assert.rejects(limiter.claim('user-one', 'org-one', 'clock-provider'), ConflictError)
    })

    await t.test('serializes paid-provider cooldown claims across service instances', async () => {
      const first = new PostgresProviderSyncRateLimiter(runtimePool)
      const second = new PostgresProviderSyncRateLimiter(runtimePool)
      const results = await Promise.allSettled([
        first.claim('user-one', 'org-one', 'apify-meta-ads'),
        second.claim('user-one', 'org-one', 'apify-meta-ads'),
      ])
      assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1)
      const rejected = results.find(({ status }) => status === 'rejected')
      assert.ok(rejected && rejected.status === 'rejected')
      assert.ok(rejected.reason instanceof ConflictError)
    })

    await t.test('clears verified identity when the transaction ends', async () => {
      await withVerifiedUserContext(runtimePool, 'user-one', async (connection) => {
        const inside = await connection.query<{ user_id: string }>(
          `SELECT current_setting('app.user_id', true) AS user_id`,
        )
        assert.equal(inside.rows[0]?.user_id, 'user-one')
      })
      const outside = await runtimePool.query<{ user_id: string | null }>(
        `SELECT NULLIF(current_setting('app.user_id', true), '') AS user_id`,
      )
      assert.equal(outside.rows[0]?.user_id, null)
    })

    await t.test('rejects a configured non-local provisioner before connecting', async () => {
      const key = 'CREATIVE_INTELLIGENCE_TEST_PROVISIONER_URL'
      const previous = process.env[key]
      process.env[key] = 'postgresql://provisioner@example.com/postgres'
      try {
        await assert.rejects(withRealPostgres(async () => undefined), /numeric loopback address or local Unix socket/i)
      } finally {
        if (previous === undefined) delete process.env[key]
        else process.env[key] = previous
      }
    })

    await t.test('preserves pre-existing application roles when preflight rejects the cluster', async () => {
      await assert.rejects(withRealPostgres(async () => undefined), /existing application roles/i)
      const roles = await inspectionPool.query<{ rolname: string }>(`
        SELECT rolname FROM pg_roles
        WHERE rolname = ANY($1::text[])
        ORDER BY rolname
      `, [['creative_intelligence_rls_owner', 'creative_intelligence_runtime']])
      assert.deepEqual(roles.rows.map(({ rolname }) => rolname), [
        'creative_intelligence_rls_owner',
        'creative_intelligence_runtime',
      ])
    })
  })
})
