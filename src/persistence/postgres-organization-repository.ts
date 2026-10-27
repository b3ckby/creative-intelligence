import type { Organization, OrganizationRepository, OrganizationRole } from '../organizations/organization-service.ts'
import { AuthorizationError, ConflictError } from '../domain/errors.ts'
import { withVerifiedUserContext } from './verified-user-context.ts'

interface QueryResult<Row> {
  rows: Row[]
  rowCount: number | null
}

export interface SqlConnection {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
  release(error?: Error): void
}

export interface SqlPool {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
  connect(): Promise<SqlConnection>
}

export class PostgresOrganizationRepository implements OrganizationRepository {
  constructor(private readonly pool: SqlPool) {}

  async createWithAdmin(organization: Organization, adminUserId: string): Promise<void> {
    await withVerifiedUserContext(this.pool, adminUserId, async (client) => {
      await client.query(
        `INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)`,
        [organization.id, organization.name, organization.createdAt],
      )
      await client.query(
        `INSERT INTO organization_members (organization_id, user_id, role, created_at)
         VALUES ($1, $2, 'admin', $3)`,
        [organization.id, adminUserId, organization.createdAt],
      )
    })
  }

  async findRole(organizationId: string, userId: string): Promise<OrganizationRole | undefined> {
    return withVerifiedUserContext(this.pool, userId, async (client) => {
      const result = await client.query<{ role: OrganizationRole }>(
        `SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
        [organizationId, userId],
      )
      return result.rows[0]?.role
    })
  }

  async saveMemberAsAdmin(
    organizationId: string,
    actorUserId: string,
    userId: string,
    role: OrganizationRole,
    createdAt: string,
  ): Promise<void> {
    await this.withLockedOrganization(organizationId, actorUserId, async (client) => {
      await requireAdmin(client, organizationId, actorUserId)
      await preventFinalAdminRemoval(client, organizationId, userId, role)
      await client.query(
        `INSERT INTO organization_members (organization_id, user_id, role, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (organization_id, user_id)
         DO UPDATE SET role = EXCLUDED.role`,
        [organizationId, userId, role, createdAt],
      )
    })
  }

  async removeMemberAsAdmin(organizationId: string, actorUserId: string, userId: string): Promise<void> {
    await this.withLockedOrganization(organizationId, actorUserId, async (client) => {
      await requireAdmin(client, organizationId, actorUserId)
      await preventFinalAdminRemoval(client, organizationId, userId, undefined)
      await client.query(
        `DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
        [organizationId, userId],
      )
    })
  }

  private async withLockedOrganization(
    organizationId: string,
    actorUserId: string,
    operation: (client: SqlConnection) => Promise<void>,
  ): Promise<void> {
    await withVerifiedUserContext(this.pool, actorUserId, async (client) => {
      await client.query(`SELECT id FROM organizations WHERE id = $1 FOR UPDATE`, [organizationId])
      await operation(client)
    })
  }
}

async function requireAdmin(client: SqlConnection, organizationId: string, actorUserId: string): Promise<void> {
  const actor = await client.query<{ role: OrganizationRole }>(
    `SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, actorUserId],
  )
  if (actor.rows[0]?.role !== 'admin') {
    throw new AuthorizationError('Organization administrator role is required')
  }
}

async function preventFinalAdminRemoval(
  client: SqlConnection,
  organizationId: string,
  userId: string,
  replacementRole: OrganizationRole | undefined,
): Promise<void> {
  if (replacementRole === 'admin') return
  const target = await client.query<{ role: OrganizationRole }>(
    `SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, userId],
  )
  if (target.rows[0]?.role !== 'admin') return
  const otherAdmin = await client.query<{ has_other_admin: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM organization_members
       WHERE organization_id = $1 AND role = 'admin' AND user_id <> $2
     ) AS has_other_admin`,
    [organizationId, userId],
  )
  if (otherAdmin.rows[0]?.has_other_admin !== true) {
    throw new ConflictError('Cannot remove or demote the final administrator')
  }
}
