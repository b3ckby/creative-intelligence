import assert from 'node:assert/strict'
import test from 'node:test'

import { OrganizationService } from '../../src/organizations/organization-service.ts'
import { PostgresOrganizationRepository } from '../../src/persistence/postgres-organization-repository.ts'
import { withVerifiedUserContext } from '../../src/persistence/verified-user-context.ts'
import { withRealPostgres } from './helpers/real-postgres.ts'

test('real PostgreSQL preserves the final administrator under every mutation', async (t) => {
  await withRealPostgres(async ({ runtimePool, inspectionPool }) => {
    const ids = [
      'org-delete-admin',
      'org-demote-admin',
      'org-change-user',
      'org-change-tenant',
      'org-move-target',
      'org-concurrent',
      'org-cascade',
    ]
    const organizations = new OrganizationService(
      new PostgresOrganizationRepository(runtimePool),
      () => ids.shift() ?? 'unexpected',
      () => new Date('2026-10-26T00:00:00.000Z'),
    )
    for (const [name, user] of [
      ['Delete', 'delete-admin'],
      ['Demote', 'demote-admin'],
      ['User', 'change-user-admin'],
      ['Tenant', 'change-tenant-admin'],
      ['Move target', 'move-target-admin'],
      ['Concurrent', 'admin-a'],
      ['Cascade', 'cascade-admin'],
    ] as const) {
      await organizations.create({ name, actorUserId: user })
    }

    await t.test('rejects direct delete, demotion, user-ID change, and organization-ID change', async () => {
      const mutations = [
        ['delete-admin', `DELETE FROM organization_members WHERE organization_id = 'org-delete-admin' AND user_id = 'delete-admin'`],
        ['demote-admin', `UPDATE organization_members SET role = 'member' WHERE organization_id = 'org-demote-admin' AND user_id = 'demote-admin'`],
        ['change-user-admin', `UPDATE organization_members SET user_id = 'replacement-admin' WHERE organization_id = 'org-change-user' AND user_id = 'change-user-admin'`],
      ] as const
      for (const [userId, sql] of mutations) {
        await assert.rejects(
          withVerifiedUserContext(runtimePool, userId, (connection) => connection.query(sql)),
          /organization must retain an administrator/i,
        )
      }

      await organizations.addMember({
        organizationId: 'org-move-target',
        actorUserId: 'move-target-admin',
        userId: 'change-tenant-admin',
        role: 'admin',
      })
      await assert.rejects(
        withVerifiedUserContext(runtimePool, 'change-tenant-admin', (connection) => connection.query(`
          UPDATE organization_members
          SET organization_id = 'org-move-target'
          WHERE organization_id = 'org-change-tenant' AND user_id = 'change-tenant-admin'
        `)),
        /organization must retain an administrator/i,
      )
    })

    await t.test('serializes concurrent attempts to remove both administrators', async () => {
      await organizations.addMember({
        organizationId: 'org-concurrent',
        actorUserId: 'admin-a',
        userId: 'admin-b',
        role: 'admin',
      })
      const outcomes = await Promise.allSettled([
        withVerifiedUserContext(runtimePool, 'admin-a', (connection) => connection.query(`
          DELETE FROM organization_members WHERE organization_id = 'org-concurrent' AND user_id = 'admin-a'
        `)),
        withVerifiedUserContext(runtimePool, 'admin-b', (connection) => connection.query(`
          DELETE FROM organization_members WHERE organization_id = 'org-concurrent' AND user_id = 'admin-b'
        `)),
      ])
      assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1)
      const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      assert.ok(rejected)
      assert.match(String(rejected.reason), /organization must retain an administrator/i)
      const admins = await inspectionPool.query<{ user_id: string }>(`
        SELECT user_id FROM organization_members
        WHERE organization_id = 'org-concurrent' AND role = 'admin'
      `)
      assert.equal(admins.rowCount, 1)
    })

    await t.test('allows authorized organization deletion to cascade', async () => {
      await withVerifiedUserContext(runtimePool, 'cascade-admin', async (connection) => {
        await connection.query(`INSERT INTO products (id, organization_id, name) VALUES ('cascade-product', 'org-cascade', 'Product')`)
        await connection.query(`
          INSERT INTO competitors (id, organization_id, product_id, name)
          VALUES ('cascade-competitor', 'org-cascade', 'cascade-product', 'Competitor')
        `)
        await connection.query(`
          INSERT INTO competitor_ads (
            id, ingestion_token, organization_id, product_id, competitor_id, provider_name, platform,
            external_id, advertiser_name, started_at, is_active, source_url, first_seen_at, last_seen_at
          ) VALUES (
            'cascade-ad', 'cascade-token', 'org-cascade', 'cascade-product', 'cascade-competitor',
            'manual-meta', 'meta', 'cascade-external', 'Advertiser', now(), true,
            'https://example.test/cascade', now(), now()
          )
        `)
        const removed = await connection.query(`DELETE FROM organizations WHERE id = 'org-cascade' RETURNING id`)
        assert.equal(removed.rowCount, 1)
      })
      for (const table of ['organizations', 'organization_members', 'products', 'competitors', 'competitor_ads']) {
        const remaining = await inspectionPool.query(`SELECT 1 FROM ${table} WHERE ${table === 'organizations' ? 'id' : 'organization_id'} = 'org-cascade'`)
        assert.equal(remaining.rowCount, 0, `${table} should be empty after the cascade`)
      }
    })
  })
})
