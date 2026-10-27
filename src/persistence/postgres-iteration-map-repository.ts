import { ValidationError } from '../domain/errors.ts'
import {
  analyzeNormalizedIterationMap,
  ITERATION_MAP_OVERFLOW_PROBE_LIMIT,
  MAX_ACTIVE_BRIEFS,
  normalizeIterationMapInput,
  type AnalyzeIterationMapInput,
  type IterationMapResult,
} from '../iteration-map/iteration-map-service.ts'
import { decodeStoredBriefDimensions } from './postgres-brief-repository.ts'
import { storedIdentifier } from './catalog-row-decoders.ts'
import { requireBriefReadContext } from './postgres-brief-read-context.ts'
import type { SqlPool } from './postgres-organization-repository.ts'
import { withVerifiedUserReadContext } from './verified-user-context.ts'

export { MAX_ACTIVE_BRIEFS } from '../iteration-map/iteration-map-service.ts'

type IterationBriefRow = { id: string; dimensions: unknown }

export class PostgresIterationMapRepository {
  constructor(private readonly pool: SqlPool) {}

  async analyze(verifiedUserId: string, input: AnalyzeIterationMapInput): Promise<IterationMapResult> {
    const normalizedInput = normalizeIterationMapInput(input)
    const { organizationId, productId } = normalizedInput

    return withVerifiedUserReadContext(this.pool, verifiedUserId, async (client) => {
      const product = await requireBriefReadContext(client, verifiedUserId, organizationId, productId)
      const result = await client.query<IterationBriefRow>(
        `SELECT id, dimensions
         FROM creative_briefs
         WHERE organization_id = $1 AND product_id = $2 AND status <> 'archived'
         ORDER BY created_at, id
         LIMIT $3`,
        [organizationId, productId, ITERATION_MAP_OVERFLOW_PROBE_LIMIT],
      )
      if (result.rows.length > MAX_ACTIVE_BRIEFS) {
        throw new ValidationError(`Iteration Map has too many active briefs; maximum is ${MAX_ACTIVE_BRIEFS}`)
      }
      const briefs = result.rows.map(({ id, dimensions }) => ({
        id: storedIdentifier(id, 'iteration-brief.id'),
        dimensions: decodeStoredBriefDimensions(dimensions),
      }))
      return analyzeNormalizedIterationMap(normalizedInput, product, briefs)
    })
  }
}
