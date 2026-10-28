import { AuthorizationError, NotFoundError, ValidationError } from '../domain/errors.ts'
import type { SqlPool } from './postgres-organization-repository.ts'
import { withVerifiedUserContext, withVerifiedUserReadContext } from './verified-user-context.ts'

export interface AdSyncSchedule {
  id: string
  organizationId: string
  productId: string
  competitorId: string
  providerName: 'apify-meta-ads'
  actorUserId: string
  enabled: boolean
  intervalSeconds: number
  nextRunAt: string
  lastRunAt: string | null
}

type Connection = { query: SqlPool['query'] }

export class PostgresAdSyncScheduleService {
  constructor(private readonly pool: SqlPool, private readonly createId: () => string) {}

  async get(actor: string, organizationId: string, productId: string, competitorId: string): Promise<AdSyncSchedule> {
    return withVerifiedUserReadContext(this.pool, actor, async (connection) => {
      await requireAdmin(connection, actor, organizationId)
      const result = await connection.query<Record<string, unknown>>(
        `SELECT id,organization_id,product_id,competitor_id,provider_name,actor_user_id,enabled,interval_seconds,next_run_at,last_run_at
         FROM competitor_ad_sync_schedules WHERE organization_id=$1 AND product_id=$2 AND competitor_id=$3`,
        [organizationId, productId, competitorId],
      )
      if (result.rowCount !== 1) throw new NotFoundError()
      return decode(result.rows[0]!)
    })
  }

  async upsert(actor: string, organizationId: string, productId: string, competitorId: string, intervalSeconds: number, enabled: boolean): Promise<AdSyncSchedule> {
    validateInterval(intervalSeconds)
    return withVerifiedUserContext(this.pool, actor, async (connection) => {
      await requireAdminAndActive(connection, actor, organizationId, productId, competitorId)
      const result = await connection.query<Record<string, unknown>>(
        `INSERT INTO competitor_ad_sync_schedules(id,organization_id,product_id,competitor_id,actor_user_id,enabled,interval_seconds,next_run_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,statement_timestamp())
         ON CONFLICT (organization_id,competitor_id,provider_name) DO UPDATE SET
           actor_user_id=EXCLUDED.actor_user_id, enabled=EXCLUDED.enabled, interval_seconds=EXCLUDED.interval_seconds,
           next_run_at=CASE WHEN EXCLUDED.enabled AND NOT competitor_ad_sync_schedules.enabled THEN statement_timestamp() ELSE competitor_ad_sync_schedules.next_run_at END,
           updated_at=statement_timestamp()
         RETURNING id,organization_id,product_id,competitor_id,provider_name,actor_user_id,enabled,interval_seconds,next_run_at,last_run_at`,
        [this.createId(), organizationId, productId, competitorId, actor, enabled, intervalSeconds],
      )
      if (result.rowCount !== 1) throw new NotFoundError()
      if (!enabled) return disableWithFunction(connection, organizationId, productId, competitorId)
      return decode(result.rows[0]!)
    })
  }

