import assert from 'node:assert/strict'
import test from 'node:test'

import { PostgresOrganizationRepository, type SqlConnection, type SqlPool } from '../src/persistence/postgres-organization-repository.ts'

test('organization member mutations use bounded actor target and admin-existence queries', async () => {
  const statements: Array<{ text: string; values?: unknown[] }> = []
  const connection: SqlConnection = {
    async query<Row extends Record<string, unknown>>(text: string, values?: unknown[]) {
      statements.push({ text, ...(values === undefined ? {} : { values }) })
      const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase()
      if (normalized.startsWith('select role from organization_members')) {
        const userId = values?.[1]
        return { rows: [{ role: userId === 'actor' || userId === 'target' ? 'admin' : 'member' }] as unknown as Row[], rowCount: 1 }
      }
      if (normalized.startsWith('select user_id, role from organization_members')) {
        return { rows: [
          { user_id: 'actor', role: 'admin' },
          { user_id: 'target', role: 'admin' },
          { user_id: 'other', role: 'admin' },
        ] as unknown as Row[], rowCount: 3 }
      }
      if (normalized.includes('select exists') || normalized.includes('count(')) {
        return { rows: [{ has_other_admin: true }] as unknown as Row[], rowCount: 1 }
      }
      return { rows: [] as Row[], rowCount: normalized.startsWith('select id from organizations') ? 1 : 0 }
    },
    release() {},
  }
  const pool: SqlPool = {
    connect: async () => connection,
    query: connection.query.bind(connection),
  }
  const repository = new PostgresOrganizationRepository(pool)

  await repository.saveMemberAsAdmin('org-1', 'actor', 'target', 'member', '2026-10-26T00:00:00.000Z')
  await repository.removeMemberAsAdmin('org-1', 'actor', 'target')

  const memberReads = statements
    .map(({ text }) => text.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter((text) => text.startsWith('select') && text.includes('from organization_members'))
  assert.ok(memberReads.length >= 2)
  for (const sql of memberReads) {
    assert.ok(
      sql.includes('user_id =') || sql.includes('select exists') || sql.includes('count('),
      `unbounded organization member read: ${sql}`,
    )
  }
  assert.ok(memberReads.some((sql) => sql.includes('select exists') || sql.includes('count(')))
  assert.equal(statements.filter(({ text }) => /from\s+organization_members/i.test(text) && !/user_id\s*=|exists|count\s*\(/i.test(text)).length, 0)
})
