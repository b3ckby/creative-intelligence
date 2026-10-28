import type { FastifySchema } from 'fastify'

import { AD_BODY_MAX_LENGTH } from '../domain/types.ts'
import { CREATIVE_ANGLES, CREATIVE_FORMATS, HOOK_CATEGORIES, OFFER_FRAMES } from '../creative-analysis/creative-analysis-service.ts'
import { MAX_CURSOR_LENGTH } from './pagination.ts'

export type ApiMethod = 'GET' | 'POST' | 'PATCH'
export type JsonSchema = Record<string, unknown>

export interface ApiRouteSchema extends FastifySchema {
  operationId: string
  summary: string
  tags: string[]
  security: Array<{ bearerAuth: [] }>
  params?: JsonSchema
  querystring?: JsonSchema
  body?: JsonSchema
  response: Record<number, JsonSchema>
}

export interface ApiContract {
  method: ApiMethod
  fastifyPath: string
  openapiPath: string
  operationId: string
  schema: ApiRouteSchema
}

const CONTROL_FREE = '[^\\u0000-\\u001F\\u007F-\\u009F]'

function canonicalText(maxLength: number, allowEmpty = false): JsonSchema {
  return {
    type: 'string',
    maxLength,
    pattern: allowEmpty
      ? `^(?:$|(?!\\s)(?!.*\\s$)${CONTROL_FREE}+)$`
      : `^(?!\\s)(?!.*\\s$)${CONTROL_FREE}+$`,
  }
}

function normalizedText(maxLength: number, allowEmpty = false): JsonSchema {
  const boundedCore = maxLength === 1 ? '\\S' : `(?:\\S|\\S${CONTROL_FREE}{0,${maxLength - 2}}\\S)`
  return {
    type: 'string',
    pattern: `^\\s*(?:${boundedCore})${allowEmpty ? '?' : ''}\\s*$`,
    description: `Leading and trailing whitespace is removed; the normalized value is at most ${maxLength} characters.`,
  }
}

const identifier: JsonSchema = canonicalText(256)
const timestamp: JsonSchema = {
  type: 'string',
  format: 'canonical-javascript-timestamp',
  description: 'A canonical JavaScript Date instant exactly as emitted by Date.prototype.toISOString().',
}
const parseableDate: JsonSchema = {
  ...normalizedText(100),
  format: 'parseable-javascript-date',
  description: 'A bounded date string accepted by JavaScript Date parsing and normalized to an ISO instant.',
}
const nullableTimestamp: JsonSchema = { anyOf: [timestamp, { type: 'null' }] }
const httpsUrl: JsonSchema = {
  type: 'string',
  maxLength: 2_048,
  format: 'canonical-https-url',
  description: 'A canonical, bounded WHATWG HTTPS URL with a hostname and without credentials or a fragment.',
}
const canonicalStringList = (maxItems = 100, maxLength = 500): JsonSchema => ({
  type: 'array', maxItems, uniqueItems: true, items: canonicalText(maxLength),
})
const normalizedStringList = (maxItems: number, maxLength: number, minItems = 0): JsonSchema => ({
  type: 'array', minItems, maxItems, items: normalizedText(maxLength),
})
const strictObject = (properties: Record<string, JsonSchema>, required: string[] = Object.keys(properties)): JsonSchema => ({
  type: 'object', additionalProperties: false, properties, required,
})
const params = (...names: string[]): JsonSchema => strictObject(Object.fromEntries(names.map((name) => [name, identifier])))
const paginationQuery = (extra: Record<string, JsonSchema> = {}, includeArchived = true): JsonSchema => strictObject({
  limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' },
  cursor: { type: 'string', minLength: 1, maxLength: MAX_CURSOR_LENGTH },
  ...(includeArchived ? { includeArchived: { type: 'string', enum: ['true', 'false'] } } : {}),
  ...extra,
}, [])
const detailQuery: JsonSchema = strictObject({ includeArchived: { type: 'string', enum: ['true', 'false'] } }, [])
const noQuery: JsonSchema = strictObject({}, [])

