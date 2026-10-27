import { ValidationError } from '../domain/errors.ts'
import type { SqlConnection } from './postgres-organization-repository.ts'

/**
 * Verifies authorization evidence and product existence in the same
 * repeatable-read snapshot used by the dependent brief query.
 */
export async function requireBriefReadContext(
  client: SqlConnection,
  verifiedUserId: string,
  organizationId: string,
  productId: string,
  includeArchived = false,
): Promise<{ id: string; organizationId: string }> {
  const membership = await client.query<{ organization_id: string }>(
    `SELECT organization_id
     FROM organization_members
     WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, verifiedUserId],
  )
  if (!membership.rows[0]) throw new ValidationError('Product does not belong to organization')

  const products = await client.query<{ id: string; organization_id: string }>(
    `SELECT id, organization_id
     FROM products
     WHERE organization_id = $1 AND id = $2
       ${includeArchived ? '' : 'AND archived_at IS NULL'}`,
    [organizationId, productId],
  )
  const row = products.rows[0]
  if (!row) throw new ValidationError('Product does not belong to organization')
  return { id: row.id, organizationId: row.organization_id }
}
