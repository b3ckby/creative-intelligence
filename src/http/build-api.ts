import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'

import type { ManualMetaAdRecord } from '../ad-ingestion/manual-meta-ads-provider.ts'
import { ApifyMetaAdsProvider, ApifyRequestGate, normalizeFacebookPageUrl, type ApifyMetaAdsProviderConfig } from '../ad-ingestion/apify-meta-ads-provider.ts'
import { ApplicationError, AuthenticationError, NotFoundError, ServiceUnavailableError, ValidationError } from '../domain/errors.ts'
import { DEFAULT_PAGE_LIMIT, validatePageLimit } from '../domain/page-limit.ts'
import { normalizeIdentifier, validateIdentifier } from '../domain/identifiers.ts'
import {
  isCanonicalHttpsUrl,
  isCanonicalJavascriptTimestamp,
  isNormalizedParseableDate,
  normalizeCanonicalText,
  normalizeCanonicalTextArray,
  validateCanonicalHttpsUrl,
  validateCanonicalHttpsUrlArray,
} from '../domain/validation.ts'
import { AD_BODY_MAX_LENGTH, WINNING_AD_CATEGORIES, type BriefDimensions, type Competitor, type CreativeBrief, type InspirationSort, type InspirationSourceKind, type Product, type WinningAdCategory } from '../domain/types.ts'
import type { CompetitorScaleMetrics } from '../analytics/scale-metrics.ts'
import type { AnalyticsHistoryWindow, CompetitorAnalyticsComparison, CompetitorAnalyticsHistory } from '../analytics/competitor-analytics.ts'
import type { CreativeAnalysisRecord } from '../creative-analysis/creative-analysis-service.ts'
import type { CreativeTagReview, CreativeTagReviewItem, CreativeTagReviewStatus } from '../creative-analysis/creative-tag-review.ts'
import type { CreativeStrategySummaryService } from '../creative-analysis/creative-strategy-summary.ts'
import { OrganizationService, type OrganizationRole } from '../organizations/organization-service.ts'
import { PostgresCatalogRepository, type AdDiscoverySort } from '../persistence/postgres-catalog-repository.ts'
import { PostgresWinningAdsRepository } from '../persistence/postgres-winning-ads-repository.ts'
import { PostgresInspirationRepository } from '../persistence/postgres-inspiration-repository.ts'
import { PostgresBriefRepository } from '../persistence/postgres-brief-repository.ts'
import { AiBriefService } from '../briefs/ai-brief-service.ts'
import { PostgresIterationMapRepository } from '../persistence/postgres-iteration-map-repository.ts'
import { PostgresCreativeTagReviewRepository } from '../persistence/postgres-creative-tag-review-repository.ts'
import { PostgresManualAdImportService } from '../persistence/postgres-manual-ad-import-service.ts'
import { PostgresProviderAdImportService } from '../persistence/postgres-provider-ad-import-service.ts'
import { PostgresProviderSyncRateLimiter } from '../persistence/postgres-provider-sync-rate-limiter.ts'
import { PostgresAdSyncScheduleService } from '../persistence/postgres-ad-sync-schedule-service.ts'
import { PostgresOrganizationRepository, type SqlPool } from '../persistence/postgres-organization-repository.ts'
import { cursorScope, decodeCursor, exactCursorTimestamp, pageFromRows, validateCursorSigningKey, type CursorSigningKey } from './pagination.ts'
import { schemaFor } from './schemas.ts'
import { parseStrictJson } from './strict-json.ts'

export interface BuildApiOptions {
  pool: SqlPool
  createId: () => string
  now: () => Date
  authenticate: (request: FastifyRequest) => Promise<string>
  cursorSigningKey: CursorSigningKey
  apify?: Omit<ApifyMetaAdsProviderConfig, 'facebookPageUrl'> & { fetch?: typeof fetch, maxConcurrency: number }
  apifyGate?: ApifyRequestGate
  mediaMirrors?: boolean
  adLibraryDiscovery?: boolean
  stagingLogin?: { login(password: string, remoteAddress: string): Promise<string> }
  stagingOrganizationId?: string
  trustedProxies?: string[]
  logger?: boolean
  scaleAnalytics?: {
    get(actorUserId: string, organizationId: string, productId: string): Promise<{ label: string; generatedAt: string; items: CompetitorScaleMetrics[] }>
  }
  competitorAnalytics?: {
    history(actorUserId: string, organizationId: string, productId: string, competitorId: string, windowDays: AnalyticsHistoryWindow): Promise<CompetitorAnalyticsHistory>
    compare(actorUserId: string, organizationId: string, productId: string, competitorIds: string[]): Promise<CompetitorAnalyticsComparison>
  }
  creativeAnalysis?: {
    analyze(actorUserId: string, organizationId: string, productId: string, adId: string): Promise<CreativeAnalysisRecord>
  }
  creativeStrategy?: CreativeStrategySummaryService
  creativeTagReviews?: {
    list(actorUserId: string, organizationId: string, options: { productId?: string; status?: CreativeTagReviewStatus; limit: number }): Promise<CreativeTagReviewItem[]>
    detail(actorUserId: string, organizationId: string, adId: string, analysisVersion: string, inputFingerprint: string): Promise<CreativeTagReviewItem>
    history(actorUserId: string, organizationId: string, adId: string, analysisVersion: string, inputFingerprint: string, limit: number): Promise<CreativeTagReview[]>
    submit(actorUserId: string, organizationId: string, adId: string, analysisVersion: string, inputFingerprint: string, submission: unknown): Promise<CreativeTagReview>
  }
  aiBriefs?: {
    generate(actorUserId: string, organizationId: string, productId: string, adId: string, title: string): Promise<CreativeBrief>
    handoff(actorUserId: string, organizationId: string, briefId: string): Promise<{ briefId: string; version: number; filename: string; markdown: string }>
  }
}

