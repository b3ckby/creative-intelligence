import assert from 'node:assert/strict'
import test from 'node:test'

import { OrganizationService } from '../../src/organizations/organization-service.ts'
import { PostgresOrganizationRepository } from '../../src/persistence/postgres-organization-repository.ts'
import { withVerifiedUserContext } from '../../src/persistence/verified-user-context.ts'
import { withRealPostgres } from './helpers/real-postgres.ts'

test('real PostgreSQL migrations enforce runtime RLS', async (t) => {
  await withRealPostgres(async ({ runtimePool, inspectionPool, databaseName, serverVersion }) => {
    await t.test('applies both migrations to an isolated database', async () => {
      assert.match(databaseName, /^creative_intelligence_test_[a-f0-9]+$/)
      assert.match(serverVersion, /^18\.(?:\d+)(?:\s|$)/)
      const tables = await runtimePool.query<{ table_name: string }>(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
      `)
      assert.deepEqual(tables.rows.map(({ table_name }) => table_name), [
        'competitor_ads',
        'competitors',
        'creative_briefs',
        'organization_members',
        'organizations',
        'products',
      ])
      const security = await inspectionPool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(`
        SELECT relname, relrowsecurity, relforcerowsecurity
        FROM pg_class
        WHERE relname = ANY($1::text[])
        ORDER BY relname
      `, [['organizations', 'organization_members', 'products', 'competitors', 'competitor_ads', 'creative_briefs']])
      assert.equal(security.rowCount, 6)
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
      })
      await withVerifiedUserContext(runtimePool, 'user-two', async (connection) => {
        await connection.query(`INSERT INTO products (id, organization_id, name) VALUES ('product-two', 'org-two', 'Two')`)
      })

      await withVerifiedUserContext(runtimePool, 'user-one', async (connection) => {
        const organizationsVisible = await connection.query<{ id: string }>('SELECT id FROM organizations ORDER BY id')
        const productsVisible = await connection.query<{ id: string }>('SELECT id FROM products ORDER BY id')
        assert.deepEqual(organizationsVisible.rows.map(({ id }) => id), ['org-one'])
        assert.deepEqual(productsVisible.rows.map(({ id }) => id), ['product-one'])
      })
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