const errorResponse: JsonSchema = strictObject({ error: { type: 'string' } })
const AUTHORIZATION_OPERATIONS = new Set([
  'addOrganizationMember',
  'createProduct',
  'listProducts',
  'getProduct',
  'updateProduct',
  'archiveProduct',
  'restoreProduct',
  'createCompetitor',
  'listCompetitors',
  'getCompetitor',
  'getAdSyncSchedule',
  'upsertAdSyncSchedule',
  'updateAdSyncSchedule',
  'disableAdSyncSchedule',
  'importManualMetaAds',
  'syncApifyMetaAds',
  'listCompetitorAds',
  'listOrganizationAds',
  'getScalingAnalytics',
  'analyzeCreative',
  'updateBrief',
  'listBriefVersions',
])
const NOT_FOUND_OPERATIONS = new Set(['getProduct', 'updateProduct', 'archiveProduct', 'restoreProduct', 'getCompetitor', 'getAdSyncSchedule', 'upsertAdSyncSchedule', 'updateAdSyncSchedule', 'disableAdSyncSchedule', 'getBrief', 'updateBrief', 'listBriefVersions', 'syncApifyMetaAds', 'getScalingAnalytics', 'analyzeCreative'])
const CONFLICT_OPERATIONS = new Set([
  'createOrganization',
  'addOrganizationMember',
  'createProduct',
  'createCompetitor',
  'upsertAdSyncSchedule',
  'importManualMetaAds',
  'syncApifyMetaAds',
  'createBriefFromAd',
  'createManualBrief',
  'updateBrief',
  'analyzeCreative',
])

function errorResponsesFor(method: ApiMethod, operationId: string): Record<number, JsonSchema> {
  const statuses = new Set([400, 401, 500])
  if (AUTHORIZATION_OPERATIONS.has(operationId)) statuses.add(403)
  if (NOT_FOUND_OPERATIONS.has(operationId)) statuses.add(404)
  if (CONFLICT_OPERATIONS.has(operationId)) statuses.add(409)
  if (operationId === 'syncApifyMetaAds' || operationId === 'analyzeCreative') {
    statuses.add(502)
    statuses.add(503)
  }
  if (operationId === 'analyzeCreative') statuses.add(429)
  if (method === 'POST' || method === 'PATCH') {
    statuses.add(413)
    statuses.add(415)
  }
  return Object.fromEntries([...statuses].sort((left, right) => left - right).map((status) => [status, errorResponse]))
}