export function buildApi(options: BuildApiOptions): FastifyInstance {
  validateCursorSigningKey(options.cursorSigningKey)
  const customFormats = {
    'canonical-https-url': isCanonicalHttpsUrl,
    'parseable-javascript-date': isNormalizedParseableDate,
    'canonical-javascript-timestamp': isCanonicalJavascriptTimestamp,
  }
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: options.trustedProxies ?? false,
    serializerOpts: { ajv: { formats: customFormats } },
    ajv: {
      onCreate: (ajv) => {
        ajv.addKeyword({
          keyword: 'x-maxCartesianProduct',
          schemaType: 'number',
          type: 'object',
          validate: (maximum: number, value: unknown) => {
            if (typeof value !== 'object' || value === null || Array.isArray(value)) return true
            const record = value as Record<string, unknown>
            const lengths = ['audience', 'market', 'angle', 'format'].map((name) => {
              const axis = record[name]
              if (!Array.isArray(axis)) return 1
              try {
                return new Set(axis.map((item) => normalizeCanonicalText(item, `Iteration axis ${name}`, { maxLength: 100 }))).size
              } catch {
                return 1
              }
            })
            return lengths.reduce((product, length) => product * length, 1) <= maximum
          },
        })
      },
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        formats: customFormats,
      },
    },
  })
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    try {
      if (typeof body !== 'string') throw new Error('JSON body was not decoded as text')
      done(null, parseStrictJson(body))
    } catch {
      done(new ValidationError('JSON body is invalid'))
    }
  })
  const organizations = new OrganizationService(
    new PostgresOrganizationRepository(options.pool), options.createId, options.now,
  )
  const catalog = new PostgresCatalogRepository(options.pool, options.mediaMirrors === true, options.adLibraryDiscovery === true)
  const winningAds = new PostgresWinningAdsRepository(options.pool, options.createId, options.now)
  const inspiration = new PostgresInspirationRepository(options.pool, options.createId, options.now)
  const manualAds = new PostgresManualAdImportService(options.pool, options.createId, options.now)
  const providerAds = new PostgresProviderAdImportService(options.pool, options.createId, options.now)
  const providerSyncRateLimiter = new PostgresProviderSyncRateLimiter(options.pool)
  const apifyGate = options.apify ? (options.apifyGate ?? new ApifyRequestGate(options.apify.maxConcurrency)) : undefined
  const adSyncSchedules = new PostgresAdSyncScheduleService(options.pool, options.createId)
  const apifySyncs = new Map<string, Promise<{ inserted: number; duplicates: number }>>()
  const briefs = new PostgresBriefRepository(options.pool, options.now, options.createId)
  const aiBriefs = options.aiBriefs ?? new AiBriefService(options.creativeAnalysis, briefs)
  const iterationMaps = new PostgresIterationMapRepository(options.pool)
  const creativeTagReviews = options.creativeTagReviews ?? new PostgresCreativeTagReviewRepository(options.pool)

  const authenticatedUsers = new WeakMap<FastifyRequest, string>()
  app.addHook('onRequest', async (request) => {
    const routeSchema = request.routeOptions.schema as { security?: unknown } | undefined
    if (!Array.isArray(routeSchema?.security) || routeSchema.security.length === 0) return
    try {
      const userId = await options.authenticate(request)
      authenticatedUsers.set(request, validateIdentifier(userId, 'Authenticated user ID'))
    } catch {
      throw new AuthenticationError()
    }
  })

  const actor = async (request: FastifyRequest): Promise<string> => {
    const userId = authenticatedUsers.get(request)
    if (!userId) throw new AuthenticationError()
    return userId
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApplicationError) return reply.code(error.statusCode).send({ error: error.publicMessage })
    if (isPostgresUniqueViolation(error)) return reply.code(409).send({ error: 'Resource conflict' })
    const clientStatus = fastifyClientStatus(error)
    if (clientStatus !== undefined) {
      if (clientStatus === 400 && (request.routeOptions.schema as { operationId?: unknown } | undefined)?.operationId === 'importManualMetaAds') {
        return reply.code(400).send({ error: manualAdValidationMessage(error) })
      }
      const publicMessage = clientStatus === 413 ? 'Payload too large'
        : clientStatus === 415 ? 'Unsupported media type'
          : clientStatus === 404 ? 'Not found' : 'Invalid request'
      return reply.code(clientStatus).send({ error: publicMessage })
    }
    return reply.code(500).send({ error: 'Internal server error' })
  })

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'Not found' }))

  app.post('/auth/staging-login', { schema: schemaFor('stagingPasswordLogin') }, async (request) => {
    if (!options.stagingLogin || !options.stagingOrganizationId) throw new NotFoundError()
    queryParameters(request, [])
    const body = exactRecord(request.body, ['password'])
    return {
      accessToken: await options.stagingLogin.login(text(body.password, 'Password'), request.ip),
      organizationId: options.stagingOrganizationId,
    }
  })

  app.post('/organizations', { schema: schemaFor('createOrganization') }, async (request, reply) => {
    const actorUserId = await actor(request)
    queryParameters(request, [])
    const body = exactRecord(request.body, ['name'])
    const organization = await organizations.create({ name: text(body.name, 'Organization name'), actorUserId })
    return reply.code(201).send(organization)
  })

  app.post('/organizations/:organizationId/members', { schema: schemaFor('addOrganizationMember') }, async (request, reply) => {
    const actorUserId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    queryParameters(request, [])
    const body = exactRecord(request.body, ['userId', 'role'])
    const role = body.role
    if (role !== 'admin' && role !== 'member') throw new ValidationError('Organization role is invalid')
    await organizations.addMember({
      organizationId,
      actorUserId,
      userId: text(body.userId, 'User ID'),
      role: role as OrganizationRole,
    })
    return reply.code(204).send()
  })

  app.post('/organizations/:organizationId/products', { schema: schemaFor('createProduct') }, async (request, reply) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    queryParameters(request, [])
    const body = exactRecord(request.body, ['name', 'markets', 'platforms', 'targetAudiences', 'uniqueSellingPoints'])
    const product: Product = {
      id: validateIdentifier(options.createId(), 'Generated ID'),
      organizationId,
      name: nonEmptyText(body.name, 'Product name', 300),
      markets: textArray(body.markets, 'markets'),
      platforms: platforms(body.platforms),
      targetAudiences: textArray(body.targetAudiences, 'targetAudiences'),
      uniqueSellingPoints: textArray(body.uniqueSellingPoints, 'uniqueSellingPoints'),
      archivedAt: null,
      createdAt: options.now().toISOString(),
    }
    await organizations.requireMembership(organizationId, userId)
    await catalog.createProduct(userId, product)
    return reply.code(201).send(product)
  })

  app.get('/organizations/:organizationId/products', { schema: schemaFor('listProducts') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const scope = (includeArchived: boolean) => cursorScope('products', { organizationId, includeArchived })
    const page = pageQuery(request, scope, options.cursorSigningKey)
    await organizations.requireMembership(organizationId, userId)
    const rows = await catalog.pageProducts(userId, organizationId, page)
    return pageFromRows(rows, page.limit, scope(page.includeArchived), options.cursorSigningKey, (product) => exactCursorTimestamp(product, product.createdAt))
  })

  app.get('/organizations/:organizationId/products/:productId', { schema: schemaFor('getProduct') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const productId = routeId(request, 'productId')
    const query = queryParameters(request, ['includeArchived'])
    const includeArchived = booleanQuery(query, 'includeArchived', false)
    await organizations.requireMembership(organizationId, userId)
    const product = await catalog.findProduct(userId, organizationId, productId)
    if (!product || (!includeArchived && product.archivedAt !== null)) throw new NotFoundError()
    return product
  })

  app.patch('/organizations/:organizationId/products/:productId', { schema: schemaFor('updateProduct') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const productId = routeId(request, 'productId')
    queryParameters(request, [])
    const body = exactRecord(request.body, ['name', 'markets', 'platforms', 'targetAudiences', 'uniqueSellingPoints'])
    await organizations.requireMembership(organizationId, userId)
    const updated = await catalog.updateProduct(userId, organizationId, productId, {
      ...(body.name === undefined ? {} : { name: nonEmptyText(body.name, 'Product name', 300) }),
      ...(body.markets === undefined ? {} : { markets: textArray(body.markets, 'markets') }),
      ...(body.platforms === undefined ? {} : { platforms: platforms(body.platforms) }),
      ...(body.targetAudiences === undefined ? {} : { targetAudiences: textArray(body.targetAudiences, 'targetAudiences') }),
      ...(body.uniqueSellingPoints === undefined ? {} : { uniqueSellingPoints: textArray(body.uniqueSellingPoints, 'uniqueSellingPoints') }),
    })
    if (!updated) throw new NotFoundError()
    return updated
  })

  app.post('/organizations/:organizationId/products/:productId/archive', { schema: schemaFor('archiveProduct') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const productId = routeId(request, 'productId')
    queryParameters(request, [])
    if (request.body !== undefined) exactRecord(request.body, [])
    await organizations.requireMembership(organizationId, userId)
    const product = await catalog.setProductArchived(userId, organizationId, productId, options.now().toISOString())
    if (!product) throw new NotFoundError()
    return product
  })

  app.post('/organizations/:organizationId/products/:productId/restore', { schema: schemaFor('restoreProduct') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const productId = routeId(request, 'productId')
    queryParameters(request, [])
    if (request.body !== undefined) exactRecord(request.body, [])
    await organizations.requireMembership(organizationId, userId)
    const product = await catalog.setProductArchived(userId, organizationId, productId, null)
    if (!product) throw new NotFoundError()
    return product
  })

  app.post('/organizations/:organizationId/products/:productId/competitors', { schema: schemaFor('createCompetitor') }, async (request, reply) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const productId = routeId(request, 'productId')
    queryParameters(request, [])
    const body = exactRecord(request.body, ['name', 'metaPageUrl'])
    const competitor: Competitor = {
      id: validateIdentifier(options.createId(), 'Generated ID'),
      organizationId,
      productId,
      name: nonEmptyText(body.name, 'Competitor name', 300),
      metaPageUrl: optionalHttpsUrl(body.metaPageUrl, 'metaPageUrl'),
      archivedAt: null,
      createdAt: options.now().toISOString(),
    }
    await organizations.requireMembership(organizationId, userId)
    await catalog.createCompetitor(userId, competitor)
    return reply.code(201).send(competitor)
  })

  app.get('/organizations/:organizationId/products/:productId/competitors', { schema: schemaFor('listCompetitors') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const productId = routeId(request, 'productId')
    const scope = (includeArchived: boolean) => cursorScope('competitors', { organizationId, productId, includeArchived })
    const page = pageQuery(request, scope, options.cursorSigningKey)
    await organizations.requireMembership(organizationId, userId)
    const rows = await catalog.pageCompetitors(userId, organizationId, productId, page)
    return pageFromRows(rows, page.limit, scope(page.includeArchived), options.cursorSigningKey, (competitor) => exactCursorTimestamp(competitor, competitor.createdAt))
  })

  app.get('/organizations/:organizationId/products/:productId/competitors/:competitorId', { schema: schemaFor('getCompetitor') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const productId = routeId(request, 'productId')
    const competitorId = routeId(request, 'competitorId')
    const query = queryParameters(request, ['includeArchived'])
    const includeArchived = booleanQuery(query, 'includeArchived', false)
    await organizations.requireMembership(organizationId, userId)
    const competitor = await catalog.findCompetitor(userId, organizationId, productId, competitorId)
    const parent = includeArchived ? undefined : await catalog.findProduct(userId, organizationId, productId)
    if (!competitor || (!includeArchived && (competitor.archivedAt !== null || !parent || parent.archivedAt !== null))) throw new NotFoundError()
    return competitor
  })

  const scheduleIds = async (request: FastifyRequest) => ({
    userId: await actor(request), organizationId: routeId(request, 'organizationId'),
    productId: routeId(request, 'productId'), competitorId: routeId(request, 'competitorId'),
  })
  app.get('/organizations/:organizationId/products/:productId/competitors/:competitorId/ad-sync-schedule', { schema: schemaFor('getAdSyncSchedule') }, async (request) => {
    queryParameters(request, [])
    const ids = await scheduleIds(request)
    return adSyncSchedules.get(ids.userId, ids.organizationId, ids.productId, ids.competitorId)
  })
  const replaceSchedule = async (request: FastifyRequest) => {
    queryParameters(request, [])
    const ids = await scheduleIds(request)
    const body = exactRecord(request.body, ['intervalSeconds', 'enabled'])
    if (!Number.isSafeInteger(body.intervalSeconds) || typeof body.enabled !== 'boolean') throw new ValidationError('Schedule is invalid')
    return adSyncSchedules.upsert(ids.userId, ids.organizationId, ids.productId, ids.competitorId, body.intervalSeconds as number, body.enabled)
  }
  app.post('/organizations/:organizationId/products/:productId/competitors/:competitorId/ad-sync-schedule', { schema: schemaFor('upsertAdSyncSchedule') }, replaceSchedule)
  app.patch('/organizations/:organizationId/products/:productId/competitors/:competitorId/ad-sync-schedule', { schema: schemaFor('updateAdSyncSchedule') }, async (request) => {
    queryParameters(request, [])
    const ids = await scheduleIds(request)
    const body = exactRecord(request.body, ['intervalSeconds', 'enabled'])
    if (Object.keys(body).length === 0
      || (body.intervalSeconds !== undefined && !Number.isSafeInteger(body.intervalSeconds))
      || (body.enabled !== undefined && typeof body.enabled !== 'boolean')) throw new ValidationError('Schedule is invalid')
    return adSyncSchedules.patch(ids.userId, ids.organizationId, ids.productId, ids.competitorId, {
      ...(body.intervalSeconds === undefined ? {} : { intervalSeconds: body.intervalSeconds as number }),
      ...(body.enabled === undefined ? {} : { enabled: body.enabled as boolean }),
    })
  })
  app.post('/organizations/:organizationId/products/:productId/competitors/:competitorId/ad-sync-schedule/disable', { schema: schemaFor('disableAdSyncSchedule') }, async (request) => {
    queryParameters(request, [])
    if (request.body !== undefined) throw new ValidationError('Request body is not allowed')
    const ids = await scheduleIds(request)
    return adSyncSchedules.disable(ids.userId, ids.organizationId, ids.productId, ids.competitorId)
  })

  app.post('/organizations/:organizationId/products/:productId/competitors/:competitorId/ads/manual-meta', { schema: schemaFor('importManualMetaAds') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const productId = routeId(request, 'productId')
    const competitorId = routeId(request, 'competitorId')
    queryParameters(request, [])
    const body = exactRecord(request.body, ['records'])
    const rawRecords = body.records
    if (!Array.isArray(rawRecords) || rawRecords.length === 0 || rawRecords.length > 1_000) throw new ValidationError('Manual ad records are required')
    let records: ManualMetaAdRecord[]
    try {
      records = rawRecords.map(manualAdRecord)
    } catch (error) {
      if (error instanceof ValidationError) throw new ValidationError(error.message, 'Invalid manual ad records')
      throw error
    }
    await organizations.requireMembership(organizationId, userId)
    try {
      return await manualAds.import(userId, { organizationId, productId, competitorId }, records)
    } catch (error) {
      if (error instanceof ValidationError) {
        throw new ValidationError(error.message, 'Invalid manual ad records')
      }
      throw error
    }
  })

  app.post('/organizations/:organizationId/products/:productId/competitors/:competitorId/ads/apify-meta/sync', { schema: schemaFor('syncApifyMetaAds') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const productId = routeId(request, 'productId')
    const competitorId = routeId(request, 'competitorId')
    queryParameters(request, [])
    if (!options.apify) throw new ServiceUnavailableError()
    await organizations.requireMembership(organizationId, userId)
    const [product, competitor] = await Promise.all([
      catalog.findProduct(userId, organizationId, productId),
      catalog.findCompetitor(userId, organizationId, productId, competitorId),
    ])
    if (!product || product.archivedAt !== null || !competitor || competitor.archivedAt !== null) throw new NotFoundError()
    if (competitor.metaPageUrl === null) throw new ValidationError('Competitor Meta page URL is required')
    let facebookPageUrl: string
    try {
      facebookPageUrl = normalizeFacebookPageUrl(competitor.metaPageUrl)
    } catch {
      throw new ValidationError('Competitor Meta page URL is invalid', 'Competitor Meta page URL is invalid')
    }
    const { fetch: providerFetch, maxConcurrency: _maxConcurrency, ...apifyConfig } = options.apify
    const provider = new ApifyMetaAdsProvider(
      { ...apifyConfig, facebookPageUrl },
      {
        ...(providerFetch ? { fetch: providerFetch } : {}),
        ...(apifyGate ? { gate: apifyGate } : {}),
        beforeActorStart: async () => providerSyncRateLimiter.claim(userId, organizationId, 'apify-meta-ads'),
      },
    )
    const key = JSON.stringify([organizationId, productId, competitorId])
    const existing = apifySyncs.get(key)
    if (existing) return await existing
    const sync = providerAds.import(userId, 'apify-meta-ads', { organizationId, productId, competitorId }, provider)
    apifySyncs.set(key, sync)
    try {
      return await sync
    } finally {
      if (apifySyncs.get(key) === sync) apifySyncs.delete(key)
    }
  })

  app.get('/organizations/:organizationId/competitors/:competitorId/ads', { schema: schemaFor('listCompetitorAds') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const competitorId = routeId(request, 'competitorId')
    const scope = (includeArchived: boolean) => cursorScope('competitor-ads', { organizationId, competitorId, includeArchived })
    const page = pageQuery(request, scope, options.cursorSigningKey)
    await organizations.requireMembership(organizationId, userId)
    const rows = await catalog.pageAds(userId, organizationId, { ...page, competitorId })
    return pageFromRows(rows, page.limit, scope(page.includeArchived), options.cursorSigningKey, (ad) => exactCursorTimestamp(ad, ad.firstSeenAt))
  })

  app.get('/organizations/:organizationId/ads', { schema: schemaFor('listOrganizationAds') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const scopeFor = (query: URLSearchParams, includeArchived: boolean) => cursorScope('organization-ads', {
      organizationId,
      productId: query.get('productId'),
      competitorId: query.get('competitorId'),
      isActive: query.get('isActive'),
      provider: query.get('provider'),
      search: query.get('search'),
      hookCategory: query.get('hookCategory'),
      angle: query.get('angle'),
      creativeFormat: query.get('creativeFormat'),
      bookmarked: query.get('bookmarked'),
      sort: query.get('sort'),
      includeArchived,
    })
    const { query, page } = paginatedQuery(request, ['productId', 'competitorId', 'isActive', 'provider', 'search', 'hookCategory', 'angle', 'creativeFormat', 'bookmarked', 'sort'], false, scopeFor, options.cursorSigningKey)
    const productId = optionalQueryIdentifier(query, 'productId')
    const competitorId = optionalQueryIdentifier(query, 'competitorId')
    const rawProvider = query.get('provider')
    const provider = rawProvider === null ? undefined : validateIdentifier(rawProvider, 'provider query parameter', 64)
    const rawActive = query.get('isActive')
    const isActive = rawActive === null ? undefined : booleanQuery(query, 'isActive', false)
    const rawSearch = query.get('search')
    const search = rawSearch === null ? undefined : normalizeCanonicalText(rawSearch, 'search query', { maxLength: 200 })
    const hookCategory = optionalQueryIdentifier(query, 'hookCategory')
    const angle = optionalQueryIdentifier(query, 'angle')
    const creativeFormat = optionalQueryIdentifier(query, 'creativeFormat')
    const rawBookmarked = query.get('bookmarked')
    const bookmarked = rawBookmarked === null ? undefined : booleanQuery(query, 'bookmarked', false)
    const rawSort = query.get('sort')
    const allowedSorts: AdDiscoverySort[] = ['first_seen_asc', 'first_seen_desc', 'last_seen_asc', 'last_seen_desc', 'lifespan_desc', 'impressions_desc']
    if (rawSort !== null && !allowedSorts.includes(rawSort as AdDiscoverySort)) throw new ValidationError('sort query parameter is invalid')
    const sort = rawSort === null ? undefined : rawSort as AdDiscoverySort
    await organizations.requireMembership(organizationId, userId)
    const rows = await catalog.pageAds(userId, organizationId, {
      ...page,
      ...(productId === undefined ? {} : { productId }),
      ...(competitorId === undefined ? {} : { competitorId }),
      ...(isActive === undefined ? {} : { isActive }),
      ...(provider === undefined ? {} : { provider }),
      ...(search === undefined ? {} : { search }),
      ...(hookCategory === undefined ? {} : { hookCategory }),
      ...(angle === undefined ? {} : { angle }),
      ...(creativeFormat === undefined ? {} : { creativeFormat }),
      ...(bookmarked === undefined ? {} : { bookmarked }),
      ...(sort === undefined ? {} : { sort }),
    })
    return pageFromRows(rows, page.limit, scopeFor(query, page.includeArchived), options.cursorSigningKey, (ad) => exactCursorTimestamp(ad, ad.firstSeenAt))
  })

  app.post('/organizations/:organizationId/ads/:adId/bookmark', { schema: schemaFor('setAdBookmark') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const adId = routeId(request, 'adId')
    queryParameters(request, [])
    const body = exactRecord(request.body, ['bookmarked'])
    if (typeof body.bookmarked !== 'boolean') throw new ValidationError('bookmarked is required')
    await organizations.requireMembership(organizationId, userId)
    await catalog.setAdBookmark(userId, organizationId, adId, body.bookmarked)
    return { bookmarked: body.bookmarked }
  })

  app.post('/organizations/:organizationId/winning-ads', { schema: schemaFor('saveWinningAd') }, async (request, reply) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    queryParameters(request, [])
    const body = exactRecord(request.body, ['sourceAdId', 'title', 'category', 'notes'])
    await organizations.requireMembership(organizationId, userId)
    const item = await winningAds.save(userId, organizationId, validateIdentifier(body.sourceAdId, 'Source ad ID'), {
      title: nonEmptyText(body.title, 'Winning ad title', 300), category: winningAdCategory(body.category),
      notes: normalizeCanonicalText(body.notes, 'Winning ad notes', { maxLength: 2_000, allowEmpty: true }),
    })
    return reply.code(201).send(item)
  })

  app.get('/organizations/:organizationId/winning-ads', { schema: schemaFor('listWinningAds') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const scopeFor = (query: URLSearchParams, includeArchived: boolean) => cursorScope('winning-ads', { organizationId, search: query.get('search'), category: query.get('category'), active: query.get('active'), includeArchived })
    const { query, page } = paginatedQuery(request, ['search', 'category', 'active'], true, scopeFor, options.cursorSigningKey)
    const rawSearch = query.get('search')
    const rawCategory = query.get('category')
    const rawActive = query.get('active')
    await organizations.requireMembership(organizationId, userId)
    const rows = await winningAds.page(userId, organizationId, {
      ...page,
      ...(rawSearch === null ? {} : { search: normalizeCanonicalText(rawSearch, 'search query', { maxLength: 200 }) }),
      ...(rawCategory === null ? {} : { category: winningAdCategory(rawCategory) }),
      ...(rawActive === null ? {} : { active: booleanQuery(query, 'active', false) }),
    })
    return pageFromRows(rows, page.limit, scopeFor(query, page.includeArchived), options.cursorSigningKey, (item) => exactCursorTimestamp(item, item.createdAt))
  })

  app.get('/organizations/:organizationId/winning-ads/:winningAdId', { schema: schemaFor('getWinningAd') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const id = routeId(request, 'winningAdId')
    const query = queryParameters(request, ['includeArchived'])
    await organizations.requireMembership(organizationId, userId)
    const item = await winningAds.find(userId, organizationId, id, booleanQuery(query, 'includeArchived', false))
    if (!item) throw new NotFoundError()
    return item
  })

  app.patch('/organizations/:organizationId/winning-ads/:winningAdId', { schema: schemaFor('updateWinningAd') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const id = routeId(request, 'winningAdId')
    queryParameters(request, [])
    const body = exactRecord(request.body, ['expectedVersion', 'title', 'category', 'notes'])
    await organizations.requireMembership(organizationId, userId)
    return winningAds.update(userId, organizationId, id, {
      expectedVersion: body.expectedVersion as number, title: nonEmptyText(body.title, 'Winning ad title', 300),
      category: winningAdCategory(body.category), notes: normalizeCanonicalText(body.notes, 'Winning ad notes', { maxLength: 2_000, allowEmpty: true }),
    })
  })

  app.post('/organizations/:organizationId/winning-ads/:winningAdId/archive', { schema: schemaFor('archiveWinningAd') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const id = routeId(request, 'winningAdId')
    queryParameters(request, [])
    if (request.body !== undefined) exactRecord(request.body, [])
    await organizations.requireMembership(organizationId, userId)
    return winningAds.archive(userId, organizationId, id)
  })

  app.delete('/organizations/:organizationId/winning-ads/:winningAdId', { schema: schemaFor('removeWinningAd') }, async (request, reply) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const id = routeId(request, 'winningAdId')
    queryParameters(request, [])
    await organizations.requireMembership(organizationId, userId)
    await winningAds.remove(userId, organizationId, id)
    return reply.code(204).send()
  })

  app.post('/organizations/:organizationId/inspiration/boards', { schema: schemaFor('createInspirationBoard') }, async (request, reply) => {
    const userId = await actor(request); const organizationId = routeId(request, 'organizationId'); queryParameters(request, [])
    const body = exactRecord(request.body, ['name', 'description']); await organizations.requireMembership(organizationId, userId)
    return reply.code(201).send(await inspiration.createBoard(userId, organizationId, { name: nonEmptyText(body.name, 'Board name', 200), description: normalizeCanonicalText(body.description, 'Board description', { maxLength: 1_000, allowEmpty: true }) }))
  })

  app.get('/organizations/:organizationId/inspiration/boards', { schema: schemaFor('listInspirationBoards') }, async (request) => {
    const userId = await actor(request); const organizationId = routeId(request, 'organizationId')
    const scope = (includeArchived: boolean) => cursorScope('inspiration-boards', { organizationId, includeArchived })
    const page = pageQuery(request, scope, options.cursorSigningKey); await organizations.requireMembership(organizationId, userId)
    const rows = await inspiration.pageBoards(userId, organizationId, page)
    return pageFromRows(rows, page.limit, scope(page.includeArchived), options.cursorSigningKey, (board) => exactCursorTimestamp(board, board.createdAt))
  })

  app.post('/organizations/:organizationId/inspiration/boards/:boardId/items', { schema: schemaFor('createInspirationItem') }, async (request, reply) => {
    const userId = await actor(request); const organizationId = routeId(request, 'organizationId'); const boardId = routeId(request, 'boardId'); queryParameters(request, [])
    const body = exactRecord(request.body, ['sourceKind', 'sourceId', 'title', 'notes', 'tags']); await organizations.requireMembership(organizationId, userId)
    return reply.code(201).send(await inspiration.addItem(userId, organizationId, boardId, {
      sourceKind: inspirationSourceKind(body.sourceKind), sourceId: validateIdentifier(body.sourceId, 'Source ID'), title: nonEmptyText(body.title, 'Inspiration title', 300),
      notes: normalizeCanonicalText(body.notes, 'Inspiration notes', { maxLength: 4_000, allowEmpty: true }), tags: inspirationTags(body.tags),
    }))
  })

  app.get('/organizations/:organizationId/inspiration/items', { schema: schemaFor('listInspirationItems') }, async (request) => {
    const userId = await actor(request); const organizationId = routeId(request, 'organizationId')
    const scopeFor = (query: URLSearchParams, includeArchived: boolean) => cursorScope('inspiration-items', { organizationId, boardId: query.get('boardId'), search: query.get('search'), tag: query.get('tag'), sourceKind: query.get('sourceKind'), sort: query.get('sort') ?? 'created_desc', includeArchived })
    const { query, page } = paginatedQuery(request, ['boardId', 'search', 'tag', 'sourceKind', 'sort'], true, scopeFor, options.cursorSigningKey)
    const rawSourceKind = query.get('sourceKind'); const rawSort = query.get('sort'); const sort = (rawSort ?? 'created_desc') as InspirationSort
    if (!['created_asc', 'created_desc', 'updated_desc'].includes(sort)) throw new ValidationError('sort query parameter is invalid')
    await organizations.requireMembership(organizationId, userId)
    const rows = await inspiration.pageItems(userId, organizationId, {
      ...page, sort,
      ...(query.get('boardId') === null ? {} : { boardId: validateIdentifier(query.get('boardId'), 'Board ID') }),
      ...(query.get('search') === null ? {} : { search: normalizeCanonicalText(query.get('search'), 'Search', { maxLength: 200 }) }),
      ...(query.get('tag') === null ? {} : { tag: normalizeCanonicalText(query.get('tag'), 'Tag', { maxLength: 60 }) }),
      ...(rawSourceKind === null ? {} : { sourceKind: inspirationSourceKind(rawSourceKind) }),
    })
    return pageFromRows(rows, page.limit, scopeFor(query, page.includeArchived), options.cursorSigningKey, (item) => exactCursorTimestamp(item, sort === 'updated_desc' ? item.updatedAt : item.createdAt))
  })

  app.get('/organizations/:organizationId/inspiration/items/:itemId', { schema: schemaFor('getInspirationItem') }, async (request) => {
    const userId = await actor(request); const organizationId = routeId(request, 'organizationId'); const itemId = routeId(request, 'itemId')
    const query = queryParameters(request, ['includeArchived']); await organizations.requireMembership(organizationId, userId)
    const item = await inspiration.findItem(userId, organizationId, itemId, booleanQuery(query, 'includeArchived', false)); if (!item) throw new NotFoundError(); return item
  })

  app.patch('/organizations/:organizationId/inspiration/items/:itemId', { schema: schemaFor('updateInspirationItem') }, async (request) => {
    const userId = await actor(request); const organizationId = routeId(request, 'organizationId'); const itemId = routeId(request, 'itemId'); queryParameters(request, [])
    const body = exactRecord(request.body, ['expectedVersion', 'boardId', 'title', 'notes', 'tags']); await organizations.requireMembership(organizationId, userId)
    return inspiration.updateItem(userId, organizationId, itemId, { expectedVersion: body.expectedVersion as number, boardId: validateIdentifier(body.boardId, 'Board ID'), title: nonEmptyText(body.title, 'Inspiration title', 300), notes: normalizeCanonicalText(body.notes, 'Inspiration notes', { maxLength: 4_000, allowEmpty: true }), tags: inspirationTags(body.tags) })
  })

  app.post('/organizations/:organizationId/inspiration/items/:itemId/archive', { schema: schemaFor('archiveInspirationItem') }, async (request) => {
    const userId = await actor(request); const organizationId = routeId(request, 'organizationId'); const itemId = routeId(request, 'itemId'); queryParameters(request, []); if (request.body !== undefined) exactRecord(request.body, []); await organizations.requireMembership(organizationId, userId); return inspiration.archiveItem(userId, organizationId, itemId)
  })

  app.delete('/organizations/:organizationId/inspiration/items/:itemId', { schema: schemaFor('removeInspirationItem') }, async (request, reply) => {
    const userId = await actor(request); const organizationId = routeId(request, 'organizationId'); const itemId = routeId(request, 'itemId'); queryParameters(request, []); await organizations.requireMembership(organizationId, userId); await inspiration.removeItem(userId, organizationId, itemId); return reply.code(204).send()
  })

  app.get('/organizations/:organizationId/products/:productId/competitors/:competitorId/analytics/history', { schema: schemaFor('getCompetitorAnalyticsHistory') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const productId = routeId(request, 'productId')
    const competitorId = routeId(request, 'competitorId')
    const query = queryParameters(request, ['window'])
    const windowDays = Number(query.get('window') ?? '30') as AnalyticsHistoryWindow
    await organizations.requireMembership(organizationId, userId)
    if (!options.competitorAnalytics) throw new ServiceUnavailableError()
    return options.competitorAnalytics.history(userId, organizationId, productId, competitorId, windowDays)
  })

  app.post('/organizations/:organizationId/products/:productId/analytics/comparison', { schema: schemaFor('compareCompetitorAnalytics') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const productId = routeId(request, 'productId')
    queryParameters(request, [])
    const body = exactRecord(request.body, ['competitorIds'])
    if (!Array.isArray(body.competitorIds)) throw new ValidationError('Competitor IDs are required')
    const competitorIds = body.competitorIds.map((value) => validateIdentifier(value, 'Competitor ID'))
    await organizations.requireMembership(organizationId, userId)
    if (!options.competitorAnalytics) throw new ServiceUnavailableError()
    return options.competitorAnalytics.compare(userId, organizationId, productId, competitorIds)
  })

  app.get('/organizations/:organizationId/products/:productId/analytics/scaling', { schema: schemaFor('getScalingAnalytics') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const productId = routeId(request, 'productId')
    queryParameters(request, [])
    await organizations.requireMembership(organizationId, userId)
    if (!options.scaleAnalytics) throw new ServiceUnavailableError()
    return options.scaleAnalytics.get(userId, organizationId, productId)
  })

  app.post('/organizations/:organizationId/products/:productId/ads/:adId/creative-analysis', { schema: schemaFor('analyzeCreative') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const productId = routeId(request, 'productId')
    const adId = routeId(request, 'adId')
    queryParameters(request, [])
    await organizations.requireMembership(organizationId, userId)
    if (!options.creativeAnalysis) throw new ServiceUnavailableError()
    return options.creativeAnalysis.analyze(userId, organizationId, productId, adId)
  })

  app.get('/organizations/:organizationId/creative-tag-reviews', { schema: schemaFor('listCreativeTagReviews') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const query = queryParameters(request, ['productId', 'status', 'limit'])
    const rawStatus = query.get('status')
    if (rawStatus !== null && !['pending', 'approved', 'rejected', 'corrected'].includes(rawStatus)) throw new ValidationError('status query parameter is invalid')
    const rawLimit = query.get('limit')
    const limit = rawLimit === null ? 50 : Number(rawLimit)
    await organizations.requireMembership(organizationId, userId)
    return { items: await creativeTagReviews.list(userId, organizationId, {
      ...(query.get('productId') === null ? {} : { productId: validateIdentifier(query.get('productId'), 'Product ID') }),
      ...(rawStatus === null ? {} : { status: rawStatus as CreativeTagReviewStatus }), limit,
    }) }
  })

  const reviewIdentity = (request: FastifyRequest) => {
    const query = queryParameters(request, ['analysisVersion', 'inputFingerprint', 'limit'])
    const analysisVersion = nonEmptyText(query.get('analysisVersion'), 'Analysis version', 128)
    const inputFingerprint = text(query.get('inputFingerprint'), 'Input fingerprint')
    if (!/^[a-f0-9]{64}$/u.test(inputFingerprint)) throw new ValidationError('Input fingerprint is invalid')
    return { query, analysisVersion, inputFingerprint }
  }
  app.get('/organizations/:organizationId/ads/:adId/creative-tag-review', { schema: schemaFor('getCreativeTagReview') }, async (request) => {
    const userId = await actor(request); const organizationId = routeId(request, 'organizationId'); const adId = routeId(request, 'adId')
    const identity = reviewIdentity(request); await organizations.requireMembership(organizationId, userId)
    return creativeTagReviews.detail(userId, organizationId, adId, identity.analysisVersion, identity.inputFingerprint)
  })
  app.get('/organizations/:organizationId/ads/:adId/creative-tag-review/history', { schema: schemaFor('listCreativeTagReviewHistory') }, async (request) => {
    const userId = await actor(request); const organizationId = routeId(request, 'organizationId'); const adId = routeId(request, 'adId')
    const identity = reviewIdentity(request); const rawLimit = identity.query.get('limit'); const limit = rawLimit === null ? 50 : Number(rawLimit)
    await organizations.requireMembership(organizationId, userId)
    return { items: await creativeTagReviews.history(userId, organizationId, adId, identity.analysisVersion, identity.inputFingerprint, limit) }
  })
  app.post('/organizations/:organizationId/ads/:adId/creative-tag-review', { schema: schemaFor('submitCreativeTagReview') }, async (request, reply) => {
    const userId = await actor(request); const organizationId = routeId(request, 'organizationId'); const adId = routeId(request, 'adId'); queryParameters(request, [])
    const body = exactRecord(request.body, ['analysisVersion', 'inputFingerprint', 'expectedReviewVersion', 'decision', 'corrections', 'reason'])
    await organizations.requireMembership(organizationId, userId)
    const review = await creativeTagReviews.submit(userId, organizationId, adId,
      nonEmptyText(body.analysisVersion, 'Analysis version', 128), text(body.inputFingerprint, 'Input fingerprint'), {
        expectedReviewVersion: body.expectedReviewVersion, decision: body.decision, corrections: body.corrections,
        reason: normalizeCanonicalText(body.reason, 'Review reason', { maxLength: 1_000 }),
      })
    return reply.code(201).send(review)
  })

  app.get('/organizations/:organizationId/products/:productId/competitors/:competitorId/creative-strategy', { schema: schemaFor('getCompetitorCreativeStrategy') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const productId = routeId(request, 'productId')
    const competitorId = routeId(request, 'competitorId')
    queryParameters(request, [])
    await organizations.requireMembership(organizationId, userId)
    if (!options.creativeStrategy) throw new ServiceUnavailableError()
    return options.creativeStrategy.get(userId, organizationId, productId, competitorId)
  })

  app.post('/organizations/:organizationId/products/:productId/briefs/from-ad', { schema: schemaFor('createBriefFromAd') }, async (request, reply) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const productId = routeId(request, 'productId')
    queryParameters(request, [])
    const body = exactRecord(request.body, ['adId', 'title', 'dimensions'])
    const brief = await briefs.createFromAd(userId, {
      organizationId,
      productId,
      adId: validateIdentifier(body.adId, 'Ad ID'),
      title: body.title as string,
      dimensions: body.dimensions as BriefDimensions,
    })
    return reply.code(201).send(brief)
  })

  app.post('/organizations/:organizationId/products/:productId/briefs/from-ad/ai', { schema: schemaFor('createAiBriefFromAd') }, async (request, reply) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const productId = routeId(request, 'productId')
    queryParameters(request, [])
    const body = exactRecord(request.body, ['adId', 'title'])
    const brief = await aiBriefs.generate(
      userId, organizationId, productId,
      validateIdentifier(body.adId, 'Ad ID'),
      normalizeCanonicalText(body.title, 'Brief title', { maxLength: 500 }),
    )
    return reply.code(201).send(brief)
  })

  app.post('/organizations/:organizationId/products/:productId/briefs', { schema: schemaFor('createManualBrief') }, async (request, reply) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const productId = routeId(request, 'productId')
    queryParameters(request, [])
    const body = exactRecord(request.body, ['title', 'hook', 'callToAction', 'dimensions'])
    const brief = await briefs.createManual(userId, {
      organizationId,
      productId,
      title: body.title as string,
      hook: body.hook as string,
      ...(body.callToAction === undefined ? {} : { callToAction: body.callToAction as string }),
      dimensions: body.dimensions as BriefDimensions,
    })
    return reply.code(201).send(brief)
  })

  app.get('/organizations/:organizationId/products/:productId/briefs', { schema: schemaFor('listBriefs') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const productId = routeId(request, 'productId')
    const scope = (includeArchived: boolean) => cursorScope('briefs', { organizationId, productId, includeArchived })
    const page = pageQuery(request, scope, options.cursorSigningKey)
    const rows = await briefs.pageForProduct(userId, organizationId, productId, page)
    return pageFromRows(rows, page.limit, scope(page.includeArchived), options.cursorSigningKey, (brief) => exactCursorTimestamp(brief, brief.createdAt))
  })

  app.get('/organizations/:organizationId/briefs/:briefId', { schema: schemaFor('getBrief') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const briefId = routeId(request, 'briefId')
    const query = queryParameters(request, ['includeArchived'])
    const includeArchived = booleanQuery(query, 'includeArchived', false)
    const brief = await briefs.findById(userId, organizationId, briefId, includeArchived)
    if (!brief || (!includeArchived && brief.status === 'archived')) throw new NotFoundError()
    return brief
  })

  app.patch('/organizations/:organizationId/briefs/:briefId', { schema: schemaFor('updateBrief') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const briefId = routeId(request, 'briefId')
    queryParameters(request, [])
    const body = exactRecord(request.body, ['expectedVersion', 'title', 'status', 'hook', 'callToAction', 'dimensions'])
    return briefs.update(userId, organizationId, briefId, {
      expectedVersion: body.expectedVersion as number,
      title: body.title as string,
      status: body.status as never,
      hook: body.hook as string,
      callToAction: body.callToAction as string | null,
      dimensions: body.dimensions as BriefDimensions,
    })
  })

  app.get('/organizations/:organizationId/briefs/:briefId/versions', { schema: schemaFor('listBriefVersions') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const briefId = routeId(request, 'briefId')
    const query = queryParameters(request, ['limit'])
    const rawLimit = query.get('limit')
    const limit = rawLimit === null ? 100 : Number(rawLimit)
    return { items: await briefs.listVersions(userId, organizationId, briefId, limit) }
  })

  app.get('/organizations/:organizationId/briefs/:briefId/handoff', { schema: schemaFor('getBriefHandoff') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const briefId = routeId(request, 'briefId')
    queryParameters(request, [])
    return aiBriefs.handoff(userId, organizationId, briefId)
  })

  app.post('/organizations/:organizationId/products/:productId/iteration-map/analyze', { schema: schemaFor('analyzeIterationMap') }, async (request) => {
    const userId = await actor(request)
    const organizationId = routeId(request, 'organizationId')
    const productId = routeId(request, 'productId')
    queryParameters(request, [])
    const body = exactRecord(request.body, ['axes'])
    return iterationMaps.analyze(userId, {
      organizationId,
      productId,
      axes: body.axes as never,
    })
  })

  return app
}

