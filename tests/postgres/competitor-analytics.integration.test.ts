import assert from 'node:assert/strict'
import test from 'node:test'

import { NotFoundError } from '../../src/domain/errors.ts'
import { OrganizationService } from '../../src/organizations/organization-service.ts'
import { PostgresCompetitorAnalyticsService } from '../../src/persistence/postgres-competitor-analytics-service.ts'
import { PostgresOrganizationRepository } from '../../src/persistence/postgres-organization-repository.ts'
import { withVerifiedUserContext } from '../../src/persistence/verified-user-context.ts'
import { withRealPostgres } from './helpers/real-postgres.ts'

test('real PostgreSQL analytics history and comparison read durable snapshots through tenant RLS', async () => {
  await withRealPostgres(async ({ runtimePool }) => {
    const organizations = new OrganizationService(new PostgresOrganizationRepository(runtimePool), (() => {
      const ids = ['org-analytics-read', 'org-analytics-other']; return () => ids.shift()!
    })(), () => new Date('2026-10-28T12:00:00.000Z'))
    await organizations.create({ name: 'Analytics read org', actorUserId: 'analytics-reader' })
    await organizations.create({ name: 'Other org', actorUserId: 'analytics-outsider' })
    await withVerifiedUserContext(runtimePool, 'analytics-reader', async (connection) => {
      await connection.query(`INSERT INTO products (id,organization_id,name) VALUES ('product-analytics-read','org-analytics-read','Product')`)
      await connection.query(`INSERT INTO competitors (id,organization_id,product_id,name) VALUES
        ('competitor-a','org-analytics-read','product-analytics-read','Alpha'),
        ('competitor-b','org-analytics-read','product-analytics-read','Beta')`)
      await connection.query(`INSERT INTO competitor_analytics_snapshots
        (organization_id,product_id,competitor_id,snapshot_date,active_ad_count,new_ads_last_7d,new_ads_prev_7d,
         launch_velocity_delta,avg_days_active,long_runner_count,image_count,video_count,carousel_count,text_count,
         impression_weight,scale_score,newly_tracked,captured_at)
        VALUES
        ('org-analytics-read','product-analytics-read','competitor-a',(clock_timestamp() AT TIME ZONE 'UTC')::date-7,8,2,1,1,12.5,2,3,3,1,1,NULL,70,false,((clock_timestamp() AT TIME ZONE 'UTC')::date-7)::timestamptz),
        ('org-analytics-read','product-analytics-read','competitor-a',(clock_timestamp() AT TIME ZONE 'UTC')::date,12,5,2,3,18.5,4,5,6,1,0,1250,88,false,((clock_timestamp() AT TIME ZONE 'UTC')::date)::timestamptz),
        ('org-analytics-read','product-analytics-read','competitor-b',(clock_timestamp() AT TIME ZONE 'UTC')::date,3,1,1,0,4,0,1,2,0,0,NULL,40,false,((clock_timestamp() AT TIME ZONE 'UTC')::date)::timestamptz)`)
    })

    const analytics = new PostgresCompetitorAnalyticsService(runtimePool)
    const history = await analytics.history('analytics-reader', 'org-analytics-read', 'product-analytics-read', 'competitor-a', 7)
    assert.equal(history.items.length, 1)
    assert.equal(history.trend7d?.activeAdCountChange, 4)
    assert.equal(history.items[0]?.impressionWeight, 1250)

    const comparison = await analytics.compare('analytics-reader', 'org-analytics-read', 'product-analytics-read', ['competitor-b', 'competitor-a'])
    assert.deepEqual(comparison.items.map(({ competitor }) => competitor.id), ['competitor-b', 'competitor-a'])
    assert.equal(comparison.items[0]?.latest?.activeAdCount, 3)
    assert.equal(comparison.items[1]?.trend7d?.scaleScoreChange, 18)

    await assert.rejects(
      analytics.history('analytics-outsider', 'org-analytics-read', 'product-analytics-read', 'competitor-a', 30),
      NotFoundError,
    )
    await assert.rejects(
      analytics.compare('analytics-reader', 'org-analytics-read', 'product-analytics-read', ['competitor-a', 'missing-competitor']),
      NotFoundError,
    )
  })
})