const organization: JsonSchema = strictObject({ id: identifier, name: canonicalText(200), createdAt: timestamp })
const product: JsonSchema = strictObject({
  id: identifier,
  organizationId: identifier,
  name: canonicalText(300),
  markets: canonicalStringList(),
  platforms: { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string', enum: ['ios', 'android', 'web'] } },
  targetAudiences: canonicalStringList(),
  uniqueSellingPoints: canonicalStringList(),
  archivedAt: nullableTimestamp,
  createdAt: timestamp,
})
const competitor: JsonSchema = strictObject({
  id: identifier,
  organizationId: identifier,
  productId: identifier,
  name: canonicalText(300),
  metaPageUrl: { anyOf: [httpsUrl, { type: 'null' }] },
  archivedAt: nullableTimestamp,
  createdAt: timestamp,
})
const adSyncSchedule: JsonSchema = strictObject({
  id: identifier, organizationId: identifier, productId: identifier, competitorId: identifier,
  providerName: { type: 'string', enum: ['apify-meta-ads'] }, actorUserId: identifier,
  enabled: { type: 'boolean' }, intervalSeconds: { type: 'integer', minimum: 60, maximum: 604800 },
  nextRunAt: timestamp, lastRunAt: nullableTimestamp,
})
const adSyncScheduleBody: JsonSchema = strictObject({
  intervalSeconds: { type: 'integer', minimum: 60, maximum: 604800 }, enabled: { type: 'boolean' },
})
const adSyncSchedulePatchBody: JsonSchema = {
  ...strictObject({ intervalSeconds: { type: 'integer', minimum: 60, maximum: 604800 }, enabled: { type: 'boolean' } }, []),
  minProperties: 1,
}
const adMedia: JsonSchema = strictObject({
  kind: { type: 'string', enum: ['image', 'video'] }, sourceUrl: httpsUrl, posterUrl: { anyOf: [httpsUrl, { type: 'null' }] },
  cardIndex: { anyOf: [{ type: 'integer', minimum: 0, maximum: 49 }, { type: 'null' }] }, order: { type: 'integer', minimum: 0, maximum: 49 },
})
const nullableNonNegativeNumber: JsonSchema = { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] }
const ad: JsonSchema = strictObject({
  id: identifier,
  organizationId: identifier,
  productId: identifier,
  competitorId: identifier,
  providerName: { type: 'string', maxLength: 64, pattern: '^[a-z0-9][a-z0-9-]{0,63}$' },
  platform: { type: 'string', enum: ['meta'] },
  externalId: identifier,
  pageId: { anyOf: [canonicalText(256), { type: 'null' }] },
  advertiserName: canonicalText(500),
  body: canonicalText(AD_BODY_MAX_LENGTH, true),
  headline: { anyOf: [canonicalText(500), { type: 'null' }] },
  description: { anyOf: [canonicalText(2_000), { type: 'null' }] },
  callToAction: { anyOf: [canonicalText(100), { type: 'null' }] },
  displayFormat: { anyOf: [canonicalText(100), { type: 'null' }] },
  adType: { anyOf: [{ type: 'string', enum: ['image', 'video', 'carousel', 'text'] }, { type: 'null' }] },
  startedAt: timestamp,
  endedAt: nullableTimestamp,
  isActive: { type: 'boolean' },
  publisherPlatforms: { anyOf: [canonicalStringList(20, 100), { type: 'null' }] },
  impressionsLowerBound: nullableNonNegativeNumber,
  impressionsUpperBound: nullableNonNegativeNumber,
  spendLowerBound: nullableNonNegativeNumber,
  spendUpperBound: nullableNonNegativeNumber,
  currency: { anyOf: [{ type: 'string', pattern: '^[A-Z]{3}$' }, { type: 'null' }] },
  media: { anyOf: [{ type: 'array', maxItems: 50, items: adMedia }, { type: 'null' }] },
  mediaUrls: { type: 'array', maxItems: 50, uniqueItems: true, items: httpsUrl },
  sourceUrl: httpsUrl,
  firstSeenAt: timestamp,
  lastSeenAt: timestamp,
})
const dimensions: JsonSchema = strictObject({
  audience: canonicalText(100),
  market: canonicalText(100),
  angle: canonicalText(100),
  format: canonicalText(100),
})
const briefStatus: JsonSchema = { type: 'string', enum: ['draft', 'triage', 'approved', 'production', 'review', 'completed', 'archived'] }
const briefProperties: Record<string, JsonSchema> = {
  id: identifier,
  organizationId: identifier,
  productId: identifier,
  title: canonicalText(500),
  status: briefStatus,
  sourceAdId: { anyOf: [identifier, { type: 'null' }] },
  hook: canonicalText(20_000, true),
  callToAction: { anyOf: [canonicalText(100), { type: 'null' }] },
  dimensions,
  version: { type: 'integer', minimum: 1 },
  createdAt: timestamp,
  updatedAt: timestamp,
}
const brief: JsonSchema = strictObject(briefProperties)
const briefVersion: JsonSchema = strictObject({ ...briefProperties, changedBy: identifier, changedAt: timestamp })
const page = (item: JsonSchema): JsonSchema => strictObject({
  items: { type: 'array', maxItems: 100, items: item },
  nextCursor: { anyOf: [{ type: 'string', minLength: 1, maxLength: MAX_CURSOR_LENGTH }, { type: 'null' }] },
})
const iterationCell: JsonSchema = strictObject({
  dimensions,
  briefIds: { type: 'array', maxItems: 10_000, items: identifier },
})
const iterationMap: JsonSchema = strictObject({
  totalCombinations: { type: 'integer', minimum: 1, maximum: 10_000 },
  covered: { type: 'array', maxItems: 10_000, items: iterationCell },
  missing: { type: 'array', maxItems: 10_000, items: iterationCell },
})
const scaleFormatMix = strictObject({ image: { type: 'integer', minimum: 0 }, video: { type: 'integer', minimum: 0 }, carousel: { type: 'integer', minimum: 0 }, text: { type: 'integer', minimum: 0 } })
const scaleAnalytics = strictObject({
  label: canonicalText(200), generatedAt: timestamp,
  items: { type: 'array', maxItems: 10_000, items: strictObject({
    competitorId: identifier, competitorName: canonicalText(300), activeAdCount: { type: 'integer', minimum: 0 },
    newAdsLast7d: { type: 'integer', minimum: 0 }, newAdsPrev7d: { type: 'integer', minimum: 0 },
    launchVelocityDelta: { type: 'integer' }, avgDaysActive: { type: 'number', minimum: 0 },
    longRunnerCount: { type: 'integer', minimum: 0 }, formatMix: scaleFormatMix,
    impressionWeight: { type: 'number', minimum: 0 }, scaleScore: { type: 'integer', minimum: 0, maximum: 100 }, newlyTracked: { type: 'boolean' },
  }, ['competitorId', 'competitorName', 'activeAdCount', 'newAdsLast7d', 'newAdsPrev7d', 'launchVelocityDelta', 'avgDaysActive', 'longRunnerCount', 'formatMix', 'scaleScore', 'newlyTracked']) },
})
const creativeTags = strictObject({
  hookCategory: { type: 'string', enum: [...HOOK_CATEGORIES] }, angle: { type: 'string', enum: [...CREATIVE_ANGLES] }, emotion: canonicalText(40), persona: canonicalText(120),
  format: { type: 'string', enum: [...CREATIVE_FORMATS] }, offerFrame: { type: 'string', enum: [...OFFER_FRAMES] }, cta: canonicalText(120), onScreenText: canonicalText(600),
  visualSummary: canonicalText(600), funnelStage: { type: 'string', enum: ['awareness', 'consideration', 'conversion', 'retention'] }, confidence: { type: 'number', minimum: 0, maximum: 1 },
}, ['hookCategory', 'angle', 'emotion', 'persona', 'format', 'offerFrame', 'cta', 'visualSummary', 'funnelStage', 'confidence'])
const creativeAnalysis = strictObject({
  organizationId: identifier, productId: identifier, competitorAdId: identifier, analysisVersion: canonicalText(128),
  modelProvider: canonicalText(64), modelName: canonicalText(200), promptVersion: canonicalText(128),
  inputFingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' }, tags: creativeTags, analyzedAt: timestamp,
})