function routeId(request: FastifyRequest, name: string): string {
  const params = record(request.params)
  return validateIdentifier(params[name], `${name} route parameter`)
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError('Request body is invalid')
  return value as Record<string, unknown>
}

function exactRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  const result = record(value)
  if (Object.keys(result).some((key) => !allowed.includes(key))) throw new ValidationError('Request body contains unknown fields')
  return result
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ValidationError(`${field} is required`)
  return value
}

function nonEmptyText(value: unknown, field: string, maxLength: number): string {
  return normalizeCanonicalText(value, field, { maxLength })
}

function optionalHttpsUrl(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  return validateCanonicalHttpsUrl(value, field)
}

function textArray(value: unknown, field: string): string[] {
  return normalizeCanonicalTextArray(value, field, { maxItems: 100, maxLength: 500 })
}

function platforms(value: unknown): Product['platforms'] {
  const values = textArray(value, 'platforms')
  if (values.some((item) => item !== 'ios' && item !== 'android' && item !== 'web')) throw new ValidationError('platforms is invalid')
  return values as Product['platforms']
}

function fastifyClientStatus(error: unknown): 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined
  const statusCode = error.statusCode
  if (statusCode === 400 || statusCode === 401 || statusCode === 403 || statusCode === 404
    || statusCode === 409 || statusCode === 413 || statusCode === 415 || statusCode === 422 || statusCode === 429) {
    return statusCode
  }
  return undefined
}

function isPostgresUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
}

function manualAdValidationMessage(error: unknown): 'Invalid request' | 'Invalid manual ad records' {
  if (typeof error !== 'object' || error === null || !('validation' in error) || !Array.isArray(error.validation)) {
    return 'Invalid manual ad records'
  }
  for (const issue of error.validation) {
    if (typeof issue !== 'object' || issue === null) continue
    const record = issue as Record<string, unknown>
    if ((record.keyword === 'minItems' || record.keyword === 'maxItems') && record.instancePath === '/records') {
      return 'Invalid request'
    }
    const parameters = record.params
    if (record.keyword === 'required' && typeof parameters === 'object' && parameters !== null
        && (parameters as Record<string, unknown>).missingProperty === 'records') {
      return 'Invalid request'
    }
  }
  return 'Invalid manual ad records'
}

function queryParameters(request: FastifyRequest, allowed: readonly string[]): URLSearchParams {
  const query = new URL(request.raw.url ?? '/', 'http://localhost').searchParams
  for (const key of new Set(query.keys())) {
    if (!allowed.includes(key) || query.getAll(key).length !== 1) throw new ValidationError('Query parameters are invalid')
  }
  return query
}

function booleanQuery(query: URLSearchParams, name: string, defaultValue: boolean): boolean {
  const value = query.get(name)
  if (value === null) return defaultValue
  if (value === 'true') return true
  if (value === 'false') return false
  throw new ValidationError(`${name} is invalid`)
}