  async patch(actor: string, organizationId: string, productId: string, competitorId: string, changes: { intervalSeconds?: number; enabled?: boolean }): Promise<AdSyncSchedule> {
    if (changes.intervalSeconds === undefined && changes.enabled === undefined) throw new ValidationError('Schedule patch is empty')
    if (changes.intervalSeconds !== undefined) validateInterval(changes.intervalSeconds)
    return withVerifiedUserContext(this.pool, actor, async (connection) => {
      await requireAdminAndActive(connection, actor, organizationId, productId, competitorId)
      if (changes.enabled === false) {
        const disabled = await disableWithFunction(connection, organizationId, productId, competitorId)
        if (changes.intervalSeconds === undefined) return disabled
        const updated = await connection.query<Record<string, unknown>>(
          `UPDATE competitor_ad_sync_schedules SET interval_seconds=$4,updated_at=statement_timestamp()
           WHERE organization_id=$1 AND product_id=$2 AND competitor_id=$3
           RETURNING id,organization_id,product_id,competitor_id,provider_name,actor_user_id,enabled,interval_seconds,next_run_at,last_run_at`,
          [organizationId, productId, competitorId, changes.intervalSeconds],
        )
        return decode(updated.rows[0]!)
      }
      const result = await connection.query<Record<string, unknown>>(
        `UPDATE competitor_ad_sync_schedules SET
           interval_seconds=COALESCE($4,interval_seconds),
           actor_user_id=CASE WHEN $5::boolean IS TRUE AND NOT enabled THEN $6 ELSE actor_user_id END,
           next_run_at=CASE WHEN $5::boolean IS TRUE AND NOT enabled THEN statement_timestamp() ELSE next_run_at END,
           enabled=COALESCE($5,enabled),updated_at=statement_timestamp()
         WHERE organization_id=$1 AND product_id=$2 AND competitor_id=$3
         RETURNING id,organization_id,product_id,competitor_id,provider_name,actor_user_id,enabled,interval_seconds,next_run_at,last_run_at`,
        [organizationId, productId, competitorId, changes.intervalSeconds ?? null, changes.enabled ?? null, actor],
      )
      if (result.rowCount !== 1) throw new NotFoundError()
      return decode(result.rows[0]!)
    })
  }

  async disable(actor: string, organizationId: string, productId: string, competitorId: string): Promise<AdSyncSchedule> {
    return withVerifiedUserContext(this.pool, actor, async (connection) => {
      await requireAdmin(connection, actor, organizationId)
      return disableWithFunction(connection, organizationId, productId, competitorId)
    })
  }
}

async function disableWithFunction(connection: Connection, organizationId: string, productId: string, competitorId: string): Promise<AdSyncSchedule> {
  const result = await connection.query<Record<string, unknown>>(
    `SELECT id,organization_id,product_id,competitor_id,provider_name,actor_user_id,enabled,interval_seconds,next_run_at,last_run_at
     FROM app_admin_disable_ad_sync_schedule($1,$2,$3)`,
    [organizationId, productId, competitorId],
  )
  if (result.rowCount !== 1) throw new NotFoundError()
  return decode(result.rows[0]!)
}

function validateInterval(value: number): void {
  if (!Number.isSafeInteger(value) || value < 60 || value > 604800) throw new ValidationError('Schedule interval is invalid')
}

async function requireAdmin(connection: Connection, actor: string, organizationId: string): Promise<void> {
  const result = await connection.query(
    `SELECT 1 FROM organization_members WHERE organization_id=$2 AND user_id=$1 AND role='admin'`,
    [actor, organizationId],
  )
  if (result.rowCount !== 1) throw new AuthorizationError()
}

async function requireAdminAndActive(connection: Connection, actor: string, organizationId: string, productId: string, competitorId: string): Promise<void> {
  const result = await connection.query(
    `SELECT 1 FROM organization_members m
     JOIN products p ON p.organization_id=m.organization_id AND p.id=$3 AND p.archived_at IS NULL
     JOIN competitors c ON c.organization_id=p.organization_id AND c.product_id=p.id AND c.id=$4 AND c.archived_at IS NULL
     WHERE m.organization_id=$2 AND m.user_id=$1 AND m.role='admin' FOR SHARE OF p,c`,
    [actor, organizationId, productId, competitorId],
  )
  if (result.rowCount !== 1) throw new AuthorizationError()
}

function decode(row: Record<string, unknown>): AdSyncSchedule {
  return {
    id: row.id as string, organizationId: row.organization_id as string, productId: row.product_id as string,
    competitorId: row.competitor_id as string, providerName: 'apify-meta-ads', actorUserId: row.actor_user_id as string,
    enabled: row.enabled as boolean, intervalSeconds: row.interval_seconds as number,
    nextRunAt: new Date(row.next_run_at as string | Date).toISOString(),
    lastRunAt: row.last_run_at == null ? null : new Date(row.last_run_at as string | Date).toISOString(),
  }
}