function route(
  method: ApiMethod,
  fastifyPath: string,
  openapiPath: string,
  operationId: string,
  summary: string,
  tag: string,
  request: Pick<ApiRouteSchema, 'params' | 'querystring' | 'body'>,
  successStatus: number,
  successSchema: JsonSchema,
): ApiContract {
  return {
    method,
    fastifyPath,
    openapiPath,
    operationId,
    schema: {
      operationId,
      summary,
      tags: [tag],
      security: [{ bearerAuth: [] }],
      ...request,
      response: { ...errorResponsesFor(method, operationId), [successStatus]: successSchema },
    },
  }
}

const emptyResponse: JsonSchema = { type: 'null' }
const normalizedDimensions = strictObject({
  audience: normalizedText(100),
  market: normalizedText(100),
  angle: normalizedText(100),
  format: normalizedText(100),
})
const productBody = strictObject({
  name: normalizedText(300),
  markets: normalizedStringList(100, 500),
  platforms: { type: 'array', maxItems: 100, items: { type: 'string', enum: ['ios', 'android', 'web'] } },
  targetAudiences: normalizedStringList(100, 500),
  uniqueSellingPoints: normalizedStringList(100, 500),
})
const productPatchBody: JsonSchema = {
  ...productBody,
  required: [],
  minProperties: 1,
}
const manualAdRecord: JsonSchema = {
  ...strictObject({
    externalId: normalizedText(256),
    advertiserName: normalizedText(500),
    body: normalizedText(AD_BODY_MAX_LENGTH, true),
    callToAction: normalizedText(100),
    startedAt: parseableDate,
    isActive: { type: 'boolean' },
    mediaUrls: { type: 'array', maxItems: 50, uniqueItems: true, items: httpsUrl },
    sourceUrl: httpsUrl,
  }, ['externalId', 'advertiserName', 'body', 'startedAt', 'isActive', 'mediaUrls', 'sourceUrl']),
  anyOf: [
    { properties: { body: normalizedText(AD_BODY_MAX_LENGTH) }, required: ['body'] },
    { properties: { mediaUrls: { type: 'array', minItems: 1 } }, required: ['mediaUrls'] },
  ],
}
const axes: JsonSchema = {
  ...strictObject({
    audience: normalizedStringList(50, 100, 1),
    market: normalizedStringList(50, 100, 1),
    angle: normalizedStringList(50, 100, 1),
    format: normalizedStringList(50, 100, 1),
  }),
  'x-maxCartesianProduct': 10_000,
  description: 'The product of the four normalized, de-duplicated axis lengths must not exceed 10,000.',
}