function paginatedQuery(
  request: FastifyRequest,
  extraAllowed: readonly string[],
  allowArchived: boolean,
  scopeFor: (query: URLSearchParams, includeArchived: boolean) => string,
  cursorSigningKey: CursorSigningKey,
) {
  const query = queryParameters(request, ['limit', 'cursor', ...(allowArchived ? ['includeArchived'] : []), ...extraAllowed])
  const rawLimit = query.get('limit')
  if (rawLimit !== null && !/^[1-9][0-9]*$/.test(rawLimit)) throw new ValidationError('limit is invalid')
  const limit = validatePageLimit(rawLimit === null ? DEFAULT_PAGE_LIMIT : Number(rawLimit))
  const rawCursor = query.get('cursor')
  const includeArchived = booleanQuery(query, 'includeArchived', false)
  const page = {
    limit,
    ...(rawCursor === null ? {} : { cursor: decodeCursor(rawCursor, scopeFor(query, includeArchived), cursorSigningKey) }),
    includeArchived,
  }
  return { query, page }
}

function pageQuery(request: FastifyRequest, scope: (includeArchived: boolean) => string, cursorSigningKey: CursorSigningKey) {
  return paginatedQuery(request, [], true, (_query, includeArchived) => scope(includeArchived), cursorSigningKey).page
}

