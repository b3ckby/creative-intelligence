import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { DataType, newDb } from 'pg-mem'
import { OrganizationService } from '../src/organizations/organization-service.ts'
import { PostgresOrganizationRepository } from '../src/persistence/postgres-organization-repository.ts'

async function database() {
  const db = newDb()
  db.public.registerFunction({ name: 'length', args: [DataType.text], returns: DataType.integer, implementation: (value: string) => value.length })
  db.public.registerFunction({ name: 'trim', args: [DataType.text], returns: DataType.text, implementation: (value: string) => value.trim() })
  db.public.registerFunction({ name: 'set_config', args: [DataType.text, DataType.text, DataType.bool], returns: DataType.text, implementation: (_key: string, value: string) => value })
  const { Pool } = db.adapters.createPg()
  const pool = new Pool()
  const migration = await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8')
  await pool.query(migration)
  return pool
}

test('organization creator becomes admin and can add a member', async () => {
  const pool = await database()
  const ids = ['org-1']
  const organizations = new OrganizationService(
    new PostgresOrganizationRepository(pool),
    () => ids.shift() ?? 'unexpected',
    () => new Date('2026-10-26T00:00:00.000Z'),
  )

  const organization = await organizations.create({ name: 'Creative Team', actorUserId: 'user-admin' })
  assert.equal(organization.id, 'org-1')
  assert.equal(await organizations.roleFor('org-1', 'user-admin'), 'admin')

  await organizations.addMember({
    organizationId: 'org-1',
    actorUserId: 'user-admin',
    userId: 'user-member',
    role: 'member',
  })
  assert.equal(await organizations.roleFor('org-1', 'user-member'), 'member')

  await pool.end()
})

test('member cannot grant roles or access another organization', async () => {
  const pool = await database()
  const ids = ['org-1', 'org-2']
  const organizations = new OrganizationService(
    new PostgresOrganizationRepository(pool),
    () => ids.shift() ?? 'unexpected',
    () => new Date('2026-10-26T00:00:00.000Z'),
  )
  await organizations.create({ name: 'One', actorUserId: 'admin-1' })
  await organizations.create({ name: 'Two', actorUserId: 'admin-2' })
  await organizations.addMember({ organizationId: 'org-1', actorUserId: 'admin-1', userId: 'member-1', role: 'member' })

  await assert.rejects(() => organizations.addMember({
    organizationId: 'org-1', actorUserId: 'member-1', userId: 'attacker', role: 'admin',
  }), /administrator role is required/i)
  await assert.rejects(() => organizations.requireMembership('org-2', 'member-1'), /membership is required/i)
  await pool.end()
})

test('cannot demote or remove the final organization administrator', async () => {
  const pool = await database()
  const organizations = new OrganizationService(
    new PostgresOrganizationRepository(pool),
    () => 'org-1',
    () => new Date('2026-10-26T00:00:00.000Z'),
  )
  await organizations.create({ name: 'One', actorUserId: 'admin-1' })

  await assert.rejects(() => organizations.addMember({
    organizationId: 'org-1', actorUserId: 'admin-1', userId: 'admin-1', role: 'member',
  }), /final administrator/i)
  await assert.rejects(
    () => organizations.removeMember({ organizationId: 'org-1', actorUserId: 'admin-1', userId: 'admin-1' }),
    /final administrator/i,
  )
  assert.equal(await organizations.roleFor('org-1', 'admin-1'), 'admin')

  await pool.end()
})

test('admin membership mutations recheck authorization inside the locked transaction', async () => {
  const pool = await database()
  const organizations = new OrganizationService(
    new PostgresOrganizationRepository(pool),
    () => 'org-1',
    () => new Date('2026-10-26T00:00:00.000Z'),
  )
  await organizations.create({ name: 'One', actorUserId: 'admin-1' })
  await organizations.addMember({ organizationId: 'org-1', actorUserId: 'admin-1', userId: 'admin-2', role: 'admin' })
  await organizations.addMember({ organizationId: 'org-1', actorUserId: 'admin-1', userId: 'admin-1', role: 'member' })

  await assert.rejects(() => organizations.addMember({
    organizationId: 'org-1', actorUserId: 'admin-1', userId: 'attacker', role: 'admin',
  }), /administrator role is required/i)
  assert.equal(await organizations.roleFor('org-1', 'attacker'), undefined)

  await pool.end()
})
