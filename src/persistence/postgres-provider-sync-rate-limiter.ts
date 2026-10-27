import { randomUUID } from 'node:crypto'

import { ConflictError } from '../domain/errors.ts'
import { validateIdentifier } from '../domain/identifiers.ts'
import type { SqlPool } from './postgres-organization-repository.ts'
import { withVerifiedUserContext } from './verified-user-context.ts'

export class PostgresProviderSyncRateLimiter {
  constructor(private readonly pool: SqlPool) {}

  async claim(verifiedUserId: string, organizationIdInput: string, providerNameInput: string): Promise<void> {
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const providerName = validateIdentifier(providerNameInput, 'Provider name', 64)

    const claimToken = randomUUID()
    await withVerifiedUserContext(this.pool, verifiedUserId, async (client) => {
      await client.query(
        `INSERT INTO provider_sync_limits (organization_id, provider_name, claim_token, last_started_at)
         VALUES ($1, $2, $3, clock_timestamp())
         ON CONFLICT (organization_id, provider_name) DO NOTHING`,
        [organizationId, providerName, claimToken],
      )

      const current = await client.query<{ claim_token: string }>(
        `SELECT claim_token FROM provider_sync_limits
         WHERE organization_id = $1 AND provider_name = $2
         FOR UPDATE`,
        [organizationId, providerName],
      )
      if (current.rows[0]?.claim_token === claimToken) return

      const refreshed = await client.query(
        `UPDATE provider_sync_limits
         SET claim_token = $3, last_started_at = clock_timestamp()
         WHERE organization_id = $1
           AND provider_name = $2
           AND last_started_at <= clock_timestamp() - INTERVAL '60 seconds'
         RETURNING organization_id`,
        [organizationId, providerName, claimToken],
      )
      if (refreshed.rows.length !== 1) throw new ConflictError('Provider synchronization cooldown is active')
    })
  }
}