export const AUTH_CONTRACTS: readonly ApiContract[] = [
  {
    method: 'POST', fastifyPath: '/auth/staging-login', openapiPath: '/auth/staging-login', operationId: 'stagingPasswordLogin',
    schema: {
      operationId: 'stagingPasswordLogin', summary: 'Exchange the staging password for a short-lived bearer token', tags: ['Authentication'], security: [],
      querystring: noQuery,
      body: strictObject({ password: { type: 'string', minLength: 1, maxLength: 1_024 } }),
      response: {
        200: strictObject({
          accessToken: { type: 'string', minLength: 1, maxLength: 8_192 },
          organizationId: identifier,
        }),
        400: errorResponse, 401: errorResponse, 404: errorResponse, 413: errorResponse, 415: errorResponse, 429: errorResponse, 500: errorResponse,
      },
    },
  },
]

export const API_CONTRACTS: readonly ApiContract[] = [
  route('POST', '/organizations', '/organizations', 'createOrganization', 'Create an organization', 'Organizations', { querystring: noQuery, body: strictObject({ name: normalizedText(200) }) }, 201, organization),
  route('POST', '/organizations/:organizationId/members', '/organizations/{organizationId}/members', 'addOrganizationMember', 'Add or update an organization member', 'Organizations', { params: params('organizationId'), querystring: noQuery, body: strictObject({ userId: normalizedText(256), role: { type: 'string', enum: ['admin', 'member'] } }) }, 204, emptyResponse),
  route('POST', '/organizations/:organizationId/products', '/organizations/{organizationId}/products', 'createProduct', 'Create a product', 'Products', { params: params('organizationId'), querystring: noQuery, body: productBody }, 201, product),
  route('GET', '/organizations/:organizationId/products', '/organizations/{organizationId}/products', 'listProducts', 'List products', 'Products', { params: params('organizationId'), querystring: paginationQuery() }, 200, page(product)),
  route('GET', '/organizations/:organizationId/products/:productId', '/organizations/{organizationId}/products/{productId}', 'getProduct', 'Get a product', 'Products', { params: params('organizationId', 'productId'), querystring: detailQuery }, 200, product),
  route('PATCH', '/organizations/:organizationId/products/:productId', '/organizations/{organizationId}/products/{productId}', 'updateProduct', 'Update product fields', 'Products', { params: params('organizationId', 'productId'), querystring: noQuery, body: productPatchBody }, 200, product),
  route('POST', '/organizations/:organizationId/products/:productId/archive', '/organizations/{organizationId}/products/{productId}/archive', 'archiveProduct', 'Archive a product without deleting its history', 'Products', { params: params('organizationId', 'productId'), querystring: noQuery }, 200, product),
  route('POST', '/organizations/:organizationId/products/:productId/restore', '/organizations/{organizationId}/products/{productId}/restore', 'restoreProduct', 'Restore an archived product', 'Products', { params: params('organizationId', 'productId'), querystring: noQuery }, 200, product),
  route('POST', '/organizations/:organizationId/products/:productId/competitors', '/organizations/{organizationId}/products/{productId}/competitors', 'createCompetitor', 'Create a competitor', 'Competitors', { params: params('organizationId', 'productId'), querystring: noQuery, body: strictObject({ name: normalizedText(300), metaPageUrl: { anyOf: [httpsUrl, { type: 'null' }] } }, ['name']) }, 201, competitor),
  route('GET', '/organizations/:organizationId/products/:productId/competitors', '/organizations/{organizationId}/products/{productId}/competitors', 'listCompetitors', 'List competitors', 'Competitors', { params: params('organizationId', 'productId'), querystring: paginationQuery() }, 200, page(competitor)),
  route('GET', '/organizations/:organizationId/products/:productId/competitors/:competitorId', '/organizations/{organizationId}/products/{productId}/competitors/{competitorId}', 'getCompetitor', 'Get a competitor', 'Competitors', { params: params('organizationId', 'productId', 'competitorId'), querystring: detailQuery }, 200, competitor),
  route('GET', '/organizations/:organizationId/products/:productId/competitors/:competitorId/ad-sync-schedule', '/organizations/{organizationId}/products/{productId}/competitors/{competitorId}/ad-sync-schedule', 'getAdSyncSchedule', 'Inspect the competitor ad synchronization schedule', 'Ads', { params: params('organizationId', 'productId', 'competitorId'), querystring: noQuery }, 200, adSyncSchedule),
  route('POST', '/organizations/:organizationId/products/:productId/competitors/:competitorId/ad-sync-schedule', '/organizations/{organizationId}/products/{productId}/competitors/{competitorId}/ad-sync-schedule', 'upsertAdSyncSchedule', 'Create or replace the competitor ad synchronization schedule', 'Ads', { params: params('organizationId', 'productId', 'competitorId'), querystring: noQuery, body: adSyncScheduleBody }, 200, adSyncSchedule),
  route('PATCH', '/organizations/:organizationId/products/:productId/competitors/:competitorId/ad-sync-schedule', '/organizations/{organizationId}/products/{productId}/competitors/{competitorId}/ad-sync-schedule', 'updateAdSyncSchedule', 'Partially update the competitor ad synchronization schedule', 'Ads', { params: params('organizationId', 'productId', 'competitorId'), querystring: noQuery, body: adSyncSchedulePatchBody }, 200, adSyncSchedule),
  route('POST', '/organizations/:organizationId/products/:productId/competitors/:competitorId/ad-sync-schedule/disable', '/organizations/{organizationId}/products/{productId}/competitors/{competitorId}/ad-sync-schedule/disable', 'disableAdSyncSchedule', 'Disable and fence competitor ad synchronization work', 'Ads', { params: params('organizationId', 'productId', 'competitorId'), querystring: noQuery }, 200, adSyncSchedule),
  route('POST', '/organizations/:organizationId/products/:productId/competitors/:competitorId/ads/manual-meta', '/organizations/{organizationId}/products/{productId}/competitors/{competitorId}/ads/manual-meta', 'importManualMetaAds', 'Import Meta ads manually', 'Ads', { params: params('organizationId', 'productId', 'competitorId'), querystring: noQuery, body: strictObject({ records: { type: 'array', minItems: 1, maxItems: 1_000, items: manualAdRecord } }) }, 200, strictObject({ inserted: { type: 'integer', minimum: 0 }, duplicates: { type: 'integer', minimum: 0 } })),
  route('POST', '/organizations/:organizationId/products/:productId/competitors/:competitorId/ads/apify-meta/sync', '/organizations/{organizationId}/products/{productId}/competitors/{competitorId}/ads/apify-meta/sync', 'syncApifyMetaAds', 'Synchronize Meta ads through Apify', 'Ads', { params: params('organizationId', 'productId', 'competitorId'), querystring: noQuery }, 200, strictObject({ inserted: { type: 'integer', minimum: 0 }, duplicates: { type: 'integer', minimum: 0 } })),
  route('GET', '/organizations/:organizationId/competitors/:competitorId/ads', '/organizations/{organizationId}/competitors/{competitorId}/ads', 'listCompetitorAds', 'List ads for a competitor', 'Ads', { params: params('organizationId', 'competitorId'), querystring: paginationQuery() }, 200, page(ad)),
  route('GET', '/organizations/:organizationId/ads', '/organizations/{organizationId}/ads', 'listOrganizationAds', 'List and filter organization ads', 'Ads', { params: params('organizationId'), querystring: paginationQuery({ productId: identifier, competitorId: identifier, isActive: { type: 'string', enum: ['true', 'false'] }, provider: { type: 'string', maxLength: 64, pattern: '^[a-z0-9][a-z0-9-]{0,63}$' } }, false) }, 200, page(ad)),
  route('GET', '/organizations/:organizationId/products/:productId/analytics/scaling', '/organizations/{organizationId}/products/{productId}/analytics/scaling', 'getScalingAnalytics', 'Rank competitor momentum from public library signals', 'Analytics', { params: params('organizationId', 'productId'), querystring: noQuery }, 200, scaleAnalytics),
  route('POST', '/organizations/:organizationId/products/:productId/ads/:adId/creative-analysis', '/organizations/{organizationId}/products/{productId}/ads/{adId}/creative-analysis', 'analyzeCreative', 'Analyze a creative with the configured AI provider', 'Creative Analysis', { params: params('organizationId', 'productId', 'adId'), querystring: noQuery }, 200, creativeAnalysis),
  route('POST', '/organizations/:organizationId/products/:productId/briefs/from-ad', '/organizations/{organizationId}/products/{productId}/briefs/from-ad', 'createBriefFromAd', 'Create a brief from an ad', 'Briefs', { params: params('organizationId', 'productId'), querystring: noQuery, body: strictObject({ adId: identifier, title: normalizedText(500), dimensions: normalizedDimensions }) }, 201, brief),
  route('POST', '/organizations/:organizationId/products/:productId/briefs', '/organizations/{organizationId}/products/{productId}/briefs', 'createManualBrief', 'Create a manual brief', 'Briefs', { params: params('organizationId', 'productId'), querystring: noQuery, body: strictObject({ title: normalizedText(500), hook: normalizedText(20_000, true), callToAction: normalizedText(100), dimensions: normalizedDimensions }, ['title', 'hook', 'dimensions']) }, 201, brief),
  route('GET', '/organizations/:organizationId/products/:productId/briefs', '/organizations/{organizationId}/products/{productId}/briefs', 'listBriefs', 'List briefs for a product', 'Briefs', { params: params('organizationId', 'productId'), querystring: paginationQuery() }, 200, page(brief)),
  route('GET', '/organizations/:organizationId/briefs/:briefId', '/organizations/{organizationId}/briefs/{briefId}', 'getBrief', 'Get a brief', 'Briefs', { params: params('organizationId', 'briefId'), querystring: detailQuery }, 200, brief),
  route('PATCH', '/organizations/:organizationId/briefs/:briefId', '/organizations/{organizationId}/briefs/{briefId}', 'updateBrief', 'Update a brief with optimistic concurrency', 'Briefs', { params: params('organizationId', 'briefId'), querystring: noQuery, body: strictObject({ expectedVersion: { type: 'integer', minimum: 1 }, title: normalizedText(500), status: briefStatus, hook: normalizedText(20_000, true), callToAction: { anyOf: [normalizedText(100), { type: 'null' }] }, dimensions: normalizedDimensions }) }, 200, brief),
  route('GET', '/organizations/:organizationId/briefs/:briefId/versions', '/organizations/{organizationId}/briefs/{briefId}/versions', 'listBriefVersions', 'List immutable brief versions', 'Briefs', { params: params('organizationId', 'briefId'), querystring: strictObject({ limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' } }, []) }, 200, strictObject({ items: { type: 'array', maxItems: 100, items: briefVersion } })),
  route('POST', '/organizations/:organizationId/products/:productId/iteration-map/analyze', '/organizations/{organizationId}/products/{productId}/iteration-map/analyze', 'analyzeIterationMap', 'Analyze Iteration Map coverage', 'Iteration Map', { params: params('organizationId', 'productId'), querystring: noQuery, body: strictObject({ axes }) }, 200, iterationMap),
]

export const OPERATIONAL_CONTRACTS: readonly ApiContract[] = [
  {
    method: 'GET', fastifyPath: '/health/live', openapiPath: '/health/live', operationId: 'getLiveness',
    schema: {
      operationId: 'getLiveness', summary: 'Check process liveness', tags: ['Operations'], security: [],
      querystring: noQuery,
      response: { 200: strictObject({ status: { type: 'string', enum: ['ok'] } }), 400: errorResponse },
    },
  },
  {
    method: 'GET', fastifyPath: '/health/ready', openapiPath: '/health/ready', operationId: 'getReadiness',
    schema: {
      operationId: 'getReadiness', summary: 'Check database readiness', tags: ['Operations'], security: [],
      querystring: noQuery,
      response: {
        200: strictObject({ status: { type: 'string', enum: ['ready'] } }),
        400: errorResponse,
        503: strictObject({ status: { type: 'string', enum: ['not_ready'] } }),
      },
    },
  },
]

const ALL_CONTRACTS = [...AUTH_CONTRACTS, ...API_CONTRACTS, ...OPERATIONAL_CONTRACTS]
const contractByOperationId = new Map(ALL_CONTRACTS.map((contract) => [contract.operationId, contract]))
if (contractByOperationId.size !== ALL_CONTRACTS.length) throw new Error('API operation IDs must be unique')

export function schemaFor(operationId: string): ApiRouteSchema {
  const contract = contractByOperationId.get(operationId)
  if (!contract) throw new Error('Unknown API operation')
  return contract.schema
}

export interface OpenApiDocument {
  openapi: '3.1.0'
  info: { title: string, version: string, description: string }
  paths: Record<string, Record<string, Record<string, unknown>>>
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } }
}

export function generateOpenApiDocument(): OpenApiDocument {
  const paths: OpenApiDocument['paths'] = {}
  for (const contract of ALL_CONTRACTS) {
    const operation: Record<string, unknown> = {
      operationId: contract.operationId,
      summary: contract.schema.summary,
      tags: contract.schema.tags,
      security: contract.schema.security,
      parameters: [
        ...parametersFromObjectSchema(contract.schema.params, 'path'),
        ...parametersFromObjectSchema(contract.schema.querystring, 'query'),
      ],
      responses: Object.fromEntries(Object.entries(contract.schema.response).map(([status, schema]) => [status, {
        description: responseDescription(Number(status)),
        ...(Number(status) === 204 ? {} : { content: { 'application/json': { schema } } }),
      }])),
    }
    if (contract.schema.body) {
      operation.requestBody = { required: true, content: { 'application/json': { schema: contract.schema.body } } }
    }
    const pathItem = paths[contract.openapiPath] ?? {}
    pathItem[contract.method.toLowerCase()] = operation
    paths[contract.openapiPath] = pathItem
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Creative Intelligence API',
      version: '0.1.0',
      description: 'Tenant-safe API for products, competitors, ad intelligence, creative briefs, and iteration planning.',
    },
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    },
  }
}

