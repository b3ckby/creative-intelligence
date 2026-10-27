import assert from 'node:assert/strict'
import test from 'node:test'

import type { ManualMetaAdRecord } from '../../src/ad-ingestion/manual-meta-ads-provider.ts'
import { OrganizationService } from '../../src/organizations/organization-service.ts'
import { PostgresManualAdImportService } from '../../src/persistence/postgres-manual-ad-import-service.ts'
import { PostgresOrganizationRepository } from '../../src/persistence/postgres-organization-repository.ts'
import { withVerifiedUserContext } from '../../src/persistence/verified-user-context.ts'
import { withRealPostgres } from './helpers/real-postgres.ts'

function record(externalId: string): ManualMetaAdRecord {
  return {
    externalId,
    advertiserName: 'Competitor',
    body: 'Copy',
    startedAt: '2026-10-01T00:00:00.000Z',
    isActive: true,
    mediaUrls: [],
    sourceUrl: `https://example.test/ads/${externalId}`,
  }
}

const firstContext = { organizationId: 'org-imports', productId: 'product-imports', competitorId: 'competitor-one' }
const secondContext = { organizationId: 'org-imports', productId: 'product-imports', competitorId: 'competitor-two' }

test('real PostgreSQL manual imports preserve provider ownership and idempotency', async (t) => {
  await withRealPostgres(async ({ runtimePool, inspectionPool }) => {
    const organizations = new OrganizationService(
      new PostgresOrganizationRepository(runtimePool),
      () => 'org-imports',
      () => new Date('2026-10-26T00:00:00.000Z'),
    )
    await organizations.create({ name: 'Imports', actorUserId: 'import-admin' })
    await withVerifiedUserContext(runtimePool, 'import-admin', async (connection) => {
      await connection.query(`INSERT INTO products (id, organization_id, name) VALUES ('product-imports', 'org-imports', 'Product')`)
      await connection.query(`
        INSERT INTO competitors (id, organization_id, product_id, name) VALUES
          ('competitor-one', 'org-imports', 'product-imports', 'One'),
          ('competitor-two', 'org-imports', 'product-imports', 'Two')
      `)
    })

    await t.test('classifies an exact generated-ID reimport as a duplicate', async () => {
      const imports = new PostgresManualAdImportService(
        runtimePool,
        () => 'ad-exact-id',
        () => new Date('2026-10-26T00:00:00.000Z'),
      )
      assert.deepEqual(await imports.import('import-admin', firstContext, [record('meta-exact')]), { inserted: 1, duplicates: 0 })
      assert.deepEqual(await imports.import('import-admin', firstContext, [record('meta-exact')]), { inserted: 0, duplicates: 1 })
    })

    await t.test('makes concurrent imports for the same owner idempotent', async () => {
      const ids = ['ad-concurrent-one', 'ad-concurrent-two']
      const imports = new PostgresManualAdImportService(
        runtimePool,
        () => ids.shift() ?? 'unexpected',
        () => new Date('2026-10-26T00:00:00.000Z'),
      )
      const outcomes = await Promise.all([
        imports.import('import-admin', firstContext, [record('meta-concurrent-owner')]),
        imports.import('import-admin', firstContext, [record('meta-concurrent-owner')]),
      ])
      assert.deepEqual(outcomes.sort((left, right) => left.inserted - right.inserted), [
        { inserted: 0, duplicates: 1 },
        { inserted: 1, duplicates: 0 },
      ])
      const stored = await inspectionPool.query(
        `SELECT id FROM competitor_ads WHERE organization_id = 'org-imports' AND external_id = 'meta-concurrent-owner'`,
      )
      assert.equal(stored.rowCount, 1)
    })

    await t.test('rejects concurrent reuse by conflicting owners', async () => {
      const ids = ['ad-owner-one', 'ad-owner-two']
      const imports = new PostgresManualAdImportService(
        runtimePool,
        () => ids.shift() ?? 'unexpected',
        () => new Date('2026-10-26T00:00:00.000Z'),
      )
      const outcomes = await Promise.allSettled([
        imports.import('import-admin', firstContext, [record('meta-conflicting-owner')]),
        imports.import('import-admin', secondContext, [record('meta-conflicting-owner')]),
      ])
      assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1)
      const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      assert.ok(rejected)
      assert.match(String(rejected.reason), /already belongs to another product or competitor/i)
      const stored = await inspectionPool.query<{ competitor_id: string }>(
        `SELECT competitor_id FROM competitor_ads WHERE organization_id = 'org-imports' AND external_id = 'meta-conflicting-owner'`,
      )
      assert.equal(stored.rowCount, 1)
      assert.ok(['competitor-one', 'competitor-two'].includes(stored.rows[0]?.competitor_id ?? ''))
    })
  })
})