function winningAdCategory(value: unknown): WinningAdCategory {
  if (typeof value !== 'string' || !WINNING_AD_CATEGORIES.includes(value as WinningAdCategory)) throw new ValidationError('Winning ad category is invalid')
  return value as WinningAdCategory
}

function inspirationSourceKind(value: unknown): InspirationSourceKind {
  if (value !== 'competitor_ad' && value !== 'winning_ad') throw new ValidationError('Inspiration source kind is invalid')
  return value
}

function inspirationTags(value: unknown): string[] {
  return normalizeCanonicalTextArray(value, 'Inspiration tags', { maxItems: 20, maxLength: 60 })
}

function optionalQueryIdentifier(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name)
  return value === null ? undefined : validateIdentifier(value, `${name} query parameter`)
}

function manualAdRecord(value: unknown): ManualMetaAdRecord {
  const item = exactRecord(value, ['externalId', 'advertiserName', 'body', 'callToAction', 'startedAt', 'isActive', 'mediaUrls', 'sourceUrl'])
  if (typeof item.isActive !== 'boolean') throw new ValidationError('Manual ad isActive is invalid')
  return {
    externalId: normalizeIdentifier(item.externalId, 'Manual ad externalId'),
    advertiserName: nonEmptyText(item.advertiserName, 'Manual ad advertiserName', 500),
    body: normalizeCanonicalText(item.body, 'Manual ad body', { maxLength: AD_BODY_MAX_LENGTH, allowEmpty: true }),
    ...(item.callToAction === undefined ? {} : { callToAction: nonEmptyText(item.callToAction, 'Manual ad callToAction', 100) }),
    startedAt: nonEmptyText(item.startedAt, 'Manual ad startedAt', 100),
    isActive: item.isActive,
    mediaUrls: validateCanonicalHttpsUrlArray(item.mediaUrls, 'Manual ad mediaUrls'),
    sourceUrl: validateCanonicalHttpsUrl(item.sourceUrl, 'Manual ad sourceUrl'),
  }
}
