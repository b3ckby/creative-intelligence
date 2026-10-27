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
import { AD_BODY_MAX_LENGTH, type BriefDimensions, type Competitor, type Product } from '../domain/types.ts'
import type { CompetitorScaleMetrics } from '../analytics/scale-metrics.ts'
import type { CreativeAnalysisRecord } from '../creative-analysis/creative-analysis-service.ts'
import { OrganizationService, type OrganizationRole } from '../organizations/organization-service.ts'
import { PostgresCatalogRepository } from '../persistence/postgres-catalog-repository.ts'
import { PostgresBriefRepository } from '../persistence/postgres-brief-repository.ts'
import { PostgresIterationMapRepository } from '../persistence/postgres-iteration-map-repository.ts'
import { PostgresManualAdImportService } from '../persistence/postgres-manual-ad-import-service.ts'
import { PostgresProviderAdImportService } from '../persistence/postgres-provider-ad-import-service.ts'
import { PostgresProviderSyncRateLimiter } from '../persistence/postgres-provider-sync-rate-limiter.ts'
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
  stagingLogin?: { login(password: string, remoteAddress: string): Promise<string> }
  stagingOrganizationId?: string
  trustedProxies?: string[]
  scaleAnalytics?: {
    get(actorUserId: string, organizationId: string, productId: string): Promise<{ label: string; generatedAt: string; items: CompetitorScaleMetrics[] }>
  }
  creativeAnalysis?: {
    analyze(actorUserId: string, organizationId: string, productId: string, adId: string): Promise<CreativeAnalysisRecord>
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
    logger: false,
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
  const catalog = new PostgresCatalogRepository(options.pool)
  const manualAds = new PostgresManualAdImportService(options.pool, options.createId, options.now)
  const providerAds = new PostgresProviderAdImportService(options.pool, options.createId, options.now)
  const providerSyncRateLimiter = new PostgresProviderSyncRateLimiter(options.pool)
  const apifyGate = options.apify ? new ApifyRequestGate(options.apify.maxConcurrency) : undefined
  const apifySyncs = new Map<string, Promise<{ inserted: number; duplicates: number }>>()
  const briefs = new PostgresBriefRepository(options.pool, options.now, options.createId)
  const iterationMaps = new PostgresIterationMapRepository(options.pool)

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
      includeArchived,
    })
    const { query, page } = paginatedQuery(request, ['productId', 'competitorId', 'isActive', 'provider'], false, scopeFor, options.cursorSigningKey)
    const productId = optionalQueryIdentifier(query, 'productId')
    const competitorId = optionalQueryIdentifier(query, 'competitorId')
    const rawProvider = query.get('provider')
    const provider = rawProvider === null ? undefined : validateIdentifier(rawProvider, 'provider query parameter', 64)
    const rawActive = query.get('isActive')
    const isActive = rawActive === null ? undefined : booleanQuery(query, 'isActive', false)
    await organizations.requireMembership(organizationId, userId)
    const rows = await catalog.pageAds(userId, organizationId, {
      ...page,
      ...(productId === undefined ? {} : { productId }),
      ...(competitorId === undefined ? {} : { competitorId }),
      ...(isActive === undefined ? {} : { isActive }),
      ...(provider === undefined ? {} : { provider }),
    })
    return pageFromRows(rows, page.limit, scopeFor(query, page.includeArchived), options.cursorSigningKey, (ad) => exactCursorTimestamp(ad, ad.firstSeenAt))
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