function parametersFromObjectSchema(schema: JsonSchema | undefined, location: 'path' | 'query'): Array<Record<string, unknown>> {
  if (!schema) return []
  const properties = schema.properties
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return []
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === 'string') : [])
  return Object.entries(properties as Record<string, JsonSchema>).map(([name, propertySchema]) => ({
    name,
    in: location,
    required: location === 'path' || required.has(name),
    schema: openApiParameterSchema(name, location, propertySchema),
  }))
}

function openApiParameterSchema(name: string, location: 'path' | 'query', wireSchema: JsonSchema): JsonSchema {
  if (location !== 'query') return wireSchema
  if (name === 'limit') return { type: 'integer', minimum: 1, maximum: 100, default: 50 }
  if (name === 'includeArchived') return { type: 'boolean', default: false }
  if (name === 'isActive') return { type: 'boolean' }
  return wireSchema
}

function responseDescription(status: number): string {
  if (status >= 200 && status < 300) return status === 204 ? 'No content' : 'Successful response'
  if (status === 400) return 'Invalid request'
  if (status === 401) return 'Authentication required'
  if (status === 403) return 'Access denied'
  if (status === 404) return 'Not found'
  if (status === 409) return 'Resource conflict'
  if (status === 413) return 'Payload too large'
  if (status === 415) return 'Unsupported media type'
  if (status === 429) return 'Too many requests'
  if (status === 502) return 'External provider unavailable'
  if (status === 503) return 'Service unavailable'
  return 'Internal server error'
}
